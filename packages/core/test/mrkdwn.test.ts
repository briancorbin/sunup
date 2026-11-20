import { describe, expect, it } from "vitest";
import { escapeMrkdwn } from "../src/mrkdwn";
import { buildDigest } from "../src/blocks/digest";
import { buildKudosMessage } from "../src/blocks/kudos";
import { buildWeeklyRetro } from "../src/blocks/retro";
import { buildHomeView } from "../src/blocks/home";
import { buildPromptMessage } from "../src/blocks/checkin-modal";
import type { Blocker, CheckinResponse, Participant, Run, Standup } from "../src/types";

const HOSTILE = "<!channel> <https://x|y> a & b";
const RAW = "<!channel>";
const ESC = "&lt;!channel&gt;";

const standup: Standup = {
  id: 1,
  name: `Team ${HOSTILE}`,
  channelId: "C123",
  kind: "sunup",
  questions: [`Done? ${HOSTILE}`, "Today?", "Blockers?"],
  scheduleDays: [1, 2, 3, 4, 5],
  promptTime: "09:00",
  digestTime: "11:30",
  timezone: "America/New_York",
  userTzPrompts: true,
  reminderMinutes: 60,
  includeMood: true,
  lastRetroDate: null,
  createdBy: null,
};

const run: Run = { id: 7, standupId: 1, runDate: "2026-07-20", digestPostedAt: null, digestTs: null };

const response: CheckinResponse = {
  runId: 7,
  userId: "U_ALICE",
  answers: [HOSTILE, "fine", HOSTILE],
  mood: 3,
  submittedAt: "2026-07-20T14:00:00Z",
};

const participants: Participant[] = [
  { standupId: 1, userId: "U_ALICE", tz: null, snoozedUntil: null, lastPromptDate: null },
  { standupId: 1, userId: "U_BOB", tz: null, snoozedUntil: null, lastPromptDate: null },
];

const blocker: Blocker = {
  id: 1,
  standupId: 1,
  userId: "U_BOB",
  text: HOSTILE,
  openedDate: "2026-07-18",
  lastConfirmedDate: "2026-07-20",
  resolvedAt: null,
};

// Header blocks are plain_text (Slack doesn't parse them), so they stay raw.
function expectSafe(value: unknown) {
  const mrkdwnBlocks = (value as Array<{ type: string }>).filter((b) => b.type !== "header");
  const json = JSON.stringify(mrkdwnBlocks);
  expect(json).not.toContain(RAW);
  expect(json).not.toContain("<https://x|y>");
  expect(json).toContain(ESC);
  expect(json).toContain("&lt;https://x|y&gt;");
  expect(json).toContain("a &amp; b");
  return json;
}

describe("escapeMrkdwn", () => {
  it("escapes & first so entities are not double-escaped", () => {
    expect(escapeMrkdwn("<")).toBe("&lt;");
    expect(escapeMrkdwn("&<>")).toBe("&amp;&lt;&gt;");
  });
  it("neutralizes special commands and links", () => {
    expect(escapeMrkdwn("<!channel>")).toBe("&lt;!channel&gt;");
    expect(escapeMrkdwn("<https://x|y>")).toBe("&lt;https://x|y&gt;");
  });
  it("leaves plain text untouched", () => {
    expect(escapeMrkdwn("shipped the thing, 100% done")).toBe("shipped the thing, 100% done");
  });
});

describe("mrkdwn escaping in block builders", () => {
  it("buildDigest (derived blockers)", () => {
    const { text, blocks } = buildDigest(standup, run, [response], participants);
    const json = expectSafe(blocks);
    expect(json).toContain("<@U_ALICE>");
    expect(text).not.toContain(RAW);
    expect(text).toContain(ESC);
    // plain_text header keeps the raw name
    const header = blocks[0] as { text: { type: string; text: string } };
    expect(header.text.type).toBe("plain_text");
    expect(header.text.text).toContain(`Team ${RAW}`);
  });

  it("buildDigest (tracked blockers)", () => {
    const clean: CheckinResponse = { ...response, answers: ["x", "y", "none"] };
    const { blocks } = buildDigest(standup, run, [clean], participants, {}, [blocker]);
    const json = expectSafe(blocks);
    expect(json).toContain("<@U_BOB>");
  });

  it("buildKudosMessage", () => {
    const { text, blocks } = buildKudosMessage("U_ALICE", "U_BOB", HOSTILE);
    const json = expectSafe(blocks);
    expect(json).toContain("<@U_ALICE>");
    expect(json).toContain("<@U_BOB>");
    expect(text).toContain("<@U_ALICE>");
  });

  it("buildWeeklyRetro", () => {
    const { text, blocks } = buildWeeklyRetro(standup, {
      weekStart: "2026-07-20",
      weekEnd: "2026-07-24",
      runs: [{ runDate: "2026-07-20", responseCount: 1, digestPostedAt: null }],
      responses: [{ runDate: "2026-07-20", response }],
      participants,
      streaks: {},
      kudosGiven: 0,
      topKudos: null,
    });
    const json = expectSafe(blocks);
    expect(json).toContain("<@U_ALICE>");
    expect(text).not.toContain(RAW);
    expect(text).toContain(ESC);
    const header = blocks[0] as { text: { type: string; text: string } };
    expect(header.text.text).toContain(`Team ${RAW}`);
  });

  it("buildHomeView", () => {
    const view = buildHomeView(
      "U_ALICE",
      [
        {
          standup,
          respondedToday: false,
          runToday: true,
          streak: 1,
          recentRuns: [],
          teamSize: 2,
          blockers: [
            { userId: "U_BOB", text: HOSTILE, status: "open", ageDays: 2 },
            { userId: "U_BOB", text: HOSTILE, status: "resolved", ageDays: 0 },
          ],
        },
      ],
      [],
    ) as { blocks: unknown[] };
    const json = expectSafe(view.blocks);
    expect(json).toContain("<@U_BOB>");
    expect(json).toContain("<#C123>");
  });

  it("buildPromptMessage (greeting, reminder, open blocker)", () => {
    for (const isReminder of [false, true]) {
      const { text, blocks } = buildPromptMessage(standup, 7, isReminder, blocker, "2026-07-20");
      expect(text).not.toContain(RAW);
      expect(text).toContain(ESC);
      expectSafe(blocks);
    }
  });
});
