import type { Storage } from "./ports";
import { SlackClient } from "./slack";
import type { Participant, Standup } from "./types";
import { localParts, parseHM } from "./time";
import { buildDigest } from "./blocks/digest";
import { buildPromptMessage } from "./blocks/checkin-modal";

export interface Deps {
  storage: Storage;
  slack: SlackClient;
  /** Delete check-in/kudos data older than this many days. Unset = keep forever. */
  retentionDays?: number;
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

  // Initial prompts
  for (const p of duePrompts) {
    if (state.get(p.userId)?.promptedAt || responded.has(p.userId)) continue;
    const dm = await deps.slack.openDm(p.userId);
    const msg = buildPromptMessage(standup, run.id, false);
    await deps.slack.postMessage(dm, msg.text, msg.blocks);
    await deps.storage.markPrompted(run.id, p.userId, nowIso);
  }

  // Reminder nudges
  if (remindersDue) {
    for (const p of participants) {
      const rp = state.get(p.userId);
      if (!rp?.promptedAt || rp.remindedAt || responded.has(p.userId)) continue;
      const dm = await deps.slack.openDm(p.userId);
      const msg = buildPromptMessage(standup, run.id, true);
      await deps.slack.postMessage(dm, msg.text, msg.blocks);
      await deps.storage.markReminded(run.id, p.userId, nowIso);
    }
  }

  // Digest
  if (digestDue && !run.digestPostedAt) {
    const digest = buildDigest(standup, run, responses, participants);
    await deps.slack.postMessage(standup.channelId, digest.text, digest.blocks);
    await deps.storage.markDigestPosted(run.id, nowIso);
  }
}
