import type { LeaderboardEntry, Standup } from "../types";
import { formatLeaderboard } from "./kudos";

export interface HomeStandupStats {
  standup: Standup;
  respondedToday: boolean;
  runToday: boolean;
  /** Consecutive most-recent runs with a response from this user. */
  streak: number;
  /** Participation over recent runs, e.g. [{runDate, responseCount}] with team size. */
  recentRuns: Array<{ runDate: string; responseCount: number }>;
  teamSize: number;
  /** The blocker board: open blockers (with age) first, then recent resolutions. */
  blockers: Array<{ userId: string; text: string; status: "open" | "resolved"; ageDays: number }>;
}

export function buildHomeView(userId: string, stats: HomeStandupStats[], leaderboard: LeaderboardEntry[]): unknown {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "☀️ Sunup" } },
  ];

  if (stats.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "You're not part of any check-ins yet.\n\n• `/sunup setup` in a channel creates one\n• `/sunup join` in a channel with an existing check-in adds you",
      },
    });
  }

  for (const s of stats) {
    const today = !s.runToday
      ? "No check-in scheduled today"
      : s.respondedToday
        ? "✅ You've checked in today"
        : `⏳ Not checked in yet — \`/${s.standup.kind}\` to start`;
    const participation = s.recentRuns
      .slice()
      .reverse()
      .map((r) => {
        const ratio = s.teamSize > 0 ? r.responseCount / s.teamSize : 0;
        return ratio >= 1 ? "🟩" : ratio >= 0.5 ? "🟨" : r.responseCount > 0 ? "🟧" : "⬜";
      })
      .join("");
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${s.standup.name}*  ·  <#${s.standup.channelId}>`,
          today,
          `🔥 Streak: *${s.streak}*   ·   Team participation (last ${s.recentRuns.length} runs): ${participation || "_no runs yet_"}`,
        ].join("\n"),
      },
    });
    if (s.blockers.length > 0) {
      const lines = s.blockers.map((b) =>
        b.status === "open"
          ? `🔴 <@${b.userId}>: ${b.text}${b.ageDays > 1 ? `  _(${b.ageDays} days)_` : ""}`
          : `✅ <@${b.userId}>: ${b.text}`,
      );
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `🚧 *Blocker board*\n${lines.join("\n")}`.slice(0, 3000) },
      });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*🏆 Kudos leaderboard (30 days)*\n${formatLeaderboard(leaderboard)}` } });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "sunup — open-source async check-ins · `/sunup help` for commands" }],
  });

  return { type: "home", blocks };
}
