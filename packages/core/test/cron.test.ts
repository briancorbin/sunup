import { describe, expect, it } from "vitest";
import {
  SlackApiError,
  advancePastDigested,
  canManage,
  computeStreak,
  handleConfig,
  handleRemove,
  localParts,
  nextScheduledDate,
  resolveCheckinRunDate,
  runCron,
  type Deps,
  type Participant,
  type Standup,
} from "../src/index";
import { FakeSlack, MemoryStorage, simulate, type SentMessage } from "./fakes";

const MIN = 60_000;

function makeDeps(): { deps: Deps; storage: MemoryStorage; slack: FakeSlack } {
  const storage = new MemoryStorage();
  const slack = new FakeSlack();
  return { deps: { storage, slack }, storage, slack };
}

async function makeStandup(storage: MemoryStorage, timezone: string, overrides: Partial<Standup> = {}): Promise<Standup> {
  return storage.createStandup({
    name: "Daily Check-in",
    channelId: "C_TEAM",
    kind: "sunup",
    questions: ["Yesterday?", "Today?", "Blockers?"],
    scheduleDays: [1, 2, 3, 4, 5],
    promptTime: "09:00",
    digestTime: "11:30",
    timezone,
    userTzPrompts: true,
    reminderMinutes: 60,
    includeMood: true,
    createdBy: "U_OWNER",
    ...overrides,
  });
}

const isPrompt = (m: SentMessage) => m.text.includes("Good morning");
const isReminder = (m: SentMessage) => m.text.includes("Friendly nudge");
const isDigest = (m: SentMessage) => m.text.includes("digest for");
const runIdOf = (m: SentMessage): number => {
  const actions = (m.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>).find((b) => b.type === "actions");
  return Number(actions?.elements?.[0]?.value);
};
/** Local wall-clock minutes of each message in `tz`. */
const localMinutes = (ms: SentMessage[], tz: string) => ms.map((m) => localParts(m.at, tz).minutes);
const localDates = (ms: SentMessage[], tz: string) => ms.map((m) => localParts(m.at, tz).date);

/** Drive runCron every 10 minutes between two instants; optionally auto-answer prompts for some users. */
async function runWeek(
  deps: Deps,
  storage: MemoryStorage,
  slack: FakeSlack,
  start: string,
  end: string,
  autoRespond: string[] = [],
): Promise<void> {
  let seen = 0;
  await simulate({ storage, slack }, new Date(start), new Date(end), 10, async (now) => {
    await runCron(deps, now);
    // Anyone in autoRespond answers their prompt a minute after it lands.
    for (const m of slack.messages.slice(seen)) {
      const user = m.channel.replace(/^D_/, "");
      if (m.channel.startsWith("D_") && isPrompt(m) && autoRespond.includes(user)) {
        await storage.upsertResponse({
          runId: runIdOf(m),
          userId: user,
          answers: ["did things", "doing things", "none"],
          mood: 4,
          submittedAt: new Date(now.getTime() + MIN).toISOString(),
        });
      }
    }
    seen = slack.messages.length;
  });
}

