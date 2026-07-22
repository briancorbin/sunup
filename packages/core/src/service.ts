import { computeStreak, streaksForResponders, type Deps } from "./cron";
import type { CheckinResponse, Standup, StandupKind } from "./types";
import { DEFAULT_STANDUP, blockerAgeDays, isBlocker, isSnoozed, kindBehavior, KIND_BEHAVIOR } from "./types";
import { buildDigest } from "./blocks/digest";
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
  "`/sunup config` — open the settings editor (or `/sunup config <field> <value>` for quick edits: `prompt HH:MM`, `digest HH:MM`, `days mon,tue,...`, `tz <IANA>`, `reminder <minutes>`, `mood on|off`, `name <text>`)",
  "`/sunup snooze <days>` / `/sunup snooze off` — pause your prompts (vacation mode)",
  "`/sunup export` — CSV of this channel's full check-in history (15-min link)",
  "`/sunup report [week|month|quarter]` — charted team report page (24h link; add `share` to post it to the channel)",
  "`/sundown …` — the evening checkout: same subcommands, sunset edition (what shipped, what carries over, wins)",
  "`/sunup remove` — delete this channel's check-in (asks for confirmation)",
  "`/sunup questions Q1 | Q2 | Q3` — set questions (last one is the blockers question)",
  "`/kudos @user <message>` — celebrate a teammate",
].join("\n");

/** `/<kind> setup [name]` — create a check-in of that kind for the channel and enroll the invoker. */
export async function handleSetup(deps: Deps, channelId: string, userId: string, name: string | undefined, kind: StandupKind): Promise<string> {
  const behavior = KIND_BEHAVIOR[kind];
  const existing = await deps.storage.getStandupByChannel(channelId, kind);
  if (existing) {
    return `This channel already has a ${kind} check-in (*${existing.name}*). Use \`/${kind} join\` or \`/${kind} config\`.`;
  }
  const tz = (await deps.slack.userTz(userId)) ?? "America/New_York";
  const standup = await deps.storage.createStandup({
    name: name?.trim() || behavior.defaultName,
    channelId,
    kind,
    questions: [...behavior.defaultQuestions],
    scheduleDays: [...DEFAULT_STANDUP.scheduleDays],
    promptTime: behavior.defaultPromptTime,
    digestTime: behavior.defaultDigestTime,
    timezone: tz,
    userTzPrompts: DEFAULT_STANDUP.userTzPrompts,
    reminderMinutes: DEFAULT_STANDUP.reminderMinutes,
    includeMood: behavior.defaultIncludeMood,
  });
  await deps.storage.addParticipant(standup.id, userId, tz);
  return [
    `${behavior.emoji} *${standup.name}* is set up for this channel!`,
    `Prompts weekdays at *${standup.promptTime}* (each person's local time), digest here at *${standup.digestTime}* ${tz}.`,
    "",
    `• Teammates join with \`/${kind} join\``,
    `• Tune it with \`/${kind} config\` and \`/${kind} questions\` (see \`/${kind} help\`)`,
    "• *Invite me to this channel* (`/invite @Sunup`) so I can post the digest",
  ].join("\n");
}

export async function handleJoin(deps: Deps, channelId: string, userId: string, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`;
  const tz = await deps.slack.userTz(userId);
  await deps.storage.addParticipant(standup.id, userId, tz);
  return `You're in! You'll be prompted for *${standup.name}* at ${standup.promptTime}${standup.userTzPrompts ? " your time" : ` ${standup.timezone}`}.`;
}

export async function handleLeave(deps: Deps, channelId: string, userId: string, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel.`;
  await deps.storage.removeParticipant(standup.id, userId);
  return `You've left *${standup.name}*. Come back any time with \`/${kind} join\`.`;
}

