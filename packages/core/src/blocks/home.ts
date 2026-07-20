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
  /** Most recent unresolved-looking blockers across the team. */
  recentBlockers: Array<{ runDate: string; userId: string; blocker: string }>;
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
        : "⏳ Not checked in yet — `/sunup` to start";
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
    if (s.recentBlockers.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚧 *Recent blockers*\n${s.recentBlockers
            .map((b) => `• \`${b.runDate.slice(5)}\` <@${b.userId}>: ${b.blocker}`)
            .join("\n")}`.slice(0, 3000),
        },
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
