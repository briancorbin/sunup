import type { Blocker, CheckinResponse, Participant, Run, Standup } from "../types";
import { blockerAgeDays, isBlocker } from "../types";
import { formatRunDate } from "../time";

const MOOD_EMOJI: Record<number, string> = { 1: "😫", 2: "😕", 3: "😐", 4: "🙂", 5: "😄" };

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Streak counts worth celebrating inline in the digest. */
const STREAK_MILESTONES = new Set([3, 5, 10, 25, 50, 100, 250]);

export function buildDigest(
  standup: Standup,
  run: Run,
  responses: CheckinResponse[],
  participants: Participant[],
  streaks: Record<string, number> = {},
  openBlockers?: Blocker[],
): { text: string; blocks: unknown[] } {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: `☀️ ${standup.name} — ${formatRunDate(run.runDate)}` } },
  ];

  if (responses.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No check-ins were submitted today._" } });
  }

  for (const response of responses) {
    const body = standup.questions
      .map((question, i) => {
        const answer = response.answers[i]?.trim();
        if (!answer) return null;
        return `*${question}*\n${quote(answer)}`;
      })
      .filter(Boolean)
      .join("\n");
    const streak = streaks[response.userId] ?? 0;
    const flame = STREAK_MILESTONES.has(streak) ? `   🔥 *${streak}-day streak!*` : "";
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*<@${response.userId}>*${flame}\n${body}`.slice(0, 3000) },
    });
  }

  // Blockers get their own section so leads can scan for them. With lifecycle
  // tracking (openBlockers provided): every open blocker appears — aged, aging
  // first, and flagged when the owner went silent today. Without: derive from
  // today's answers as before.
  let blockerLines: string[] = [];
  if (openBlockers) {
    blockerLines = openBlockers
      .slice()
      .sort((a, b) => a.openedDate.localeCompare(b.openedDate))
      .map((b) => {
        const age = blockerAgeDays(b, run.runDate);
        const agePart = age > 1 ? ` _(blocked ${age} days)_` : "";
        const silent = b.lastConfirmedDate < run.runDate ? " _(no update today)_" : "";
        return `• <@${b.userId}>: ${b.text.split("\n")[0]}${agePart}${silent}`;
      });
  } else {
    const blockersIdx = standup.questions.length - 1;
    blockerLines = responses
      .filter((r) => isBlocker(r.answers[blockersIdx] ?? ""))
      .map((r) => `• <@${r.userId}>: ${(r.answers[blockersIdx] ?? "").split("\n")[0]}`);
  }
  if (blockerLines.length > 0) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `🚧 *Blockers*\n${blockerLines.join("\n")}`.slice(0, 3000) },
    });
  }

  const contextLines: string[] = [];
  const responded = new Set(responses.map((r) => r.userId));
  const missing = participants.filter((p) => !responded.has(p.userId));
  if (missing.length > 0 && responses.length > 0) {
    contextLines.push(`Waiting on: ${missing.map((p) => `<@${p.userId}>`).join(", ")}`);
  }
  const moods = responses.map((r) => r.mood).filter((m): m is number => m != null);
  if (moods.length >= 3) {
    // Only show mood with 3+ datapoints so it stays semi-anonymous.
    const avg = moods.reduce((a, b) => a + b, 0) / moods.length;
    contextLines.push(`Team mood: ${MOOD_EMOJI[Math.round(avg)] ?? "😐"} ${avg.toFixed(1)}/5`);
  }
  if (contextLines.length > 0) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: contextLines.join("   •   ") }] });
  }

  return { text: `${standup.name} digest for ${formatRunDate(run.runDate)}`, blocks };
}
