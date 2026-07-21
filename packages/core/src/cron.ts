import type { Storage } from "./ports";
import { SlackClient } from "./slack";
import { isSnoozed, type CheckinResponse, type Participant, type Standup } from "./types";
import { addDays, localParts, parseHM } from "./time";
import { buildDigest } from "./blocks/digest";
import { buildPromptMessage } from "./blocks/checkin-modal";
import { buildWeeklyRetro } from "./blocks/retro";

export interface Deps {
  storage: Storage;
  slack: SlackClient;
  /** Delete check-in/kudos data older than this many days. Unset = keep forever. */
  retentionDays?: number;
}

/**
 * Consecutive most-recent runs with a response, given most-recent-first
 * history. Today's still-open run doesn't break the streak before the digest.
 */
export function computeStreak(history: Array<{ runDate: string; responded: boolean }>, todayDate: string): number {
  let streak = 0;
  for (const h of history) {
    if (h.runDate === todayDate && !h.responded) continue;
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
function promptTz(standup: Standup, participant: Participant): string {
  return standup.userTzPrompts && participant.tz ? participant.tz : standup.timezone;
}

/**
 * Pure: which participants are due a prompt at `now`, given the standup's
 * anchor date. A participant is due once their local clock passes promptTime
 * on the anchor calendar date.
 */
export function computeDuePrompts(now: Date, standup: Standup, participants: Participant[], anchorDate: string): Participant[] {
  const promptM = parseHM(standup.promptTime);
  if (promptM == null) return [];
  return participants.filter((p) => {
    if (isSnoozed(p, anchorDate)) return false;
    const local = localParts(now, promptTz(standup, p));
    return local.date === anchorDate && local.minutes >= promptM;
  });
}

/**
 * One scheduler tick. Called by the platform trigger (Cloudflare cron today,
 * anything else tomorrow) — idempotent, so overlapping/repeated ticks are safe:
 * every send is guarded by a persisted marker (promptedAt / remindedAt /
 * digestPostedAt).
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
  if (!standup.scheduleDays.includes(anchor.weekday)) return;

  const digestM = parseHM(standup.digestTime);
  const participants = await deps.storage.listParticipants(standup.id);
  const duePrompts = computeDuePrompts(now, standup, participants, anchor.date);
  const digestDue = digestM != null && anchor.minutes >= digestM;
  const remindersDue =
    digestM != null && standup.reminderMinutes > 0 && anchor.minutes >= digestM - standup.reminderMinutes && !digestDue;

  if (duePrompts.length === 0 && !digestDue && !remindersDue) return;

  const run = await deps.storage.getOrCreateRun(standup.id, anchor.date);
  const nowIso = now.toISOString();
  const runParticipants = await deps.storage.listRunParticipants(run.id);
  const responses = await deps.storage.listResponses(run.id);
  const responded = new Set(responses.map((r) => r.userId));
  const state = new Map(runParticipants.map((rp) => [rp.userId, rp]));
  const openBlockers = await deps.storage.listOpenBlockers(standup.id);
  // Follow up on blockers carried over from a previous day, not today's.
  const carriedBlockerByUser = new Map(openBlockers.filter((b) => b.openedDate < anchor.date).map((b) => [b.userId, b]));

  // A failed DM (deactivated user, demo data, revoked scope) must not abort the
  // standup's tick — and we mark the user handled either way: prompt-once
  // semantics beat retrying a dead recipient every tick.
  const sendDm = async (userId: string, isReminder: boolean): Promise<void> => {
    try {
      const dm = await deps.slack.openDm(userId);
      const msg = buildPromptMessage(
        standup,
        run.id,
        isReminder,
        isReminder ? undefined : carriedBlockerByUser.get(userId),
        anchor.date,
      );
      await deps.slack.postMessage(dm, msg.text, msg.blocks);
    } catch (err) {
      console.error(`sunup cron: ${isReminder ? "reminder" : "prompt"} DM to ${userId} failed`, err);
    }
  };

  // Initial prompts
  for (const p of duePrompts) {
    if (state.get(p.userId)?.promptedAt || responded.has(p.userId)) continue;
    await sendDm(p.userId, false);
    await deps.storage.markPrompted(run.id, p.userId, nowIso);
  }

  // Reminder nudges
  if (remindersDue) {
    for (const p of participants) {
      const rp = state.get(p.userId);
      if (!rp?.promptedAt || rp.remindedAt || responded.has(p.userId)) continue;
      await sendDm(p.userId, true);
      await deps.storage.markReminded(run.id, p.userId, nowIso);
    }
  }

  // Digest — snoozed participants don't count as "waiting on"
  if (digestDue) {
    let digestJustPosted = false;
    if (!run.digestPostedAt) {
      const active = participants.filter((p) => !isSnoozed(p, anchor.date));
      const streaks = await streaksForResponders(deps, standup, responses, anchor.date);
      const digest = buildDigest(standup, run, responses, active, streaks, openBlockers);
      const posted = await deps.slack.postMessage(standup.channelId, digest.text, digest.blocks);
      await deps.storage.markDigestPosted(run.id, nowIso, posted.ts ?? null);
      digestJustPosted = true;
    }

    // Weekly retro: after the daily digest on the week's last scheduled day.
    if (
      (digestJustPosted || run.digestPostedAt) &&
      anchor.weekday === lastScheduledDay(standup.scheduleDays) &&
      standup.lastRetroDate !== anchor.date
    ) {
      try {
        await postWeeklyRetro(deps, standup, participants, anchor.date);
        await deps.storage.setLastRetroDate(standup.id, anchor.date);
      } catch (err) {
        console.error(`sunup cron: weekly retro for standup ${standup.id} failed`, err);
      }
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
  const weekKudos = await deps.storage.kudosLeaderboard(`${weekStart}T00:00:00.000Z`, 50);
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
