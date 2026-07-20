import type { Deps } from "./cron";
import type { CheckinResponse, Standup } from "./types";
import { DEFAULT_QUESTIONS, DEFAULT_STANDUP } from "./types";
import { isValidTimezone, localParts, parseHM } from "./time";
import { buildCheckinModal, type CheckinModalMetadata } from "./blocks/checkin-modal";
import { buildHomeView, type HomeStandupStats } from "./blocks/home";
import { buildKudosMessage } from "./blocks/kudos";

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const HELP_TEXT = [
  "*☀️ Sunup commands*",
  "`/sunup` — submit (or edit) today's check-in",
  "`/sunup setup [name]` — create a check-in for this channel",
  "`/sunup join` / `/sunup leave` — manage your participation",
  "`/sunup status` — show this channel's check-in config",
  "`/sunup config <field> <value>` — fields: `prompt HH:MM`, `digest HH:MM`, `days mon,tue,...`, `tz <IANA>`, `reminder <minutes>`, `mood on|off`, `name <text>`",
  "`/sunup remove` — delete this channel's check-in (asks for confirmation)",
  "`/sunup questions Q1 | Q2 | Q3` — set questions (last one is the blockers question)",
  "`/kudos @user <message>` — celebrate a teammate",
].join("\n");

/** `/sunup setup [name]` — create a standup for the channel and enroll the invoker. */
export async function handleSetup(deps: Deps, channelId: string, userId: string, name: string | undefined): Promise<string> {
  const existing = await deps.storage.getStandupByChannel(channelId);
  if (existing) {
    return `This channel already has a check-in (*${existing.name}*). Use \`/sunup join\` or \`/sunup config\`.`;
  }
  const tz = (await deps.slack.userTz(userId)) ?? "America/New_York";
  const standup = await deps.storage.createStandup({
    name: name?.trim() || "Daily Check-in",
    channelId,
    questions: [...DEFAULT_QUESTIONS],
    scheduleDays: [...DEFAULT_STANDUP.scheduleDays],
    promptTime: DEFAULT_STANDUP.promptTime,
    digestTime: DEFAULT_STANDUP.digestTime,
    timezone: tz,
    userTzPrompts: DEFAULT_STANDUP.userTzPrompts,
    reminderMinutes: DEFAULT_STANDUP.reminderMinutes,
    includeMood: DEFAULT_STANDUP.includeMood,
  });
  await deps.storage.addParticipant(standup.id, userId, tz);
  return [
    `☀️ *${standup.name}* is set up for this channel!`,
    `Prompts weekdays at *${standup.promptTime}* (each person's local time), digest here at *${standup.digestTime}* ${tz}.`,
    "",
    "• Teammates join with `/sunup join`",
    "• Tune it with `/sunup config` and `/sunup questions` (see `/sunup help`)",
    "• *Invite me to this channel* (`/invite @Sunup`) so I can post the digest",
  ].join("\n");
}

export async function handleJoin(deps: Deps, channelId: string, userId: string): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel yet — create one with `/sunup setup`.";
  const tz = await deps.slack.userTz(userId);
  await deps.storage.addParticipant(standup.id, userId, tz);
  return `You're in! You'll be prompted for *${standup.name}* at ${standup.promptTime}${standup.userTzPrompts ? " your time" : ` ${standup.timezone}`}.`;
}

export async function handleLeave(deps: Deps, channelId: string, userId: string): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel.";
  await deps.storage.removeParticipant(standup.id, userId);
  return `You've left *${standup.name}*. Come back any time with \`/sunup join\`.`;
}

export async function handleStatus(deps: Deps, channelId: string): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel yet — create one with `/sunup setup`.";
  const participants = await deps.storage.listParticipants(standup.id);
  return [
    `*${standup.name}*`,
    `• Days: ${standup.scheduleDays.map((d) => DAY_LABELS[d]).join(", ")}`,
    `• Prompt: ${standup.promptTime} ${standup.userTzPrompts ? "(each participant's local time)" : standup.timezone}`,
    `• Digest: ${standup.digestTime} ${standup.timezone}`,
    `• Reminder: ${standup.reminderMinutes > 0 ? `${standup.reminderMinutes} min before digest` : "off"}`,
    `• Mood tracking: ${standup.includeMood ? "on" : "off"}`,
    `• Questions:\n${standup.questions.map((q) => `    ${q}`).join("\n")}`,
    `• Participants (${participants.length}): ${participants.map((p) => `<@${p.userId}>`).join(", ") || "none"}`,
  ].join("\n");
}

