import type { LeaderboardEntry } from "../types";

export function buildKudosMessage(fromUser: string, toUser: string, message: string): { text: string; blocks: unknown[] } {
  const text = `🎉 <@${fromUser}> gave kudos to <@${toUser}>!`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `🎉 *Kudos!* <@${fromUser}> → <@${toUser}>\n> ${message}` } },
    ],
  };
}

export function formatLeaderboard(entries: LeaderboardEntry[], mention: (userId: string) => string = (id) => `<@${id}>`): string {
  if (entries.length === 0) return "_No kudos yet — start with `/kudos @someone for being awesome`_";
  const medals = ["🥇", "🥈", "🥉"];
  return entries
    .map((e, i) => `${medals[i] ?? "▪️"} ${mention(e.userId)} — ${e.count} kudos`)
    .join("\n");
}
