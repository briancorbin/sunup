import type { Storage } from "./ports";
import type { LeaderboardEntry, Standup } from "./types";
import { blockerAgeDays, kindBehavior } from "./types";
import { addDays, formatRunDate, localParts } from "./time";
import { computeStreak } from "./cron";
import { REPORT_RANGE_DAYS, type ReportRange } from "./export";

export interface ReportData {
  range: ReportRange;
  startDate: string;
  endDate: string;
  teamSize: number;
  runs: Array<{ runDate: string; responseCount: number; moodAvg: number | null }>;
  totalCheckins: number;
  /** 0..1 across all runs in range. */
  responseRate: number;
  streaks: Array<{ userId: string; streak: number }>;
  kudos: LeaderboardEntry[];
  openBlockers: Array<{ userId: string; text: string; ageDays: number }>;
  resolvedBlockers: Array<{ userId: string; text: string; days: number }>;
  avgResolveDays: number | null;
}

export async function buildReportData(storage: Storage, standup: Standup, range: ReportRange, now: Date): Promise<ReportData> {
  const anchor = localParts(now, standup.timezone);
  const startDate = addDays(anchor.date, -(REPORT_RANGE_DAYS[range] - 1));
  const inRange = (d: string) => d >= startDate && d <= anchor.date;

  const participants = await storage.listParticipants(standup.id);
  const runs = (await storage.listRecentRuns(standup.id, 150)).filter((r) => inRange(r.runDate)).reverse();
  const responses = (await storage.listRecentResponses(standup.id, 5000)).filter((r) => inRange(r.runDate));

  const moodByRun = new Map<string, number[]>();
  for (const { runDate, response } of responses) {
    if (response.mood != null) {
      moodByRun.set(runDate, [...(moodByRun.get(runDate) ?? []), response.mood]);
    }
  }
  const runStats = runs.map((r) => {
    const moods = moodByRun.get(r.runDate) ?? [];
    // Same anonymity rule as the digest: only show mood with 3+ datapoints.
    const moodAvg = standup.includeMood && moods.length >= 3 ? moods.reduce((a, b) => a + b, 0) / moods.length : null;
    return { runDate: r.runDate, responseCount: r.responseCount, moodAvg };
  });

  const totalCheckins = runStats.reduce((a, r) => a + r.responseCount, 0);
  const possible = runStats.length * Math.max(participants.length, 1);

  const streaks: Array<{ userId: string; streak: number }> = [];
  for (const p of participants) {
    const streak = computeStreak(await storage.listUserRunHistory(standup.id, p.userId, 90), anchor.date);
    if (streak >= 2) streaks.push({ userId: p.userId, streak });
  }
  streaks.sort((a, b) => b.streak - a.streak);

  const open = (await storage.listOpenBlockers(standup.id)).map((b) => ({
    userId: b.userId,
    text: b.text.split("\n")[0] ?? "",
    ageDays: blockerAgeDays(b, anchor.date),
  }));
  const resolved = (await storage.listResolvedBlockers(standup.id, 100))
    .filter((b) => (b.resolvedAt ?? "") >= `${startDate}T00:00:00Z`)
    .map((b) => ({
      userId: b.userId,
      text: b.text.split("\n")[0] ?? "",
      days: blockerAgeDays(b, (b.resolvedAt ?? "").slice(0, 10) || b.lastConfirmedDate),
    }));
  const avgResolveDays = resolved.length > 0 ? resolved.reduce((a, b) => a + b.days, 0) / resolved.length : null;

  return {
    range,
    startDate,
    endDate: anchor.date,
    teamSize: participants.length,
    runs: runStats,
    totalCheckins,
    responseRate: possible > 0 ? totalCheckins / possible : 0,
    streaks: streaks.slice(0, 5),
    kudos: await storage.kudosLeaderboard(`${startDate}T00:00:00Z`, 5),
    openBlockers: open.sort((a, b) => b.ageDays - a.ageDays),
    resolvedBlockers: resolved,
    avgResolveDays,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function shortDate(runDate: string): string {
  return runDate.slice(5).replace("-", "/");
}

/** Bar chart of responses per run. Pure inline SVG, no dependencies. */
function participationSvg(data: ReportData): string {
  const runs = data.runs;
  if (runs.length === 0) return "<p class='empty'>No runs in this period.</p>";
  const barW = 14;
  const gap = 6;
  const chartH = 120;
  const labelH = 26;
  const w = runs.length * (barW + gap) + 30;
  const labelEvery = Math.max(1, Math.ceil(runs.length / 10));
  const bars = runs
    .map((r, i) => {
      const ratio = data.teamSize > 0 ? Math.min(1, r.responseCount / data.teamSize) : 0;
      const h = Math.max(2, Math.round(ratio * chartH));
      const x = 30 + i * (barW + gap);
      const label =
        i % labelEvery === 0
          ? `<text x="${x + barW / 2}" y="${chartH + 16}" text-anchor="middle" class="tick">${shortDate(r.runDate)}</text>`
          : "";
      return `<rect x="${x}" y="${chartH - h}" width="${barW}" height="${h}" rx="3" class="bar${ratio >= 1 ? " full" : ""}"><title>${r.runDate}: ${r.responseCount}/${data.teamSize}</title></rect>${label}`;
    })
    .join("");
  const grid = [0, 0.5, 1]
    .map(
      (g) =>
        `<line x1="26" y1="${chartH - g * chartH}" x2="${w}" y2="${chartH - g * chartH}" class="grid"/><text x="22" y="${chartH - g * chartH + 4}" text-anchor="end" class="tick">${Math.round(g * 100)}%</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${w} ${chartH + labelH}" role="img" aria-label="Participation per run">${grid}${bars}</svg>`;
}

/** Line chart of team mood average per run (runs with 3+ mood responses). */
function moodSvg(data: ReportData): string {
  const points = data.runs
    .map((r, i) => ({ i, runDate: r.runDate, avg: r.moodAvg }))
    .filter((p): p is { i: number; runDate: string; avg: number } => p.avg != null);
  if (points.length < 2) return "<p class='empty'>Not enough mood data in this period (needs 3+ responses per day).</p>";
  const stepX = 22;
  const chartH = 110;
  const labelH = 26;
  const w = data.runs.length * stepX + 40;
  const y = (avg: number) => chartH - ((avg - 1) / 4) * (chartH - 10) - 5;
  const x = (i: number) => 34 + i * stepX;
  const poly = points.map((p) => `${x(p.i)},${y(p.avg).toFixed(1)}`).join(" ");
  const dots = points
    .map(
      (p) =>
        `<circle cx="${x(p.i)}" cy="${y(p.avg).toFixed(1)}" r="3.5" class="dot"><title>${p.runDate}: ${p.avg.toFixed(1)}/5</title></circle>`,
    )
    .join("");
  const grid = [1, 3, 5]
    .map((v) => `<line x1="30" y1="${y(v)}" x2="${w}" y2="${y(v)}" class="grid"/><text x="26" y="${y(v) + 4}" text-anchor="end" class="tick">${v}</text>`)
    .join("");
  const labelEvery = Math.max(1, Math.ceil(points.length / 8));
  const labels = points
    .filter((_p, idx) => idx % labelEvery === 0)
    .map((p) => `<text x="${x(p.i)}" y="${chartH + 16}" text-anchor="middle" class="tick">${shortDate(p.runDate)}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${w} ${chartH + labelH}" role="img" aria-label="Team mood per run">${grid}<polyline points="${poly}" class="line"/>${dots}${labels}</svg>`;
}

/**
 * Render the full report page. `nameOf` maps user ids to display names
 * (falls back to the id when unknown).
 */
export function renderReportHtml(standup: Standup, data: ReportData, nameOf: (userId: string) => string): string {
  const behavior = kindBehavior(standup);
  const pct = Math.round(data.responseRate * 100);
  const rangeLabel = { week: "Last 7 days", month: "Last 30 days", quarter: "Last 90 days" }[data.range];

  const statCards = [
    [`${pct}%`, "response rate"],
    [`${data.totalCheckins}`, "check-ins"],
    [`${data.teamSize}`, "teammates"],
    ...(behavior.trackBlockers
      ? [
          [`${data.openBlockers.length}`, "open blockers"],
          [data.avgResolveDays != null ? `${data.avgResolveDays.toFixed(1)}d` : "—", "avg time to unblock"],
        ]
      : []),
  ]
    .map(([v, l]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`)
    .join("");

  const list = (items: string[]) => (items.length > 0 ? `<ul>${items.join("")}</ul>` : "<p class='empty'>Nothing here for this period.</p>");
  const streakList = list(data.streaks.map((s) => `<li>🔥 <b>${esc(nameOf(s.userId))}</b> — ${s.streak} days</li>`));
  const kudosList = list(data.kudos.map((k) => `<li>🎉 <b>${esc(nameOf(k.userId))}</b> — ${k.count} kudos</li>`));
  const blockerSection = !behavior.trackBlockers
    ? ""
    : `<section><h2>🚧 Blockers</h2>
${
  data.openBlockers.length > 0
    ? `<h3>Open</h3><ul>${data.openBlockers
        .map((b) => `<li><b>${esc(nameOf(b.userId))}</b>: ${esc(b.text)} <span class="age">${b.ageDays > 1 ? `${b.ageDays} days` : "today"}</span></li>`)
        .join("")}</ul>`
    : "<p class='empty'>No open blockers. 🎉</p>"
}
${
  data.resolvedBlockers.length > 0
    ? `<h3>Resolved this period</h3><ul>${data.resolvedBlockers
        .map((b) => `<li>✅ <b>${esc(nameOf(b.userId))}</b>: ${esc(b.text)} <span class="age">${b.days}d to resolve</span></li>`)
        .join("")}</ul>`
    : ""
}</section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>${esc(standup.name)} — ${rangeLabel}</title>
<style>
:root { --bg:#fffdf7; --fg:#3d3a34; --muted:#8a8578; --card:#faf3e3; --amber:#f2a33c; --green:#7cab5a; --red:#d95d39; --grid:#e8e0cd; }
@media (prefers-color-scheme: dark) { :root { --bg:#211f1b; --fg:#f0ead9; --muted:#a29a89; --card:#2c2924; --grid:#3d382f; } }
* { box-sizing: border-box; }
body { margin:0 auto; max-width:860px; padding:32px 20px 64px; background:var(--bg); color:var(--fg);
  font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1 { font-size:26px; margin:0; } h2 { font-size:18px; margin:32px 0 8px; } h3 { font-size:14px; margin:14px 0 4px; color:var(--muted); }
.sub { color:var(--muted); margin:4px 0 24px; }
.stats { display:flex; flex-wrap:wrap; gap:12px; }
.stat { background:var(--card); border-radius:12px; padding:14px 18px; min-width:110px; }
.stat .v { font-size:24px; font-weight:700; } .stat .l { font-size:12px; color:var(--muted); }
section { margin-top:8px; }
svg { width:100%; height:auto; max-width:760px; display:block; background:var(--card); border-radius:12px; padding:12px; }
.bar { fill:var(--amber); } .bar.full { fill:var(--green); }
.line { fill:none; stroke:var(--red); stroke-width:2.5; stroke-linejoin:round; } .dot { fill:var(--red); }
.grid { stroke:var(--grid); stroke-width:1; } .tick { fill:var(--muted); font-size:9px; }
ul { padding-left:20px; margin:6px 0; } li { margin:3px 0; }
.age { color:var(--muted); font-size:12px; }
.empty { color:var(--muted); font-style:italic; }
footer { margin-top:40px; color:var(--muted); font-size:12px; }
@media print { body { background:#fff; color:#000; } svg { background:#fff; } }
</style>
</head>
<body>
<h1>${behavior.emoji} ${esc(standup.name)}</h1>
<p class="sub">${rangeLabel} · ${formatRunDate(data.startDate)} – ${formatRunDate(data.endDate)}</p>
<div class="stats">${statCards}</div>
<section><h2>📊 Participation</h2>${participationSvg(data)}</section>
${standup.includeMood ? `<section><h2>😊 Mood</h2>${moodSvg(data)}</section>` : ""}
${blockerSection}
<section><h2>🔥 Streaks</h2>${streakList}</section>
<section><h2>🎉 Kudos</h2>${kudosList}</section>
<footer>Generated by <a href="https://github.com/briancorbin/sunup">sunup</a> — self-hosted async check-ins. This link expires 24h after it was created.</footer>
</body>
</html>`;
}