/** `/sunup remove [confirm]` — deleting cascades all runs, responses, and participants. */
export async function handleRemove(deps: Deps, channelId: string, confirmed: boolean): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel — nothing to remove.";
  if (!confirmed) {
    const participants = await deps.storage.listParticipants(standup.id);
    return [
      `⚠️ This will permanently delete *${standup.name}* — its ${participants.length} participant${participants.length === 1 ? "" : "s"} and all check-in history for this channel.`,
      "If you're sure, run `/sunup remove confirm`.",
      "(Just want out yourself? That's `/sunup leave`. Want to pause it? `/sunup config days` with fewer days.)",
    ].join("\n");
  }
  await deps.storage.deleteStandup(standup.id);
  return `🗑️ *${standup.name}* removed. Prompts and digests for this channel stop immediately. \`/sunup setup\` any time to start fresh.`;
}

/** `/sunup config <field> <value>` */
export async function handleConfig(deps: Deps, channelId: string, field: string, value: string): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel yet — create one with `/sunup setup`.";

  switch (field) {
    case "prompt":
    case "digest": {
      if (parseHM(value) == null) return `\`${value}\` isn't a valid time — use 24h \`HH:MM\`.`;
      if (field === "prompt") standup.promptTime = value;
      else standup.digestTime = value;
      break;
    }
    case "days": {
      const days = value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((d) => DAY_NAMES[d.slice(0, 3).toLowerCase()]);
      if (days.length === 0 || days.some((d) => d === undefined)) {
        return "Couldn't parse days — try `mon,tue,wed,thu,fri`.";
      }
      standup.scheduleDays = [...new Set(days as number[])].sort();
      break;
    }
    case "tz": {
      if (!isValidTimezone(value)) return `\`${value}\` isn't a valid IANA timezone (e.g. \`America/New_York\`).`;
      standup.timezone = value;
      break;
    }
    case "reminder": {
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 0) return "Reminder must be a number of minutes (0 to disable).";
      standup.reminderMinutes = minutes;
      break;
    }
    case "mood": {
      if (value !== "on" && value !== "off") return "Use `mood on` or `mood off`.";
      standup.includeMood = value === "on";
      break;
    }
    case "name": {
      if (!value.trim()) return "Name can't be empty.";
      standup.name = value.trim();
      break;
    }
    default:
      return `Unknown field \`${field}\`.\n${HELP_TEXT}`;
  }
  await deps.storage.updateStandup(standup);
  return `✅ Updated — here's the current setup:\n\n${await handleStatus(deps, channelId)}`;
}

/** `/sunup questions Q1 | Q2 | Q3` */
export async function handleQuestions(deps: Deps, channelId: string, raw: string): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId);
  if (!standup) return "No check-in in this channel yet — create one with `/sunup setup`.";
  const questions = raw
    .split("|")
    .map((q) => q.trim())
    .filter(Boolean);
  if (questions.length === 0) return "Give me at least one question, separated by `|`.";
  standup.questions = questions;
  await deps.storage.updateStandup(standup);
  return `✅ Questions updated (the last one is treated as the blockers question):\n${questions.map((q) => `• ${q}`).join("\n")}`;
}

/**
 * Resolve which standup a user means when they run `/sunup` bare: the current
 * channel's standup if it has one, else their only standup, else null.
 */
export async function resolveStandupForCheckin(deps: Deps, channelId: string, userId: string): Promise<Standup | null> {
  const byChannel = await deps.storage.getStandupByChannel(channelId);
  if (byChannel) return byChannel;
  const mine = await deps.storage.listStandupsForUser(userId);
  return mine.length === 1 ? (mine[0] ?? null) : null;
}

