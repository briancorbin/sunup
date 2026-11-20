import type { Storage } from "./ports";
import { isPermanentSlackError, type SlackPort } from "./slack";
import { isSnoozed, kindBehavior, type Blocker, type CheckinResponse, type Participant, type Run, type Standup } from "./types";
import { addDays, localParts, parseHM, weekdayOf } from "./time";
import { buildDigest } from "./blocks/digest";
import { buildPromptMessage } from "./blocks/checkin-modal";
import { buildWeeklyRetro } from "./blocks/retro";

export interface Deps {
  storage: Storage;
  slack: SlackPort;
  /** Delete check-in/kudos/resolved-blocker data older than this many days. Unset = keep forever. */
  retentionDays?: number;
}

/**
 * Shortest reminder lead time we accept. The scheduler ticks every 10 minutes
 * (Cloudflare cron; the Node adapter defaults to 5), so a reminder window
 * narrower than a tick could fall between two ticks and never fire.
 */
export const MIN_REMINDER_MINUTES = 10;

/**
 * Consecutive most-recent runs with a response, given most-recent-first
 * history. Today's still-open run doesn't break the streak before the digest,
 * and neither do runs dated ahead of today — participants in a timezone ahead
 * of the channel create tomorrow's run before the channel gets there.
 */
export function computeStreak(history: Array<{ runDate: string; responded: boolean }>, todayDate: string): number {
  let streak = 0;
  for (const h of history) {
    if (h.runDate >= todayDate && !h.responded) continue;
    if (!h.responded) break;
    streak++;
  }
  return streak;
}

/** Current streak per responder — used to decorate digests with milestones. */
export async function streaksForResponders(
  deps: Deps,
  standup: Standup,
  responses: CheckinResponse[],
  todayDate: string,
): Promise<Record<string, number>> {
  const streaks: Record<string, number> = {};
  for (const r of responses) {
    const history = await deps.storage.listUserRunHistory(standup.id, r.userId, 60);
    streaks[r.userId] = computeStreak(history, todayDate);
  }
  return streaks;
}

/** The standup's last scheduled day of the week (Monday-start week, so Sunday is last). */
export function lastScheduledDay(scheduleDays: number[]): number {
  return [...scheduleDays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).at(-1) ?? 5;
}

/** The timezone a participant is prompted in. */
export function promptTz(standup: Standup, participant: Participant): string {
  return standup.userTzPrompts && participant.tz ? participant.tz : standup.timezone;
}

/** The first scheduled "YYYY-MM-DD" strictly after `date`. */
export function nextScheduledDate(date: string, scheduleDays: number[]): string {
  let d = date;
  for (let i = 0; i < 7; i++) {
    d = addDays(d, 1);
    if (scheduleDays.includes(weekdayOf(d))) return d;
  }
  return d;
}

export interface DuePrompt {
  participant: Participant;
  /** The participant's own local calendar date at `now`. */
  localDate: string;
}

/**
 * Pure: which participants are due a prompt at `now`, judged entirely by
 * their OWN clock — their local weekday is a scheduled day, their local time
 * has passed promptTime, and the scheduler hasn't handled them yet for that
 * local day. The channel's calendar date plays no part: a Tokyo member of a
 * Los Angeles channel is due on Tokyo's Monday morning, which is still Sunday
 * afternoon in the channel.
 */
export function computeDuePrompts(now: Date, standup: Standup, participants: Participant[]): DuePrompt[] {
  const promptM = parseHM(standup.promptTime);
  if (promptM == null) return [];
  return participants.flatMap((p) => {
    const local = localParts(now, promptTz(standup, p));
    if (!standup.scheduleDays.includes(local.weekday)) return [];
    if (local.minutes < promptM) return [];
    if (p.lastPromptDate != null && p.lastPromptDate >= local.date) return [];
    return [{ participant: p, localDate: local.date }];
  });
}

/**
 * Map a participant's local date onto the channel run their check-in belongs
 * to. When the channel's day is AHEAD of theirs (Tokyo channel, LA member),
 * the run for their local date may already have its digest out — so move
 * forward to the next scheduled run that hasn't. Never moves past the
 * channel's own current date: a same-day check-in after the digest is a late
 * check-in to today's run, not an early one for tomorrow.
 */
export async function advancePastDigested(storage: Storage, standup: Standup, date: string, anchorDate: string): Promise<string> {
  for (let i = 0; i < 7 && date < anchorDate; i++) {
    const run = await storage.getRun(standup.id, date);
    if (!run?.digestPostedAt) break;
    date = nextScheduledDate(date, standup.scheduleDays);
  }
  return date;
}

/**
 * One scheduler tick. Called by the platform trigger (Cloudflare cron,
 * setInterval on Node, anything else tomorrow) — idempotent, so overlapping
 * or repeated ticks are safe: every send is guarded by a persisted marker
 * (lastPromptDate / promptedAt / remindedAt / digestPostedAt).
 */
