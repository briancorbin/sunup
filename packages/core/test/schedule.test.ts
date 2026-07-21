import { describe, expect, it } from "vitest";
import { computeDuePrompts } from "../src/cron";
import { localParts, parseHM } from "../src/time";
import {
  addDays,
  blockerAgeDays,
  computeStreak,
  isBlocker,
  lastScheduledDay,
  makeExportToken,
  parseConfigSubmission,
  toCsv,
  verifyExportToken,
  type Participant,
  type Standup,
} from "../src/index";
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
  lastRetroDate: null,
};

const participants: Participant[] = [
  { standupId: 1, userId: "U_NYC", tz: "America/New_York", snoozedUntil: null },
  { standupId: 1, userId: "U_LON", tz: "Europe/London", snoozedUntil: null },
  { standupId: 1, userId: "U_SFO", tz: "America/Los_Angeles", snoozedUntil: null },
  { standupId: 1, userId: "U_NOTZ", tz: null, snoozedUntil: null },
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

  it("skips snoozed participants until their snooze expires", () => {
    const now = new Date("2026-07-20T13:05:00Z");
    const snoozed: Participant[] = [
      { standupId: 1, userId: "U_PTO", tz: "America/New_York", snoozedUntil: "2026-07-24" },
      { standupId: 1, userId: "U_BACK", tz: "America/New_York", snoozedUntil: "2026-07-19" },
    ];
    const due = computeDuePrompts(now, standup, snoozed, "2026-07-20").map((p) => p.userId);
    expect(due).not.toContain("U_PTO");
    expect(due).toContain("U_BACK");
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

describe("computeStreak", () => {
  it("counts consecutive responded runs, most recent first", () => {
    const history = [
      { runDate: "2026-07-20", responded: false }, // today, still open — doesn't break
      { runDate: "2026-07-17", responded: true },
      { runDate: "2026-07-16", responded: true },
      { runDate: "2026-07-15", responded: false },
      { runDate: "2026-07-14", responded: true },
    ];
    expect(computeStreak(history, "2026-07-20")).toBe(2);
    // Same history on a later day: the missed 07-20 now breaks it.
    expect(computeStreak(history, "2026-07-21")).toBe(0);
  });
});

describe("week helpers", () => {
  it("addDays does calendar math across month boundaries", () => {
    expect(addDays("2026-07-20", -6)).toBe("2026-07-14");
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  });

  it("lastScheduledDay uses a Monday-start week", () => {
    expect(lastScheduledDay([1, 2, 3, 4, 5])).toBe(5); // Mon–Fri → Friday
    expect(lastScheduledDay([1, 3, 5])).toBe(5);
    expect(lastScheduledDay([0, 2])).toBe(0); // Sunday is the END of the week
  });
});

describe("export", () => {
  it("round-trips a valid token and rejects tampering/expiry", async () => {
    const token = await makeExportToken("secret", 42, 1000);
    expect(await verifyExportToken("secret", token, 999)).toBe(42);
    expect(await verifyExportToken("secret", token, 1001)).toBeNull(); // expired
    expect(await verifyExportToken("other", token, 999)).toBeNull(); // wrong key
    expect(await verifyExportToken("secret", token.replace("42", "43"), 999)).toBeNull(); // tampered
  });

  it("escapes CSV cells and neutralizes formula injection", () => {
    const csv = toCsv(standup, [
      {
        runDate: "2026-07-20",
        response: {
          runId: 1,
          userId: "U1",
          answers: ['said "done", shipped', "=HYPERLINK(evil)", "none"],
          mood: 4,
          submittedAt: "2026-07-20T13:00:00Z",
        },
      },
    ]);
    expect(csv).toContain('"said ""done"", shipped"');
    expect(csv).toContain("'=HYPERLINK(evil)");
  });
});

describe("parseConfigSubmission", () => {
  it("applies a full submission", () => {
    const { standup: updated, errors } = parseConfigSubmission(standup, {
      name: { answer: { value: "Morning Muster" } },
      days: { answer: { selected_options: [{ value: "1" }, { value: "3" }, { value: "5" }] } },
      prompt_time: { answer: { selected_time: "08:30" } },
      digest_time: { answer: { selected_time: "12:00" } },
      timezone: { answer: { value: "Europe/London" } },
      tz_mode: { answer: { selected_option: { value: "fixed" } } },
      reminder: { answer: { selected_option: { value: "30" } } },
      mood: { answer: { selected_option: { value: "off" } } },
      questions: { answer: { value: "What shipped?\nWhat's next?\nBlockers?" } },
    });
    expect(errors).toEqual({});
    expect(updated).toMatchObject({
      name: "Morning Muster",
      scheduleDays: [1, 3, 5],
      promptTime: "08:30",
      digestTime: "12:00",
      timezone: "Europe/London",
      userTzPrompts: false,
      reminderMinutes: 30,
      includeMood: false,
      questions: ["What shipped?", "What's next?", "Blockers?"],
    });
  });

  it("reports field errors keyed by block_id", () => {
    const { errors } = parseConfigSubmission(standup, {
      name: { answer: { value: "  " } },
      days: { answer: { selected_options: [] } },
      timezone: { answer: { value: "Mars/Olympus_Mons" } },
      questions: { answer: { value: "\n\n" } },
    });
    expect(Object.keys(errors).sort()).toEqual(["days", "name", "questions", "timezone"]);
  });
});

describe("buildDigest", () => {
  const run = { id: 10, standupId: 1, runDate: "2026-07-20", digestPostedAt: null, digestTs: null };

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

  it("renders tracked blockers with age, oldest first, flagging silent owners", () => {
    const digest = buildDigest(standup, run, [], participants, {}, [
      { id: 1, standupId: 1, userId: "U_NYC", text: "waiting on infra", openedDate: "2026-07-18", lastConfirmedDate: "2026-07-20", resolvedAt: null },
      { id: 2, standupId: 1, userId: "U_LON", text: "app review stuck", openedDate: "2026-07-16", lastConfirmedDate: "2026-07-17", resolvedAt: null },
    ]);
    const json = JSON.stringify(digest.blocks);
    expect(json).toContain("blocked 3 days"); // U_NYC: 18th → 20th
    expect(json).toContain("blocked 5 days"); // U_LON: 16th → 20th
    expect(json).toContain("no update today"); // U_LON went silent
    // Oldest blocker sorts first.
    expect(json.indexOf("app review stuck")).toBeLessThan(json.indexOf("waiting on infra"));
  });
});

describe("blockerAgeDays", () => {
  it("counts inclusively from opened date", () => {
    const b = { id: 1, standupId: 1, userId: "U", text: "x", openedDate: "2026-07-18", lastConfirmedDate: "2026-07-18", resolvedAt: null };
    expect(blockerAgeDays(b, "2026-07-18")).toBe(1);
    expect(blockerAgeDays(b, "2026-07-21")).toBe(4);
  });
});
