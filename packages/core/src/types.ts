/** A recurring async check-in attached to one Slack channel. */
export interface Standup {
  id: number;
  name: string;
  channelId: string;
  /** Ordered question prompts. By convention the last question is the blockers question. */
  questions: string[];
  /** Days the check-in runs: 0 = Sunday … 6 = Saturday. */
  scheduleDays: number[];
  /** "HH:MM" 24h — when participants are prompted. */
  promptTime: string;
  /** "HH:MM" 24h — when the digest posts to the channel (in the standup timezone). */
  digestTime: string;
  /** IANA timezone anchoring the standup's calendar day and digest time. */
  timezone: string;
  /** Prompt each participant at promptTime in their own timezone (vs the standup timezone). */
  userTzPrompts: boolean;
  /** Minutes before digestTime to nudge non-responders. 0 disables reminders. */
  reminderMinutes: number;
  includeMood: boolean;
}

export interface Participant {
  standupId: number;
  userId: string;
  /** Cached Slack timezone (IANA), refreshed opportunistically. */
  tz: string | null;
  /** "YYYY-MM-DD" (standup tz): skip prompts/reminders/waiting-on through this date. */
  snoozedUntil: string | null;
}

/** True when the participant is snoozed on the given run date. */
export function isSnoozed(p: Participant, runDate: string): boolean {
  return p.snoozedUntil != null && p.snoozedUntil >= runDate;
}

/** One occurrence of a standup on a given calendar day. */
export interface Run {
  id: number;
  standupId: number;
  /** "YYYY-MM-DD" in the standup timezone. */
  runDate: string;
  digestPostedAt: string | null;
  /** Slack ts of the posted digest message, for in-place updates. */
  digestTs: string | null;
}

/** Per-user delivery state for a run. */
export interface RunParticipant {
  runId: number;
  userId: string;
  promptedAt: string | null;
  remindedAt: string | null;
}

export interface CheckinResponse {
  runId: number;
  userId: string;
  /** Same order as Standup.questions. */
  answers: string[];
  /** 1–5, present when the standup has mood tracking on. */
  mood: number | null;
  submittedAt: string;
}

export interface Kudos {
  fromUser: string;
  toUser: string;
  message: string;
  channelId: string;
  createdAt: string;
}

export interface LeaderboardEntry {
  userId: string;
  count: number;
}

/** A run with its response count, for participation stats. */
export interface RunSummary {
  runDate: string;
  responseCount: number;
  digestPostedAt: string | null;
}

export const DEFAULT_QUESTIONS = [
  "What did you get done since your last check-in?",
  "What are you focusing on today?",
  "Anything blocking you?",
];

export const DEFAULT_STANDUP = {
  scheduleDays: [1, 2, 3, 4, 5],
  promptTime: "09:00",
  digestTime: "11:30",
  userTzPrompts: true,
  reminderMinutes: 60,
  includeMood: true,
} as const;

const NON_BLOCKERS = new Set(["", "no", "none", "nope", "nothing", "n/a", "na", "-", "nada", "no blockers", "all good", "nope!", "none!"]);

/** True when a blockers answer actually contains a blocker. */
export function isBlocker(answer: string): boolean {
  return !NON_BLOCKERS.has(answer.trim().toLowerCase());
}
