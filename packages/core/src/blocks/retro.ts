import type { CheckinResponse, LeaderboardEntry, Participant, RunSummary, Standup } from "../types";
import { isBlocker } from "../types";
import { formatRunDate } from "../time";

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MOOD_EMOJI: Record<number, string> = { 1: "😫", 2: "😕", 3: "😐", 4: "🙂", 5: "😄" };

export interface RetroInput {
  weekStart: string;
  weekEnd: string;
  /** Runs inside the window, ascending by date. */
  runs: RunSummary[];
  /** Responses inside the window, tagged with their run date. */
  responses: Array<{ runDate: string; response: CheckinResponse }>;
  /** Active (non-snoozed) participants. */
  participants: Participant[];
  /** Current streak per user. */
  streaks: Record<string, number>;
  kudosGiven: number;
  topKudos: LeaderboardEntry | null;
}

export function buildWeeklyRetro(standup: Standup, input: RetroInput): { text: string; blocks: unknown[] } {
  const { runs, responses, participants } = input;
  const possible = runs.length * Math.max(participants.length, 1);
  const pct = possible > 0 ? Math.round((responses.length / possible) * 100) : 0;

  const byDay = runs
    .map((r) => {
      const weekday = new Date(`${r.runDate}T12:00:00Z`).getUTCDay();
      const ratio = participants.length > 0 ? r.responseCount / participants.length : 0;
      const square = ratio >= 1 ? "🟩" : ratio >= 0.5 ? "🟨" : r.responseCount > 0 ? "🟧" : "⬜";
      return `${DAY_ABBR[weekday]} ${square}`;
    })
    .join("  ");

  const lines: string[] = [
    `✅ *Check-ins:* ${responses.length}/${possible} (${pct}%)`,
    byDay ? `📅 ${byDay}` : "",
  ];

  const moods = responses.map((r) => r.response.mood).filter((m): m is number => m != null);
  if (standup.includeMood && moods.length >= 3) {
    const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
    const perDay = runs
      .map((run) => {
        const dayMoods = responses.filter((r) => r.runDate === run.runDate).map((r) => r.response.mood).filter((m): m is number => m != null);
        if (dayMoods.length === 0) return "▫️";
        return MOOD_EMOJI[Math.round(dayMoods.reduce((a, b) => a + b, 0) / dayMoods.length)] ?? "▫️";
      })
      .join("");
    lines.push(`😊 *Mood:* ${perDay}  avg ${avg.toFixed(1)}/5`);
  }

  const blockersIdx = standup.questions.length - 1;
  const blockers = input.responses
    .filter(({ response }) => isBlocker(response.answers[blockersIdx] ?? ""))
    .map(({ runDate, response }) => {
      const weekday = new Date(`${runDate}T12:00:00Z`).getUTCDay();
      return `• ${DAY_ABBR[weekday]} — <@${response.userId}>: ${(response.answers[blockersIdx] ?? "").split("\n")[0]}`;
    });

  if (input.kudosGiven > 0) {
    const top = input.topKudos;
    lines.push(`🎉 *Kudos:* ${input.kudosGiven} given${top ? `, most to <@${top.userId}> (${top.count})` : ""}`);
  }

  const topStreaks = Object.entries(input.streaks)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topStreaks.length > 0) {
    lines.push(`🔥 *Streaks:* ${topStreaks.map(([u, n]) => `<@${u}> ${n}`).join(" · ")}`);
  }

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `📆 ${standup.name} — weekly retro` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${formatRunDate(input.weekStart)} – ${formatRunDate(input.weekEnd)}` }] },
    { type: "section", text: { type: "mrkdwn", text: lines.filter(Boolean).join("\n").slice(0, 3000) } },
  ];
  if (blockers.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `🚧 *Blockers this week (${blockers.length})*\n${blockers.slice(0, 8).join("\n")}`.slice(0, 3000) },
    });
  }

  return { text: `${standup.name} weekly retro`, blocks };
}