describe("cross-timezone prompting", () => {
  it("Tokyo channel + LA member: LA is prompted at their own 09:00, once per weekday, for a run that hasn't digested", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "Asia/Tokyo");
    await storage.addParticipant(standup.id, "U_TYO", "Asia/Tokyo");
    await storage.addParticipant(standup.id, "U_LA", "America/Los_Angeles");

    // Sunday 2026-07-19 → Saturday 2026-07-25 (UTC); covers Mon–Fri in both zones.
    await runWeek(deps, storage, slack, "2026-07-19T00:00:00Z", "2026-07-25T23:50:00Z", ["U_TYO"]);

    const tyoPrompts = slack.dmsTo("U_TYO").filter(isPrompt);
    const laPrompts = slack.dmsTo("U_LA").filter(isPrompt);

    // Tokyo member: five weekday prompts at Tokyo 09:00–09:09.
    expect(tyoPrompts).toHaveLength(5);
    for (const m of localMinutes(tyoPrompts, "Asia/Tokyo")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);

    // LA member: five prompts, each on an LA weekday morning — never at 16:00.
    expect(laPrompts).toHaveLength(5);
    for (const m of localMinutes(laPrompts, "America/Los_Angeles")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
    expect(new Set(localDates(laPrompts, "America/Los_Angeles"))).toEqual(
      new Set(["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"]),
    );
    // …and each for a distinct run whose digest had not posted yet when the prompt went out.
    const laRunIds = laPrompts.map(runIdOf);
    expect(new Set(laRunIds).size).toBe(5);
    const digests = slack.inChannel("C_TEAM").filter(isDigest);
    for (const m of laPrompts) {
      // Every run LA was prompted for either digested AFTER the prompt or hasn't digested yet (next Monday).
      const posted = (await storage.getRunById(runIdOf(m)))!.digestPostedAt;
      if (posted) expect(new Date(posted).getTime()).toBeGreaterThan(m.at.getTime());
    }
    // LA's Monday-morning check-in lands in Tokyo's Tuesday digest (the Monday digest went out Sunday evening LA time).
    const laMonday = laPrompts.find((m) => localParts(m.at, "America/Los_Angeles").date === "2026-07-20")!;
    expect((await storage.getRunById(runIdOf(laMonday)))!.runDate).toBe("2026-07-21");

    // One digest per Tokyo weekday at 11:30–11:39, plus the Friday retro.
    expect(digests).toHaveLength(5);
    for (const m of localMinutes(digests, "Asia/Tokyo")) expect(m).toBeGreaterThanOrEqual(690), expect(m).toBeLessThan(700);
    expect(slack.inChannel("C_TEAM").filter((m) => m.text.includes("weekly retro"))).toHaveLength(1);
  });

  it("LA channel + Tokyo member: Tokyo is prompted at their own 09:00 on Tokyo's weekday and lands in that day's LA digest", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/Los_Angeles");
    await storage.addParticipant(standup.id, "U_LA", "America/Los_Angeles");
    await storage.addParticipant(standup.id, "U_TYO", "Asia/Tokyo");

    await runWeek(deps, storage, slack, "2026-07-19T00:00:00Z", "2026-07-25T23:50:00Z", ["U_TYO", "U_LA"]);

    const tyoPrompts = slack.dmsTo("U_TYO").filter(isPrompt);
    expect(tyoPrompts).toHaveLength(5);
    for (const m of localMinutes(tyoPrompts, "Asia/Tokyo")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
    // Tokyo's Monday prompt arrives on LA's Sunday afternoon, for Monday's run.
    for (const m of tyoPrompts) {
      expect((await storage.getRunById(runIdOf(m)))!.runDate).toBe(localParts(m.at, "Asia/Tokyo").date);
    }
    expect(localParts(tyoPrompts[0]!.at, "America/Los_Angeles").weekday).toBe(0);

    // Every LA digest includes the Tokyo member's answer and never lists them as waiting.
    const digests = slack.inChannel("C_TEAM").filter(isDigest);
    expect(digests).toHaveLength(5);
    for (const d of digests) {
      const json = JSON.stringify(d.blocks);
      expect(json).toContain("<@U_TYO>");
      expect(json).not.toContain("Waiting on");
    }
    // Nobody got a weekend prompt in their own timezone.
    for (const m of slack.messages.filter((x) => x.channel.startsWith("D_") && isPrompt(x))) {
      const tz = m.channel === "D_U_TYO" ? "Asia/Tokyo" : "America/Los_Angeles";
      expect([1, 2, 3, 4, 5]).toContain(localParts(m.at, tz).weekday);
    }
  });

  it("same-timezone team keeps the old behaviour: prompt 09:00, reminder 10:30, digest 11:30, late check-in stays on today's run", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York");
    await storage.addParticipant(standup.id, "U_A", "America/New_York");
    await storage.addParticipant(standup.id, "U_B", "America/New_York");

    // Monday only.
    await runWeek(deps, storage, slack, "2026-07-20T04:00:00Z", "2026-07-21T03:50:00Z", ["U_A"]);

    expect(slack.dmsTo("U_A").filter(isPrompt)).toHaveLength(1);
    expect(slack.dmsTo("U_A").filter(isReminder)).toHaveLength(0); // answered
    const bReminders = slack.dmsTo("U_B").filter(isReminder);
    expect(bReminders).toHaveLength(1);
    expect(localMinutes(bReminders, "America/New_York")[0]).toBeGreaterThanOrEqual(630);
    expect(localMinutes(bReminders, "America/New_York")[0]).toBeLessThan(640);
    expect(slack.inChannel("C_TEAM").filter(isDigest)).toHaveLength(1);
    // Nobody is prompted a second time after the digest for tomorrow's run.
    expect(slack.dmsTo("U_B").filter(isPrompt)).toHaveLength(1);
    expect(storage.runs.map((r) => r.runDate)).toEqual(["2026-07-20"]);
  });
});

