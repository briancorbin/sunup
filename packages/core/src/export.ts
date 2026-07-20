import type { CheckinResponse, Standup } from "./types";

/**
 * CSV export served by the adapter over a short-lived HMAC-signed link —
 * no extra Slack scopes needed. Token format: `<standupId>.<expiresUnixSec>.<hmacHex>`.
 */

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeExportToken(secret: string, standupId: number, expiresUnixSec: number): Promise<string> {
  const payload = `${standupId}.${expiresUnixSec}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/** Returns the standup id, or null when invalid/expired. */
export async function verifyExportToken(secret: string, token: string, nowUnixSec: number): Promise<number | null> {
  const [idStr, expStr, mac] = token.split(".");
  if (!idStr || !expStr || !mac) return null;
  const expected = await hmacHex(secret, `${idStr}.${expStr}`);
  // Constant-time-ish compare (both sides are fixed-length hex of our own making).
  if (mac.length !== expected.length || [...mac].some((c, i) => c !== expected[i])) return null;
  if (Number(expStr) < nowUnixSec) return null;
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function csvCell(value: string | number | null): string {
  let s = value == null ? "" : String(value);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(standup: Standup, rows: Array<{ runDate: string; response: CheckinResponse }>): string {
  const header = ["date", "user", ...standup.questions, "mood", "submitted_at"];
  const lines = [header.map(csvCell).join(",")];
  for (const { runDate, response } of rows) {
    lines.push(
      [
        runDate,
        response.userId,
        ...standup.questions.map((_q, i) => response.answers[i] ?? ""),
        response.mood ?? "",
        response.submittedAt,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
