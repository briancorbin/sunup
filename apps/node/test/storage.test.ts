import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate";
import { SqliteStorage } from "../src/storage";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

function freshStorage(): SqliteStorage {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS);
  return new SqliteStorage(db);
}

const standupInput = {
  name: "Test Standup",
  channelId: "C1",
  kind: "sunup" as const,
  questions: ["Yesterday?", "Today?", "Blockers?"],
  scheduleDays: [1, 2, 3, 4, 5],
  promptTime: "09:00",
  digestTime: "11:30",
  timezone: "America/New_York",
  userTzPrompts: true,
  reminderMinutes: 60,
  includeMood: true,
  createdBy: null as string | null,
};

describe("SqliteStorage (shared migrations)", () => {
  let storage: SqliteStorage;
  beforeEach(() => {
    storage = freshStorage();
  });

  it("applies all migrations and round-trips a standup", async () => {
    const created = await storage.createStandup(standupInput);
    expect(created.id).toBe(1);
    expect(created.kind).toBe("sunup");
    expect(created.lastRetroDate).toBeNull();
    expect(await storage.getStandupByChannel("C1", "sunup")).toMatchObject({ name: "Test Standup" });
    expect(await storage.getStandupByChannel("C1", "sundown")).toBeNull();

    // Same channel, different kind — allowed post-0005.
    const checkout = await storage.createStandup({ ...standupInput, kind: "sundown", name: "Checkout" });
    expect(checkout.id).toBe(2);
    // Same channel, same kind — blocked.
    await expect(storage.createStandup(standupInput)).rejects.toThrow(/UNIQUE/);
  });

  it("handles participants, snooze, runs, responses, and history", async () => {
    const s = await storage.createStandup(standupInput);
    await storage.addParticipant(s.id, "U1", "America/New_York");
    await storage.addParticipant(s.id, "U2", null);
    await storage.setSnooze(s.id, "U2", "2026-07-25");
    const participants = await storage.listParticipants(s.id);
    expect(participants).toHaveLength(2);
    expect(participants.find((p) => p.userId === "U2")?.snoozedUntil).toBe("2026-07-25");

    const run = await storage.getOrCreateRun(s.id, "2026-07-20");
    expect((await storage.getOrCreateRun(s.id, "2026-07-20")).id).toBe(run.id); // idempotent
    await storage.markPrompted(run.id, "U1", "t1");
    await storage.markReminded(run.id, "U1", "t2");
    expect((await storage.listRunParticipants(run.id))[0]).toMatchObject({ promptedAt: "t1", remindedAt: "t2" });

    await storage.upsertResponse({ runId: run.id, userId: "U1", answers: ["a", "b", "none"], mood: 4, submittedAt: "t3" });
    await storage.upsertResponse({ runId: run.id, userId: "U1", answers: ["a2", "b2", "none"], mood: 5, submittedAt: "t4" });
    const responses = await storage.listResponses(run.id);
    expect(responses).toHaveLength(1); // upsert, not duplicate
    expect(responses[0]?.answers[0]).toBe("a2");

    await storage.markDigestPosted(run.id, "t5", "111.222");
    expect((await storage.getRunById(run.id))?.digestTs).toBe("111.222");

    const history = await storage.listUserRunHistory(s.id, "U1", 10);
    expect(history).toEqual([{ runDate: "2026-07-20", responded: true }]);
    expect((await storage.listRecentRuns(s.id, 5))[0]).toMatchObject({ responseCount: 1 });
    expect((await storage.listRecentResponses(s.id, 5))[0]?.runDate).toBe("2026-07-20");
  });

  it("runs the blocker lifecycle", async () => {
    const s = await storage.createStandup(standupInput);
    const opened = await storage.openBlocker(s.id, "U1", "waiting on infra", "2026-07-20");
    expect(await storage.getOpenBlocker(s.id, "U1")).toMatchObject({ id: opened.id });
    await storage.confirmBlocker(opened.id, "2026-07-21", "still waiting on infra");
    expect((await storage.getBlockerById(opened.id))?.lastConfirmedDate).toBe("2026-07-21");
    await storage.resolveBlocker(opened.id, "2026-07-22T10:00:00Z");
    expect(await storage.getOpenBlocker(s.id, "U1")).toBeNull();
    expect(await storage.listResolvedBlockers(s.id, 5)).toHaveLength(1);
  });

  it("kudos leaderboard and retention purge", async () => {
    const s = await storage.createStandup(standupInput);
    await storage.addKudos({ fromUser: "U1", toUser: "U2", message: "nice", channelId: "C1", createdAt: "2026-07-01T00:00:00Z" });
    await storage.addKudos({ fromUser: "U1", toUser: "U2", message: "again", channelId: "C1", createdAt: "2026-07-19T00:00:00Z" });
    expect(await storage.kudosLeaderboard("2026-07-10T00:00:00Z", 5)).toEqual([{ userId: "U2", count: 1 }]);

    await storage.getOrCreateRun(s.id, "2026-06-01");
    await storage.getOrCreateRun(s.id, "2026-07-20");
    await storage.purgeOlderThan(30, "2026-07-21T00:00:00Z");
    const runs = await storage.listRecentRuns(s.id, 10);
    expect(runs.map((r) => r.runDate)).toEqual(["2026-07-20"]);
  });

  it("cascades children when a standup is deleted", async () => {
    const s = await storage.createStandup(standupInput);
    await storage.addParticipant(s.id, "U1", null);
    const run = await storage.getOrCreateRun(s.id, "2026-07-20");
    await storage.upsertResponse({ runId: run.id, userId: "U1", answers: ["a"], mood: null, submittedAt: "t" });
    await storage.deleteStandup(s.id);
    expect(await storage.listParticipants(s.id)).toHaveLength(0);
    expect(await storage.getRunById(run.id)).toBeNull();
  });

  it("round-trips createdBy and keeps it across updateStandup", async () => {
    const owned = await storage.createStandup({ ...standupInput, createdBy: "U1" });
    expect(owned.createdBy).toBe("U1");
    expect((await storage.getStandup(owned.id))?.createdBy).toBe("U1");
    await storage.updateStandup({ ...owned, name: "Renamed", createdBy: "U9" });
    expect(await storage.getStandup(owned.id)).toMatchObject({ name: "Renamed", createdBy: "U1" });
    const legacy = await storage.createStandup({ ...standupInput, channelId: "C2", createdBy: null });
    expect(legacy.createdBy).toBeNull();
  });

  it("round-trips a participant's last prompt date", async () => {
    const s = await storage.createStandup(standupInput);
    await storage.addParticipant(s.id, "U1", null);
    expect((await storage.listParticipants(s.id))[0]?.lastPromptDate).toBeNull();
    await storage.setParticipantPromptDate(s.id, "U1", "2026-07-20");
    expect((await storage.listParticipants(s.id))[0]?.lastPromptDate).toBe("2026-07-20");
  });

  it("claims a digest exactly once, and a claim can be released", async () => {
    const s = await storage.createStandup(standupInput);
    const run = await storage.getOrCreateRun(s.id, "2026-07-20");
    expect(await storage.claimDigest(run.id, "2026-07-20T15:00:00Z")).toBe(true);
    expect(await storage.claimDigest(run.id, "2026-07-20T15:00:01Z")).toBe(false);
    expect((await storage.getRunById(run.id))?.digestPostedAt).toBe("2026-07-20T15:00:00Z");
    await storage.releaseDigestClaim(run.id);
    expect((await storage.getRunById(run.id))?.digestPostedAt).toBeNull();
    expect(await storage.claimDigest(run.id, "2026-07-20T15:05:00Z")).toBe(true);
    await storage.markDigestPosted(run.id, "2026-07-20T15:05:01Z", "123.456");
    expect(await storage.getRunById(run.id)).toMatchObject({ digestPostedAt: "2026-07-20T15:05:01Z", digestTs: "123.456" });
    // A claim that already has a message ts must not be released.
    await storage.releaseDigestClaim(run.id);
    expect(await storage.getRunById(run.id)).toMatchObject({ digestTs: "123.456" });
  });

  it("filters the kudos leaderboard by channel", async () => {
    const k = (to: string, ch: string) => ({ fromUser: "U9", toUser: to, message: "m", channelId: ch, createdAt: "2026-07-19T00:00:00Z" });
    await storage.addKudos(k("U1", "C1"));
    await storage.addKudos(k("U1", "C1"));
    await storage.addKudos(k("U2", "C2"));
    await storage.addKudos(k("U2", "C2"));
    await storage.addKudos(k("U2", "C2"));
    expect(await storage.kudosLeaderboard("2026-07-01T00:00:00Z", 10)).toEqual([
      { userId: "U2", count: 3 },
      { userId: "U1", count: 2 },
    ]);
    expect(await storage.kudosLeaderboard("2026-07-01T00:00:00Z", 10, "C1")).toEqual([{ userId: "U1", count: 2 }]);
  });

  it("purges old resolved blockers but never open ones", async () => {
    const s = await storage.createStandup(standupInput);
    const oldResolved = await storage.openBlocker(s.id, "U1", "old resolved", "2026-01-01");
    await storage.resolveBlocker(oldResolved.id, "2026-01-05T00:00:00Z");
    const oldOpen = await storage.openBlocker(s.id, "U2", "old open", "2026-01-01");
    const recentResolved = await storage.openBlocker(s.id, "U3", "recent resolved", "2026-07-01");
    await storage.resolveBlocker(recentResolved.id, "2026-07-15T00:00:00Z");
    await storage.purgeOlderThan(30, "2026-07-21T00:00:00Z");
    expect(await storage.getBlockerById(oldResolved.id)).toBeNull();
    expect(await storage.getBlockerById(oldOpen.id)).not.toBeNull();
    expect(await storage.getBlockerById(recentResolved.id)).not.toBeNull();
  });
});
