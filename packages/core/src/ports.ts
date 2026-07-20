import type {
  CheckinResponse,
  Kudos,
  LeaderboardEntry,
  Participant,
  Run,
  RunParticipant,
  RunSummary,
  Standup,
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
  getStandupByChannel(channelId: string): Promise<Standup | null>;
  createStandup(input: Omit<Standup, "id" | "lastRetroDate">): Promise<Standup>;
  updateStandup(standup: Standup): Promise<void>;
  deleteStandup(id: number): Promise<void>;
  setLastRetroDate(standupId: number, date: string): Promise<void>;

  // participants
  listParticipants(standupId: number): Promise<Participant[]>;
  listStandupsForUser(userId: string): Promise<Standup[]>;
  addParticipant(standupId: number, userId: string, tz: string | null): Promise<void>;
  removeParticipant(standupId: number, userId: string): Promise<void>;
  setParticipantTz(userId: string, tz: string): Promise<void>;
  /** null clears the snooze. */
  setSnooze(standupId: number, userId: string, until: string | null): Promise<void>;

  // runs
  getOrCreateRun(standupId: number, runDate: string): Promise<Run>;
  getRun(standupId: number, runDate: string): Promise<Run | null>;
  getRunById(runId: number): Promise<Run | null>;
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

  // kudos
  addKudos(kudos: Kudos): Promise<void>;
  kudosLeaderboard(sinceIso: string, limit: number): Promise<LeaderboardEntry[]>;

  // retention
  purgeOlderThan(days: number, nowIso: string): Promise<void>;
}