describe("DST", () => {
  it("LA member of a London channel is prompted at LA 09:00 every weekday across the US spring-forward (2026-03-08)", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "Europe/London");
    await storage.addParticipant(standup.id, "U_LON", "Europe/London");
    await storage.addParticipant(standup.id, "U_LA", "America/Los_Angeles");

    // Thu 03-05 (midnight in LA, 08:00 in London) → Wed 03-11. The US/UK offset is 8h before Sunday and 7h after.
    await runWeek(deps, storage, slack, "2026-03-05T08:00:00Z", "2026-03-12T07:50:00Z", ["U_LON", "U_LA"]);

    const la = slack.dmsTo("U_LA").filter(isPrompt);
    expect(localDates(la, "America/Los_Angeles")).toEqual(["2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11"]);
    for (const m of localMinutes(la, "America/Los_Angeles")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
    const lon = slack.dmsTo("U_LON").filter(isPrompt);
    expect(localDates(lon, "Europe/London")).toEqual(["2026-03-05", "2026-03-06", "2026-03-09", "2026-03-10", "2026-03-11"]);
    for (const m of localMinutes(lon, "Europe/London")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
  });

  it("…and across the US fall-back (2026-11-01) and the UK one (2026-10-25), with prompts at local 09:00 throughout", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "Europe/London");
    await storage.addParticipant(standup.id, "U_LON", "Europe/London");
    await storage.addParticipant(standup.id, "U_LA", "America/Los_Angeles");

    // Thu 10-22 (midnight in LA, 08:00 in London) → Tue 11-03: UK falls back Sun 10-25, US Sun 11-01.
    await runWeek(deps, storage, slack, "2026-10-22T07:00:00Z", "2026-11-04T07:50:00Z", ["U_LON", "U_LA"]);

    const weekdays = ["2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-11-02", "2026-11-03"];
    const la = slack.dmsTo("U_LA").filter(isPrompt);
    expect(localDates(la, "America/Los_Angeles")).toEqual(weekdays);
    for (const m of localMinutes(la, "America/Los_Angeles")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
    const lon = slack.dmsTo("U_LON").filter(isPrompt);
    expect(localDates(lon, "Europe/London")).toEqual(weekdays);
    for (const m of localMinutes(lon, "Europe/London")) expect(m).toBeGreaterThanOrEqual(540), expect(m).toBeLessThan(550);
    // Digests: one per London weekday at 11:30 local, even on the Monday after each change.
    const digests = slack.inChannel("C_TEAM").filter(isDigest);
    expect(localDates(digests, "Europe/London")).toEqual(weekdays);
    for (const m of localMinutes(digests, "Europe/London")) expect(m).toBeGreaterThanOrEqual(690), expect(m).toBeLessThan(700);
  });
});