/** Open the check-in modal for a standup's current run. */
export async function openCheckinModal(deps: Deps, triggerId: string, standup: Standup, now: Date, userId: string): Promise<void> {
  const anchor = localParts(now, standup.timezone);
  const run = await deps.storage.getOrCreateRun(standup.id, anchor.date);
  const existing = await deps.storage.getResponse(run.id, userId);
  await deps.slack.openView(triggerId, buildCheckinModal(standup, run, existing));
}

/** Open the modal from the DM button, which carries the run id. */
export async function openCheckinModalForRun(deps: Deps, triggerId: string, runId: number, userId: string): Promise<void> {
  const run = await deps.storage.getRunById(runId);
  if (!run) return;
  const standup = await deps.storage.getStandup(run.standupId);
  if (!standup) return;
  const existing = await deps.storage.getResponse(run.id, userId);
  await deps.slack.openView(triggerId, buildCheckinModal(standup, run, existing));
}

/** Parse Slack view_submission state values into a CheckinResponse. */
export function parseCheckinSubmission(
  standup: Standup,
  metadata: CheckinModalMetadata,
  userId: string,
  values: Record<string, Record<string, { value?: string | null; selected_option?: { value: string } | null }>>,
  nowIso: string,
): CheckinResponse {
  const answers = standup.questions.map((_q, i) => values[`q_${i}`]?.answer?.value?.trim() ?? "");
  const moodRaw = values.mood?.answer?.selected_option?.value;
  return {
    runId: metadata.runId,
    userId,
    answers,
    mood: moodRaw ? Number(moodRaw) : null,
    submittedAt: nowIso,
  };
}

export async function handleCheckinSubmission(deps: Deps, standup: Standup, response: CheckinResponse): Promise<void> {
  await deps.storage.upsertResponse(response);
  const dm = await deps.slack.openDm(response.userId);
  await deps.slack.postMessage(dm, `✅ Check-in recorded. The digest posts in <#${standup.channelId}> at ${standup.digestTime} ${standup.timezone}.`);
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

/** `/kudos @user message` → posts publicly in the channel. Returns an error string for the invoker, or null on success. */
export async function handleKudos(deps: Deps, fromUser: string, channelId: string, text: string, nowIso: string): Promise<string | null> {
  const match = MENTION_RE.exec(text);
  const message = text.replace(MENTION_RE, "").trim();
  if (!match || !message) return "Usage: `/kudos @teammate for shipping the thing`";
  const toUser = match[1]!;
  if (toUser === fromUser) return "Self-kudos are a bold move, but no. 😄";
  await deps.storage.addKudos({ fromUser, toUser, message, channelId, createdAt: nowIso });
  const msg = buildKudosMessage(fromUser, toUser, message);
  await deps.slack.postMessage(channelId, msg.text, msg.blocks);
  return null;
}

/** Assemble the App Home dashboard for a user. */
export async function publishHome(deps: Deps, userId: string, now: Date): Promise<void> {
  const standups = await deps.storage.listStandupsForUser(userId);
  const stats: HomeStandupStats[] = [];
  for (const standup of standups) {
    const anchor = localParts(now, standup.timezone);
    const runToday = standup.scheduleDays.includes(anchor.weekday);
    const todayRun = runToday ? await deps.storage.getRun(standup.id, anchor.date) : null;
    const respondedToday = todayRun ? (await deps.storage.getResponse(todayRun.id, userId)) != null : false;
    const history = await deps.storage.listUserRunHistory(standup.id, userId, 30);
    let streak = 0;
    for (const h of history) {
      // Today's still-open run shouldn't break a streak before the digest.
      if (h.runDate === anchor.date && !h.responded) continue;
      if (!h.responded) break;
      streak++;
    }
    const participants = await deps.storage.listParticipants(standup.id);
    const recentRuns = (await deps.storage.listRecentRuns(standup.id, 7)).map((r) => ({
      runDate: r.runDate,
      responseCount: r.responseCount,
    }));
    stats.push({ standup, respondedToday, runToday, streak, recentRuns, teamSize: participants.length });
  }
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const leaderboard = await deps.storage.kudosLeaderboard(since, 10);
  await deps.slack.publishHome(userId, buildHomeView(userId, stats, leaderboard));
}
