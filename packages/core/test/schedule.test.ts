import { describe, expect, it } from "vitest";
import { computeDuePrompts } from "../src/cron";
import { localParts, parseHM } from "../src/time";
import { isBlocker, type Participant, type Standup } from "../src/index";
import { buildDigest } from "../src/blocks/digest";

const standup: Standup = {
  id: 1,
  name: "Daily Check-in",
  channelId: "C123",
  questions: ["Yesterday?", "Today?", "Blockers?"],
  scheduleDays: [1, 2, 3, 4, 5],
  promptTime: "09:00",
  digestTime: "11:30",
  timezone: "America/New_York",
  userTzPrompts: true,
  reminderMinutes: 60,
  includeMood: true,
};

const participants: Participant[] = [
  { standupId: 1, userId: "U_NYC", tz: "America/New_York" },
  { standupId: 1, userId: "U_LON", tz: "Europe/London" },
  { standupId: 1, userId: "U_SFO", tz: "America/Los_Angeles" },
  { standupId: 1, userId: "U_NOTZ", tz: null },
];

describe("localParts", () => {
  it("computes local date/weekday/minutes across timezones", () => {
    // 2026-07-20 is a Monday. 13:05 UTC = 09:05 New York (EDT), 14:05 London (BST).
    const now = new Date("2026-07-20T13:05:00Z");
    expect(localParts(now, "America/New_York")).toEqual({ date: "2026-07-20", weekday: 1, minutes: 9 * 60 + 5 });
    expect(localParts(now, "Europe/London")).toEqual({ date: "2026-07-20", weekday: 1, minutes: 14 * 60 + 5 });
  });

  it("handles date rollover", () => {
    // 02:00 UTC Monday = Sunday evening in Los Angeles.
    const now = new Date("2026-07-20T02:00:00Z");
    expect(localParts(now, "America/Los_Angeles").date).toBe("2026-07-19");
    expect(localParts(now, "America/Los_Angeles").weekday).toBe(0);
  });
});

describe("parseHM", () => {
  it("parses valid times and rejects junk", () => {
    expect(parseHM("09:00")).toBe(540);
    expect(parseHM("23:59")).toBe(23 * 60 + 59);
    expect(parseHM("9:30")).toBe(570);
    expect(parseHM("24:00")).toBeNull();
    expect(parseHM("morning")).toBeNull();
  });
});

describe("computeDuePrompts", () => {
  it("prompts each user at their own local 09:00", () => {
    // 13:05 UTC Monday: NYC is 09:05 (due), London is 14:05 (due), LA is 06:05 (not yet).
    const now = new Date("2026-07-20T13:05:00Z");
    const due = computeDuePrompts(now, standup, participants, "2026-07-20").map((p) => p.userId);
    expect(due).toContain("U_NYC");
    expect(due).toContain("U_LON");
    expect(due).not.toContain("U_SFO");
    // No cached tz falls back to the standup timezone (NYC → due).
    expect(due).toContain("U_NOTZ");
  });

  it("does not prompt for a different anchor date", () => {
    // London has rolled into Tuesday; anchor date is still Monday in NYC.
    const now = new Date("2026-07-21T00:30:00Z");
    const due = computeDuePrompts(now, standup, participants, "2026-07-20").map((p) => p.userId);
    expect(due).not.toContain("U_LON");
  });
});

describe("isBlocker", () => {
  it("ignores the many spellings of 'nothing'", () => {
    for (const noise of ["", "none", "No", "n/a", "-", "  nope  "]) {
      expect(isBlocker(noise)).toBe(false);
    }
    expect(isBlocker("waiting on the API team")).toBe(true);
  });
});

describe("buildDigest", () => {
  const run = { id: 10, standupId: 1, runDate: "2026-07-20", digestPostedAt: null };

  it("surfaces blockers and non-responders", () => {
    const digest = buildDigest(
      standup,
      run,
      [
        { runId: 10, userId: "U_NYC", answers: ["shipped", "more shipping", "waiting on infra"], mood: 4, submittedAt: "" },
        { runId: 10, userId: "U_LON", answers: ["reviewed", "coding", "none"], mood: 5, submittedAt: "" },
      ],
      participants,
    );
    const json = JSON.stringify(digest.blocks);
    expect(json).toContain("Blockers");
    expect(json).toContain("waiting on infra");
    expect(json).toContain("Waiting on:");
    expect(json).toContain("U_SFO");
  });

  it("handles an empty day", () => {
    const digest = buildDigest(standup, run, [], participants);
    expect(JSON.stringify(digest.blocks)).toContain("No check-ins");
  });
});