describe("delivery robustness", () => {
  it("retries a prompt on a transient Slack error and gives up on a permanent one", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York", { reminderMinutes: 0 });
    await storage.addParticipant(standup.id, "U_FLAKY", "America/New_York");
    await storage.addParticipant(standup.id, "U_GONE", "America/New_York");

    // First opens for both users fail: FLAKY is rate limited (retry), GONE is deactivated (permanent).
    slack.dmFailures = [
      new SlackApiError("conversations.open", "ratelimited", 429),
      new SlackApiError("conversations.open", "user_not_found"),
    ];
    await runWeek(deps, storage, slack, "2026-07-20T12:50:00Z", "2026-07-20T13:30:00Z"); // 08:50 → 09:30 NYC

    expect(slack.dmsTo("U_FLAKY").filter(isPrompt)).toHaveLength(1); // delivered on the next tick
    expect(slack.dmOpens.filter((u) => u === "U_FLAKY")).toHaveLength(2);
    expect(slack.dmsTo("U_GONE")).toHaveLength(0);
    expect(slack.dmOpens.filter((u) => u === "U_GONE")).toHaveLength(1); // not retried every tick
    const run = (await storage.getRun(standup.id, "2026-07-20"))!;
    const rps = await storage.listRunParticipants(run.id);
    expect(rps.find((rp) => rp.userId === "U_FLAKY")?.promptedAt).toBeTruthy();
    expect(rps.find((rp) => rp.userId === "U_GONE")?.promptedAt).toBeTruthy();
  });

  it("skips snoozed participants for prompts, reminders and waiting-on", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York");
    await storage.addParticipant(standup.id, "U_A", "America/New_York");
    await storage.addParticipant(standup.id, "U_PTO", "America/New_York");
    await storage.setSnooze(standup.id, "U_PTO", "2026-07-24");
    // Pretend PTO was prompted before snoozing, so only the reminder loop's own snooze check protects them.
    const run = await storage.getOrCreateRun(standup.id, "2026-07-20");
    await storage.markPrompted(run.id, "U_PTO", "earlier");

    await runWeek(deps, storage, slack, "2026-07-20T04:00:00Z", "2026-07-21T03:50:00Z", ["U_A"]);

    expect(slack.dmsTo("U_PTO")).toHaveLength(0);
    const digest = slack.inChannel("C_TEAM").find(isDigest)!;
    expect(JSON.stringify(digest.blocks)).not.toContain("Waiting on");
  });

  it("posts the digest exactly once when two ticks overlap, and folds in a submission that races the post", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York", { reminderMinutes: 0 });
    await storage.addParticipant(standup.id, "U_A", "America/New_York");
    await storage.addParticipant(standup.id, "U_B", "America/New_York");
    const run = await storage.getOrCreateRun(standup.id, "2026-07-20");
    await storage.upsertResponse({ runId: run.id, userId: "U_A", answers: ["x", "y", "none"], mood: 4, submittedAt: "t" });
    for (const u of ["U_A", "U_B"]) {
      await storage.markPrompted(run.id, u, "t");
      await storage.setParticipantPromptDate(standup.id, u, "2026-07-20");
    }
    // U_B submits while the digest is being posted.
    slack.onPost = async (channel) => {
      if (channel === "C_TEAM" && !(await storage.getResponse(run.id, "U_B"))) {
        await storage.upsertResponse({ runId: run.id, userId: "U_B", answers: ["late", "late", "none"], mood: 3, submittedAt: "t2" });
      }
    };

    const now = new Date("2026-07-20T15:35:00Z"); // 11:35 NYC
    slack.now = () => now;
    await Promise.all([runCron(deps, now), runCron(deps, now)]);

    expect(slack.inChannel("C_TEAM").filter(isDigest)).toHaveLength(1);
    expect(slack.updates).toHaveLength(1); // re-read after posting picked up U_B
    expect((await storage.getRunById(run.id))!.digestTs).toBeTruthy();
  });

  it("releases the digest claim when the post fails so the next tick retries", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York", { reminderMinutes: 0 });
    await storage.addParticipant(standup.id, "U_A", "America/New_York");
    let fail = true;
    slack.onPost = async (channel) => {
      if (channel === "C_TEAM" && fail) {
        fail = false;
        throw new SlackApiError("chat.postMessage", "internal_error", 500);
      }
    };
    const now = new Date("2026-07-20T15:35:00Z");
    await runCron(deps, now); // swallowed per-standup, logged
    expect((await storage.getRun(standup.id, "2026-07-20"))!.digestPostedAt).toBeNull();
    await runCron(deps, new Date(now.getTime() + 10 * MIN));
    expect(slack.inChannel("C_TEAM").filter(isDigest)).toHaveLength(1);
  });
});

