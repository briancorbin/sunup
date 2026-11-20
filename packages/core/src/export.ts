import type { CheckinResponse, Standup } from "./types";

/**
 * CSV export and report pages served by the adapter over short-lived
 * HMAC-signed links — no extra Slack scopes needed. Token format:
 * `<standupId>.<expiresUnixSec>.<hmacHex>`.
 *
 * Tokens are signed with LINK_SECRET when it is set, otherwise with a key
 * derived from the Slack signing secret (see `deriveLinkSecret`). MACs are
 * checked with `crypto.subtle.verify`, which is constant-time.
 */

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Decodes a 64-char hex string to bytes; null if the wrong length or any non-hex char. */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyMac(secret: string, payload: string, mac: string): Promise<boolean> {
  const macBytes = hexToBytes(mac);
  if (!macBytes) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), macBytes, enc.encode(payload));
}

/**
 * Fallback link-signing key when no LINK_SECRET is configured: hex of
 * HMAC-SHA256(key = signingSecret, message = "sunup:link-secret:v1"). Keeps the
 * Slack signing secret itself from being used directly as a link key.
 */
export async function deriveLinkSecret(signingSecret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(signingSecret), enc.encode("sunup:link-secret:v1"));
  return toHex(sig);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message)));
}

export async function makeExportToken(secret: string, standupId: number, expiresUnixSec: number): Promise<string> {
  const payload = `${standupId}.${expiresUnixSec}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/** Returns the standup id, or null when invalid/expired. */
export async function verifyExportToken(secret: string, token: string, nowUnixSec: number): Promise<number | null> {
  const [idStr, expStr, mac] = token.split(".");
  if (!idStr || !expStr || !mac) return null;
  if (!(await verifyMac(secret, `${idStr}.${expStr}`, mac))) return null;
  if (Number(expStr) < nowUnixSec) return null;
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export type ReportRange = "week" | "month" | "quarter";
export const REPORT_RANGE_DAYS: Record<ReportRange, number> = { week: 7, month: 30, quarter: 90 };

/** Report token: `report.<standupId>.<range>.<expiresUnixSec>.<hmacHex>`. */
export async function makeReportToken(secret: string, standupId: number, range: ReportRange, expiresUnixSec: number): Promise<string> {
  const payload = `report.${standupId}.${range}.${expiresUnixSec}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyReportToken(
  secret: string,
  token: string,
  nowUnixSec: number,
): Promise<{ standupId: number; range: ReportRange } | null> {
  const [tag, idStr, range, expStr, mac] = token.split(".");
  if (tag !== "report" || !idStr || !range || !expStr || !mac) return null;
  if (!(await verifyMac(secret, `report.${idStr}.${range}.${expStr}`, mac))) return null;
  if (Number(expStr) < nowUnixSec) return null;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0 || !(range in REPORT_RANGE_DAYS)) return null;
  return { standupId: id, range: range as ReportRange };
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