export async function runCron(deps: Deps, now: Date): Promise<void> {
  const standups = await deps.storage.listStandups();
  for (const standup of standups) {
    try {
      await tickStandup(deps, standup, now);
    } catch (err) {
      console.error(`sunup cron: standup ${standup.id} (${standup.name}) failed`, err);
    }
  }
  if (deps.retentionDays && deps.retentionDays > 0) {
    await deps.storage.purgeOlderThan(deps.retentionDays, now.toISOString());
  }
}

async function tickStandup(deps: Deps, standup: Standup, now: Date): Promise<void> {
  const anchor = localParts(now, standup.timezone);
  const nowIso = now.toISOString();
  const participants = await deps.storage.listParticipants(standup.id);

  // 1. Prompts — by each participant's own clock, every day of the week.
  const due = computeDuePrompts(now, standup, participants);
  if (due.length > 0) await sendPrompts(deps, standup, due, anchor.date, nowIso);

  // 2. Reminders and the digest — anchored to the channel's calendar day.
  if (!standup.scheduleDays.includes(anchor.weekday)) return;
  const digestM = parseHM(standup.digestTime);
  if (digestM == null) return;
  const digestDue = anchor.minutes >= digestM;
  const remindersDue = standup.reminderMinutes > 0 && anchor.minutes >= digestM - standup.reminderMinutes && !digestDue;
  if (!digestDue && !remindersDue) return;

  const run = await deps.storage.getOrCreateRun(standup.id, anchor.date);
  if (remindersDue) await sendReminders(deps, standup, run, participants, anchor.date, nowIso);
  if (digestDue) await postDigest(deps, standup, run, participants, anchor.date, anchor.weekday, nowIso);
}

type SendOutcome = "sent" | "failed" | "transient";

/**
 * DM a participant. A permanent Slack "no" (deactivated user, demo data,
 * revoked scope) is logged and reported as failed so the caller marks the
 * user handled — prompt-once semantics beat retrying a dead recipient every
 * tick. A transient failure (429, 5xx, network) is NOT marked, so the next
 * tick retries instead of silently dropping the prompt.
 */
async function sendDm(deps: Deps, userId: string, what: string, msg: { text: string; blocks: unknown[] }): Promise<SendOutcome> {
  try {
    const dm = await deps.slack.openDm(userId);
    await deps.slack.postMessage(dm, msg.text, msg.blocks);
    return "sent";
  } catch (err) {
    if (isPermanentSlackError(err)) {
      console.error(`sunup cron: ${what} DM to ${userId} failed permanently`, err);
      return "failed";
    }
    console.warn(`sunup cron: ${what} DM to ${userId} failed, will retry next tick`, err);
    return "transient";
  }
}

async function sendPrompts(deps: Deps, standup: Standup, due: DuePrompt[], anchorDate: string, nowIso: string): Promise<void> {
  const behavior = kindBehavior(standup);
  const openBlockers = behavior.trackBlockers ? await deps.storage.listOpenBlockers(standup.id) : [];
  // Per target run: who's already prompted or has already answered.
  const runs = new Map<string, { run: Run; prompted: Set<string>; responded: Set<string> }>();

  for (const { participant: p, localDate } of due) {
    const runDate = await advancePastDigested(deps.storage, standup, localDate, anchorDate);
    const handled = () => deps.storage.setParticipantPromptDate(standup.id, p.userId, localDate);

    if (isSnoozed(p, runDate)) {
      await handled();
      continue;
    }

    let ctx = runs.get(runDate);
    if (!ctx) {
      const run = await deps.storage.getOrCreateRun(standup.id, runDate);
      const rps = await deps.storage.listRunParticipants(run.id);
      const responses = await deps.storage.listResponses(run.id);
      ctx = {
        run,
        prompted: new Set(rps.filter((rp) => rp.promptedAt).map((rp) => rp.userId)),
        responded: new Set(responses.map((r) => r.userId)),
      };
      runs.set(runDate, ctx);
    }
    if (ctx.prompted.has(p.userId) || ctx.responded.has(p.userId)) {
      await handled();
      continue;
    }

    // Follow up on a blocker carried over from an earlier run, not this one's.
    const carried: Blocker | undefined = openBlockers.find((b) => b.userId === p.userId && b.openedDate < runDate);
    const outcome = await sendDm(deps, p.userId, "prompt", buildPromptMessage(standup, ctx.run.id, false, carried, runDate));
    if (outcome === "transient") continue;
    await deps.storage.markPrompted(ctx.run.id, p.userId, nowIso);
    await handled();
    ctx.prompted.add(p.userId);
  }
}