describe("bare /sunup run resolution", () => {
  const la: Participant = { standupId: 1, userId: "U_LA", tz: "America/Los_Angeles", snoozedUntil: null, lastPromptDate: null };
  const tyo: Participant = { standupId: 1, userId: "U_TYO", tz: "Asia/Tokyo", snoozedUntil: null, lastPromptDate: null };

  it("maps a member behind the channel onto the next undigested run, but keeps same-day late check-ins", async () => {
    const { deps, storage } = makeDeps();
    const standup = await makeStandup(storage, "Asia/Tokyo");
    const mon = await storage.getOrCreateRun(standup.id, "2026-07-20");
    await storage.markDigestPosted(mon.id, "posted", "1.0");
    // LA Monday 09:00 = Tokyo Tuesday 01:00 → Monday's digest is out → Tuesday.
    expect(await resolveCheckinRunDate(deps, standup, la, new Date("2026-07-20T16:00:00Z"))).toBe("2026-07-21");
    // A Tokyo member at Tokyo Monday 14:00 (after the digest) is a late check-in to Monday.
    expect(await resolveCheckinRunDate(deps, standup, tyo, new Date("2026-07-20T05:00:00Z"))).toBe("2026-07-20");
    // LA Friday 09:00 = Tokyo Saturday 01:00 → Friday's digest is out → next Monday.
    const fri = await storage.getOrCreateRun(standup.id, "2026-07-24");
    await storage.markDigestPosted(fri.id, "posted", "2.0");
    expect(await resolveCheckinRunDate(deps, standup, la, new Date("2026-07-24T16:00:00Z"))).toBe("2026-07-27");
  });

  it("maps a member ahead of the channel onto their own date, and off-days onto the channel's run", async () => {
    const { deps, storage } = makeDeps();
    const standup = await makeStandup(storage, "America/Los_Angeles");
    // Tokyo Monday 09:00 = LA Sunday 17:00 → Monday's run, not an unscheduled Sunday one.
    expect(await resolveCheckinRunDate(deps, standup, tyo, new Date("2026-07-20T00:00:00Z"))).toBe("2026-07-20");
    // Tokyo Saturday 09:00 = LA Friday 17:00 → Friday's run (the channel's day).
    expect(await resolveCheckinRunDate(deps, standup, tyo, new Date("2026-07-25T00:00:00Z"))).toBe("2026-07-24");
    // Tokyo Sunday 09:00 = LA Saturday 17:00 → neither is scheduled → next Monday.
    expect(await resolveCheckinRunDate(deps, standup, tyo, new Date("2026-07-26T00:00:00Z"))).toBe("2026-07-27");
    // Non-participant: the channel's own date.
    // Non-participant: the channel's own date (LA Monday 10:00).
    expect(await resolveCheckinRunDate(deps, standup, undefined, new Date("2026-07-20T17:00:00Z"))).toBe("2026-07-20");
  });

  it("helpers: nextScheduledDate and advancePastDigested are bounded", async () => {
    expect(nextScheduledDate("2026-07-24", [1, 2, 3, 4, 5])).toBe("2026-07-27");
    expect(nextScheduledDate("2026-07-20", [1])).toBe("2026-07-27");
    const { storage } = makeDeps();
    const standup = await makeStandup(storage, "Asia/Tokyo");
    // Nothing digested → unchanged, even when behind the channel.
    expect(await advancePastDigested(storage, standup, "2026-07-20", "2026-07-21")).toBe("2026-07-20");
    // Never advances when already on or past the channel's date.
    const run = await storage.getOrCreateRun(standup.id, "2026-07-20");
    await storage.markDigestPosted(run.id, "p", "1");
    expect(await advancePastDigested(storage, standup, "2026-07-20", "2026-07-20")).toBe("2026-07-20");
  });
});

describe("management permissions", () => {
  it("creator and Slack admins may manage; others are refused and nothing is deleted", async () => {
    const { deps, storage, slack } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York");
    slack.admins.add("U_ADMIN");
    expect(await canManage(deps, standup, "U_OWNER")).toBe(true);
    expect(await canManage(deps, standup, "U_ADMIN")).toBe(true);
    expect(await canManage(deps, standup, "U_RANDO")).toBe(false);

    const refusal = await handleRemove(deps, "C_TEAM", "U_RANDO", true, "sunup");
    expect(refusal).toContain("Only");
    expect(refusal).toContain("<@U_OWNER>");
    expect(await storage.getStandup(standup.id)).not.toBeNull();

    expect(await handleConfig(deps, "C_TEAM", "U_RANDO", "name", "Hijacked", "sunup")).toContain("Only");
    expect((await storage.getStandup(standup.id))!.name).toBe("Daily Check-in");

    expect(await handleRemove(deps, "C_TEAM", "U_ADMIN", true, "sunup")).toContain("removed");
    expect(await storage.getStandup(standup.id)).toBeNull();
  });

  it("legacy check-ins with no recorded creator stay open to everyone", async () => {
    const { deps, storage } = makeDeps();
    const standup = await makeStandup(storage, "America/New_York", { createdBy: null });
    expect(await canManage(deps, standup, "U_ANYONE")).toBe(true);
  });

  it("rejects reminders shorter than a scheduler tick", async () => {
    const { deps, storage } = makeDeps();
    await makeStandup(storage, "America/New_York");
    expect(await handleConfig(deps, "C_TEAM", "U_OWNER", "reminder", "5", "sunup")).toContain("at least 10");
    expect(await handleConfig(deps, "C_TEAM", "U_OWNER", "reminder", "0", "sunup")).toContain("Updated");
    expect(await handleConfig(deps, "C_TEAM", "U_OWNER", "reminder", "15", "sunup")).toContain("Updated");
  });
});

describe("computeStreak with runs created ahead of the channel's day", () => {
  it("ignores unanswered future-dated runs", () => {
    const history = [
      { runDate: "2026-07-21", responded: false }, // tomorrow's run, created by a Tokyo member
      { runDate: "2026-07-20", responded: true },
      { runDate: "2026-07-17", responded: true },
    ];
    expect(computeStreak(history, "2026-07-20")).toBe(2);
  });
});