export async function handleStatus(deps: Deps, channelId: string, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`;
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

/** `/<kind> remove [confirm]` — deleting cascades all runs, responses, and participants. */
export async function handleRemove(deps: Deps, channelId: string, confirmed: boolean, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel — nothing to remove.`;
  if (!confirmed) {
    const participants = await deps.storage.listParticipants(standup.id);
    return [
      `⚠️ This will permanently delete *${standup.name}* — its ${participants.length} participant${participants.length === 1 ? "" : "s"} and all its check-in history for this channel.`,
      `If you're sure, run \`/${kind} remove confirm\`.`,
      `(Just want out yourself? That's \`/${kind} leave\`. Want to pause it? \`/${kind} config days\` with fewer days.)`,
    ].join("\n");
  }
  await deps.storage.deleteStandup(standup.id);
  return `🗑️ *${standup.name}* removed. Prompts and digests stop immediately. \`/${kind} setup\` any time to start fresh.`;
}

/** `/<kind> config <field> <value>` */
export async function handleConfig(deps: Deps, channelId: string, field: string, value: string, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`;

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
  return `✅ Updated — here's the current setup:\n\n${await handleStatus(deps, channelId, kind)}`;
}

/** `/<kind> questions Q1 | Q2 | Q3` */
export async function handleQuestions(deps: Deps, channelId: string, raw: string, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`;
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
export async function resolveStandupForCheckin(deps: Deps, channelId: string, userId: string, kind: StandupKind): Promise<Standup | null> {
  const byChannel = await deps.storage.getStandupByChannel(channelId, kind);
  if (byChannel) return byChannel;
  const mine = (await deps.storage.listStandupsForUser(userId)).filter((s) => s.kind === kind);
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
  const run = await deps.storage.getRunById(response.runId);

  const behavior = kindBehavior(standup);

  // Blocker lifecycle: a blocker answer opens/confirms; an all-clear resolves.
  if (run && behavior.trackBlockers) {
    const blockerAnswer = (response.answers[standup.questions.length - 1] ?? "").trim();
    const open = await deps.storage.getOpenBlocker(standup.id, response.userId);
    if (isBlocker(blockerAnswer)) {
      if (open) await deps.storage.confirmBlocker(open.id, run.runDate, blockerAnswer);
      else await deps.storage.openBlocker(standup.id, response.userId, blockerAnswer, run.runDate);
    } else if (open) {
      await deps.storage.resolveBlocker(open.id, response.submittedAt);
    }
  }

  // Late check-in? Rebuild the already-posted digest in place.
  let lateNote = "";
  if (run?.digestPostedAt && run.digestTs) {
    try {
      const responses = await deps.storage.listResponses(run.id);
      const participants = (await deps.storage.listParticipants(standup.id)).filter((p) => !isSnoozed(p, run.runDate));
      const streaks = await streaksForResponders(deps, standup, responses, run.runDate);
      const openBlockers = await deps.storage.listOpenBlockers(standup.id);
      const digest = buildDigest(standup, run, responses, participants, streaks, openBlockers);
      await deps.slack.updateMessage(standup.channelId, run.digestTs, digest.text, digest.blocks);
      lateNote = " Today's digest already went out — I've updated it to include you.";
    } catch (err) {
      console.error("sunup: late digest update failed", err);
    }
  }

  const history = await deps.storage.listUserRunHistory(standup.id, response.userId, 30);
  const streak = computeStreak(history, run?.runDate ?? "");
  const streakNote = behavior.celebrateStreaks && streak >= 2 ? `  🔥 That's a *${streak}-day streak*.` : "";
  const dm = await deps.slack.openDm(response.userId);
  await deps.slack.postMessage(
    dm,
    `✅ Check-in recorded.${lateNote || ` The digest posts in <#${standup.channelId}> at ${standup.digestTime} ${standup.timezone}.`}${streakNote}`,
  );
}