async function sendReminders(
  deps: Deps,
  standup: Standup,
  run: Run,
  participants: Participant[],
  anchorDate: string,
  nowIso: string,
): Promise<void> {
  const state = new Map((await deps.storage.listRunParticipants(run.id)).map((rp) => [rp.userId, rp]));
  const responded = new Set((await deps.storage.listResponses(run.id)).map((r) => r.userId));
  for (const p of participants) {
    if (isSnoozed(p, anchorDate)) continue;
    const rp = state.get(p.userId);
    if (!rp?.promptedAt || rp.remindedAt || responded.has(p.userId)) continue;
    const outcome = await sendDm(deps, p.userId, "reminder", buildPromptMessage(standup, run.id, true));
    if (outcome === "transient") continue;
    await deps.storage.markReminded(run.id, p.userId, nowIso);
  }
}

async function postDigest(
  deps: Deps,
  standup: Standup,
  run: Run,
  participants: Participant[],
  anchorDate: string,
  anchorWeekday: number,
  nowIso: string,
): Promise<void> {
  const behavior = kindBehavior(standup);
  let digestJustPosted = false;

  // Claim first, then post: two overlapping ticks can't both win the UPDATE.
  if (!run.digestPostedAt && (await deps.storage.claimDigest(run.id, nowIso))) {
    const active = participants.filter((p) => !isSnoozed(p, anchorDate));
    const openBlockers = behavior.trackBlockers ? await deps.storage.listOpenBlockers(standup.id) : [];
    const signature = (rs: CheckinResponse[]) =>
      rs
        .map((r) => `${r.userId}@${r.submittedAt}`)
        .sort()
        .join("|");
    const build = async (responses: CheckinResponse[]) => {
      const streaks = behavior.celebrateStreaks ? await streaksForResponders(deps, standup, responses, anchorDate) : {};
      return buildDigest(standup, run, responses, active, streaks, openBlockers);
    };

    let posted: { ts: string };
    const before = await deps.storage.listResponses(run.id);
    try {
      const digest = await build(before);
      posted = await deps.slack.postMessage(standup.channelId, digest.text, digest.blocks);
    } catch (err) {
      // Nothing went out — give the claim back so the next tick retries.
      await deps.storage.releaseDigestClaim(run.id);
      throw err;
    }
    await deps.storage.markDigestPosted(run.id, nowIso, posted.ts ?? null);
    digestJustPosted = true;

    // Anyone who submitted while we were posting saw digest_posted_at set but
    // no digest_ts yet, so their late-edit path couldn't update the message.
    // Re-read and fold them in.
    const after = await deps.storage.listResponses(run.id);
    if (posted.ts && signature(after) !== signature(before)) {
      const digest = await build(after);
      await deps.slack.updateMessage(standup.channelId, posted.ts, digest.text, digest.blocks);
    }
  }

  // Weekly retro: after the daily digest on the week's last scheduled day.
  if (
    behavior.weeklyRetro &&
    (digestJustPosted || run.digestPostedAt) &&
    anchorWeekday === lastScheduledDay(standup.scheduleDays) &&
    standup.lastRetroDate !== anchorDate
  ) {
    try {
      await postWeeklyRetro(deps, standup, participants, anchorDate);
      await deps.storage.setLastRetroDate(standup.id, anchorDate);
    } catch (err) {
      console.error(`sunup cron: weekly retro for standup ${standup.id} failed`, err);
    }
  }
}

async function postWeeklyRetro(deps: Deps, standup: Standup, participants: Participant[], weekEnd: string): Promise<void> {
  const weekStart = addDays(weekEnd, -6);
  const inWindow = (d: string) => d >= weekStart && d <= weekEnd;

  const runs = (await deps.storage.listRecentRuns(standup.id, 10)).filter((r) => inWindow(r.runDate)).reverse();
  const responses = (await deps.storage.listRecentResponses(standup.id, 200)).filter((r) => inWindow(r.runDate));
  const active = participants.filter((p) => !isSnoozed(p, weekEnd));
  const streaks = await streaksForResponders(
    deps,
    standup,
    // Unique users who responded this week.
    [...new Map(responses.map((r) => [r.response.userId, r.response])).values()],
    weekEnd,
  );
  // This channel's kudos only — the retro posts in the channel.
  const weekKudos = await deps.storage.kudosLeaderboard(`${weekStart}T00:00:00.000Z`, 50, standup.channelId);
  const kudosGiven = weekKudos.reduce((a, e) => a + e.count, 0);

  const retro = buildWeeklyRetro(standup, {
    weekStart,
    weekEnd,
    runs,
    responses,
    participants: active,
    streaks,
    kudosGiven,
    topKudos: weekKudos[0] ?? null,
  });
  await deps.slack.postMessage(standup.channelId, retro.text, retro.blocks);
}
