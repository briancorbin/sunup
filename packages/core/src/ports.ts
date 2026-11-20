import type {
  Blocker,
  CheckinResponse,
  Kudos,
  LeaderboardEntry,
  Participant,
  Run,
  RunParticipant,
  RunSummary,
  Standup,
  StandupKind,
} from "./types";

/**
 * Persistence port. `apps/cloudflare` implements this on D1; alternate
 * ecosystems implement it on whatever store they like (Postgres, SQLite, …).
 * Everything else in core depends only on this interface.
 */
export interface Storage {
  // standups
  listStandups(): Promise<Standup[]>;
  getStandup(id: number): Promise<Standup | null>;
  getStandupByChannel(channelId: string, kind: StandupKind): Promise<Standup | null>;
  createStandup(input: Omit<Standup, "id" | "lastRetroDate">): Promise<Standup>;
  updateStandup(standup: Standup): Promise<void>;
  deleteStandup(id: number): Promise<void>;
  setLastRetroDate(standupId: number, date: string): Promise<void>;

  // participants
  listParticipants(standupId: number): Promise<Participant[]>;
  listStandupsForUser(userId: string): Promise<Standup[]>;
  addParticipant(standupId: number, userId: string, tz: string | null): Promise<void>;
  removeParticipant(standupId: number, userId: string): Promise<void>;
  /** Refresh a user's cached timezone across every standup they're in. */
  setParticipantTz(userId: string, tz: string): Promise<void>;
  /** Record the participant's own local date the prompt scheduler last handled. */
  setParticipantPromptDate(standupId: number, userId: string, date: string): Promise<void>;
  /** null clears the snooze. */
  setSnooze(standupId: number, userId: string, until: string | null): Promise<void>;

  // runs
  getOrCreateRun(standupId: number, runDate: string): Promise<Run>;
  getRun(standupId: number, runDate: string): Promise<Run | null>;
  getRunById(runId: number): Promise<Run | null>;
  /**
   * Atomically claim the right to post a run's digest: sets digest_posted_at
   * only if it is still NULL. Returns true for the one caller that won — so
   * overlapping ticks can never double-post.
   */
  claimDigest(runId: number, at: string): Promise<boolean>;
  /** Undo a claim whose post failed, so the next tick retries. */
  releaseDigestClaim(runId: number): Promise<void>;
  /** Record the posted digest's Slack ts (and posted-at) for in-place updates. */
  markDigestPosted(runId: number, at: string, messageTs: string | null): Promise<void>;
  listRunParticipants(runId: number): Promise<RunParticipant[]>;
  markPrompted(runId: number, userId: string, at: string): Promise<void>;
  markReminded(runId: number, userId: string, at: string): Promise<void>;

  // responses
  upsertResponse(response: CheckinResponse): Promise<void>;
  listResponses(runId: number): Promise<CheckinResponse[]>;
  getResponse(runId: number, userId: string): Promise<CheckinResponse | null>;
  /** Most-recent-first run history for one user in one standup (responded or not). */
  listUserRunHistory(standupId: number, userId: string, limit: number): Promise<Array<{ runDate: string; responded: boolean }>>;
  /** Most-recent-first run summaries for participation stats. */
  listRecentRuns(standupId: number, limit: number): Promise<RunSummary[]>;
  /** Most-recent-first responses across recent runs, tagged with their run date. */
  listRecentResponses(standupId: number, limit: number): Promise<Array<{ runDate: string; response: CheckinResponse }>>;

  // blockers (v1: at most one open blocker per standup+user)
  getOpenBlocker(standupId: number, userId: string): Promise<Blocker | null>;
  getBlockerById(id: number): Promise<Blocker | null>;
  openBlocker(standupId: number, userId: string, text: string, date: string): Promise<Blocker>;
  /** Refresh last-confirmed date (and optionally the text) on an open blocker. */
  confirmBlocker(id: number, date: string, text?: string): Promise<void>;
  resolveBlocker(id: number, at: string): Promise<void>;
  listOpenBlockers(standupId: number): Promise<Blocker[]>;
  /** Most recently resolved first. */
  listResolvedBlockers(standupId: number, limit: number): Promise<Blocker[]>;

  // kudos
  addKudos(kudos: Kudos): Promise<void>;
  /** Top kudos recipients since `sinceIso`; `channelId` restricts to kudos given in that channel. */
  kudosLeaderboard(sinceIso: string, limit: number, channelId?: string): Promise<LeaderboardEntry[]>;

  // retention
  /** Delete runs (cascading responses), kudos, and RESOLVED blockers older than `days`. */
  purgeOlderThan(days: number, nowIso: string): Promise<void>;
}