/** Handle the Resolved / Still blocked buttons on the morning follow-up. Returns the reply text. */
export async function handleBlockerAction(deps: Deps, blockerId: number, resolved: boolean, now: Date): Promise<string> {
  const blocker = await deps.storage.getBlockerById(blockerId);
  if (!blocker) return "Hm, I can't find that blocker anymore.";
  if (blocker.resolvedAt) return "Already marked resolved — nice. ✅";
  if (resolved) {
    await deps.storage.resolveBlocker(blocker.id, now.toISOString());
    const days = blockerAgeDays(blocker, now.toISOString().slice(0, 10));
    return days > 1 ? `🎉 Resolved after ${days} days — great news!` : "🎉 Marked resolved — great news!";
  }
  const standup = await deps.storage.getStandup(blocker.standupId);
  const date = standup ? localParts(now, standup.timezone).date : blocker.lastConfirmedDate;
  await deps.storage.confirmBlocker(blocker.id, date);
  return "😤 Noted — it stays on the board until it's resolved. Hang in there.";
}

/** `/<kind> snooze <days|off>` — pause the invoker's prompts for this channel's standup. */
export async function handleSnooze(deps: Deps, channelId: string, userId: string, arg: string, now: Date, kind: StandupKind): Promise<string> {
  const standup = await deps.storage.getStandupByChannel(channelId, kind);
  if (!standup) return `No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`;
  const participants = await deps.storage.listParticipants(standup.id);
  if (!participants.some((p) => p.userId === userId)) return `You're not part of this check-in — \`/${kind} join\` first.`;

  if (arg === "off" || arg === "resume") {
    await deps.storage.setSnooze(standup.id, userId, null);
    return `☀️ Welcome back! Prompts for *${standup.name}* resume on the next scheduled day.`;
  }
  const days = Number(arg);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    return "Usage: `/sunup snooze <days>` (e.g. `/sunup snooze 5`) or `/sunup snooze off`.";
  }
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const untilDate = localParts(until, standup.timezone).date;
  await deps.storage.setSnooze(standup.id, userId, untilDate);
  return `😴 Snoozed — no *${standup.name}* prompts through *${untilDate}*, and you won't show as "waiting on" in digests. \`/sunup snooze off\` to come back early.`;
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
    const streak = computeStreak(history, anchor.date);
    const participants = await deps.storage.listParticipants(standup.id);
    const recentRuns = (await deps.storage.listRecentRuns(standup.id, 7)).map((r) => ({
      runDate: r.runDate,
      responseCount: r.responseCount,
    }));
    // Blocker board — open ones with age first, then recently resolved wins.
    const blockers = !kindBehavior(standup).trackBlockers
      ? []
      : [
      ...(await deps.storage.listOpenBlockers(standup.id)).map((b) => ({
        userId: b.userId,
        text: b.text.split("\n")[0] ?? "",
        status: "open" as const,
        ageDays: blockerAgeDays(b, anchor.date),
      })),
      ...(await deps.storage.listResolvedBlockers(standup.id, 3)).map((b) => ({
        userId: b.userId,
        text: b.text.split("\n")[0] ?? "",
        status: "resolved" as const,
        ageDays: 0,
      })),
    ];
    stats.push({ standup, respondedToday, runToday, streak, recentRuns, teamSize: participants.length, blockers });
  }
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const leaderboard = await deps.storage.kudosLeaderboard(since, 10);

  // Slack renders mentions of unresolvable users (departed, demo) as empty
  // pills in App Home — verify each id once and fall back to visible text.
  const mentionIds = new Set<string>([...leaderboard.map((e) => e.userId), ...stats.flatMap((s) => s.blockers.map((b) => b.userId))]);
  const resolvable = new Set<string>();
  await Promise.all(
    [...mentionIds].map(async (id) => {
      if ((await deps.slack.userLabel(id)) != null) resolvable.add(id);
    }),
  );
  const mention = (id: string) => (resolvable.has(id) ? `<@${id}>` : `\`${id}\``);

  await deps.slack.publishHome(userId, buildHomeView(userId, stats, leaderboard, mention));
}
