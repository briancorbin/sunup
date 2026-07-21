import type { DatabaseSync } from "node:sqlite";
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
  Storage,
} from "@sunup/core";

/**
 * node:sqlite (built-in, zero native deps) implementation of the Storage port —
 * same SQL dialect as the D1 reference implementation
 * (apps/cloudflare/src/storage.ts), synchronous under the hood, async at the
 * interface. Requires Node >= 24 (node:sqlite is stable there).
 */

interface StandupRow {
  id: number;
  name: string;
  channel_id: string;
  kind: string;
  questions: string;
  schedule_days: string;
  prompt_time: string;
  digest_time: string;
  timezone: string;
  user_tz_prompts: number;
  reminder_minutes: number;
  include_mood: number;
  last_retro_date: string | null;
}

function rowToStandup(row: StandupRow): Standup {
  return {
    id: row.id,
    name: row.name,
    channelId: row.channel_id,
    kind: (row.kind === "sundown" ? "sundown" : "sunup") as Standup["kind"],
    questions: JSON.parse(row.questions) as string[],
    scheduleDays: JSON.parse(row.schedule_days) as number[],
    promptTime: row.prompt_time,
    digestTime: row.digest_time,
    timezone: row.timezone,
    userTzPrompts: row.user_tz_prompts === 1,
    reminderMinutes: row.reminder_minutes,
    includeMood: row.include_mood === 1,
    lastRetroDate: row.last_retro_date,
  };
}

interface RunRow {
  id: number;
  standup_id: number;
  run_date: string;
  digest_posted_at: string | null;
  digest_ts: string | null;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    standupId: row.standup_id,
    runDate: row.run_date,
    digestPostedAt: row.digest_posted_at,
    digestTs: row.digest_ts,
  };
}

interface ResponseRow {
  run_id: number;
  user_id: string;
  answers: string;
  mood: number | null;
  submitted_at: string;
}

function rowToResponse(row: ResponseRow): CheckinResponse {
  return {
    runId: row.run_id,
    userId: row.user_id,
    answers: JSON.parse(row.answers) as string[],
    mood: row.mood,
    submittedAt: row.submitted_at,
  };
}

interface BlockerRow {
  id: number;
  standup_id: number;
  user_id: string;
  text: string;
  opened_date: string;
  last_confirmed_date: string;
  resolved_at: string | null;
}

function rowToBlocker(row: BlockerRow): Blocker {
  return {
    id: row.id,
    standupId: row.standup_id,
    userId: row.user_id,
    text: row.text,
    openedDate: row.opened_date,
    lastConfirmedDate: row.last_confirmed_date,
    resolvedAt: row.resolved_at,
  };
}

export class SqliteStorage implements Storage {
  constructor(private readonly db: DatabaseSync) {}

  async listStandups(): Promise<Standup[]> {
    return (this.db.prepare("SELECT * FROM standups").all() as unknown as StandupRow[]).map(rowToStandup);
  }

  async getStandup(id: number): Promise<Standup | null> {
    const row = this.db.prepare("SELECT * FROM standups WHERE id = ?").get(id) as StandupRow | undefined;
    return row ? rowToStandup(row) : null;
  }

  async getStandupByChannel(channelId: string, kind: StandupKind): Promise<Standup | null> {
    const row = this.db.prepare("SELECT * FROM standups WHERE channel_id = ? AND kind = ?").get(channelId, kind) as
      | StandupRow
      | undefined;
    return row ? rowToStandup(row) : null;
  }

  async createStandup(input: Omit<Standup, "id" | "lastRetroDate">): Promise<Standup> {
    const row = this.db
      .prepare(
        `INSERT INTO standups (name, channel_id, kind, questions, schedule_days, prompt_time, digest_time, timezone, user_tz_prompts, reminder_minutes, include_mood)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        input.name,
        input.channelId,
        input.kind,
        JSON.stringify(input.questions),
        JSON.stringify(input.scheduleDays),
        input.promptTime,
        input.digestTime,
        input.timezone,
        input.userTzPrompts ? 1 : 0,
        input.reminderMinutes,
        input.includeMood ? 1 : 0,
      ) as StandupRow | undefined;
    if (!row) throw new Error("createStandup: insert returned no row");
    return rowToStandup(row);
  }

  async updateStandup(standup: Standup): Promise<void> {
    this.db
      .prepare(
        `UPDATE standups SET name = ?, questions = ?, schedule_days = ?, prompt_time = ?, digest_time = ?, timezone = ?, user_tz_prompts = ?, reminder_minutes = ?, include_mood = ? WHERE id = ?`,
      )
      .run(
        standup.name,
        JSON.stringify(standup.questions),
        JSON.stringify(standup.scheduleDays),
        standup.promptTime,
        standup.digestTime,
        standup.timezone,
        standup.userTzPrompts ? 1 : 0,
        standup.reminderMinutes,
        standup.includeMood ? 1 : 0,
        standup.id,
      );
  }

  async deleteStandup(id: number): Promise<void> {
    this.db.prepare("DELETE FROM standups WHERE id = ?").run(id);
  }

  async setLastRetroDate(standupId: number, date: string): Promise<void> {
    this.db.prepare("UPDATE standups SET last_retro_date = ? WHERE id = ?").run(date, standupId);
  }

  async listParticipants(standupId: number): Promise<Participant[]> {
    const rows = this.db
      .prepare("SELECT standup_id, user_id, tz, snoozed_until FROM participants WHERE standup_id = ?")
      .all(standupId) as Array<{ standup_id: number; user_id: string; tz: string | null; snoozed_until: string | null }>;
    return rows.map((r) => ({ standupId: r.standup_id, userId: r.user_id, tz: r.tz, snoozedUntil: r.snoozed_until }));
  }

  async listStandupsForUser(userId: string): Promise<Standup[]> {
    const rows = this.db
      .prepare("SELECT s.* FROM standups s JOIN participants p ON p.standup_id = s.id WHERE p.user_id = ?")
      .all(userId) as unknown as StandupRow[];
    return rows.map(rowToStandup);
  }

  async addParticipant(standupId: number, userId: string, tz: string | null): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO participants (standup_id, user_id, tz) VALUES (?, ?, ?) ON CONFLICT (standup_id, user_id) DO UPDATE SET tz = COALESCE(excluded.tz, tz)",
      )
      .run(standupId, userId, tz);
  }

  async removeParticipant(standupId: number, userId: string): Promise<void> {
    this.db.prepare("DELETE FROM participants WHERE standup_id = ? AND user_id = ?").run(standupId, userId);
  }

  async setParticipantTz(userId: string, tz: string): Promise<void> {
    this.db.prepare("UPDATE participants SET tz = ? WHERE user_id = ?").run(tz, userId);
  }

  async setSnooze(standupId: number, userId: string, until: string | null): Promise<void> {
    this.db.prepare("UPDATE participants SET snoozed_until = ? WHERE standup_id = ? AND user_id = ?").run(until, standupId, userId);
  }

  async getOrCreateRun(standupId: number, runDate: string): Promise<Run> {
    this.db.prepare("INSERT OR IGNORE INTO runs (standup_id, run_date) VALUES (?, ?)").run(standupId, runDate);
    const run = await this.getRun(standupId, runDate);
    if (!run) throw new Error("getOrCreateRun: run missing after insert");
    return run;
  }

  async getRun(standupId: number, runDate: string): Promise<Run | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE standup_id = ? AND run_date = ?").get(standupId, runDate) as
      | RunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  async getRunById(runId: number): Promise<Run | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async markDigestPosted(runId: number, at: string, messageTs: string | null): Promise<void> {
    this.db.prepare("UPDATE runs SET digest_posted_at = ?, digest_ts = ? WHERE id = ?").run(at, messageTs, runId);
  }

  async listRunParticipants(runId: number): Promise<RunParticipant[]> {
    const rows = this.db
      .prepare("SELECT run_id, user_id, prompted_at, reminded_at FROM run_participants WHERE run_id = ?")
      .all(runId) as Array<{ run_id: number; user_id: string; prompted_at: string | null; reminded_at: string | null }>;
    return rows.map((r) => ({ runId: r.run_id, userId: r.user_id, promptedAt: r.prompted_at, remindedAt: r.reminded_at }));
  }

  async markPrompted(runId: number, userId: string, at: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO run_participants (run_id, user_id, prompted_at) VALUES (?, ?, ?) ON CONFLICT (run_id, user_id) DO UPDATE SET prompted_at = excluded.prompted_at",
      )
      .run(runId, userId, at);
  }

  async markReminded(runId: number, userId: string, at: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO run_participants (run_id, user_id, reminded_at) VALUES (?, ?, ?) ON CONFLICT (run_id, user_id) DO UPDATE SET reminded_at = excluded.reminded_at",
      )
      .run(runId, userId, at);
  }

  async upsertResponse(response: CheckinResponse): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO responses (run_id, user_id, answers, mood, submitted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id, user_id) DO UPDATE SET answers = excluded.answers, mood = excluded.mood, submitted_at = excluded.submitted_at`,
      )
      .run(response.runId, response.userId, JSON.stringify(response.answers), response.mood, response.submittedAt);
  }

  async listResponses(runId: number): Promise<CheckinResponse[]> {
    return (this.db.prepare("SELECT * FROM responses WHERE run_id = ? ORDER BY submitted_at").all(runId) as unknown as ResponseRow[]).map(
      rowToResponse,
    );
  }

  async getResponse(runId: number, userId: string): Promise<CheckinResponse | null> {
    const row = this.db.prepare("SELECT * FROM responses WHERE run_id = ? AND user_id = ?").get(runId, userId) as
      | ResponseRow
      | undefined;
    return row ? rowToResponse(row) : null;
  }

  async listUserRunHistory(standupId: number, userId: string, limit: number): Promise<Array<{ runDate: string; responded: boolean }>> {
    const rows = this.db
      .prepare(
        `SELECT r.run_date, (SELECT COUNT(*) FROM responses x WHERE x.run_id = r.id AND x.user_id = ?) AS responded
         FROM runs r WHERE r.standup_id = ? ORDER BY r.run_date DESC LIMIT ?`,
      )
      .all(userId, standupId, limit) as Array<{ run_date: string; responded: number }>;
    return rows.map((r) => ({ runDate: r.run_date, responded: r.responded > 0 }));
  }

  async listRecentRuns(standupId: number, limit: number): Promise<RunSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT r.run_date, r.digest_posted_at, (SELECT COUNT(*) FROM responses x WHERE x.run_id = r.id) AS response_count
         FROM runs r WHERE r.standup_id = ? ORDER BY r.run_date DESC LIMIT ?`,
      )
      .all(standupId, limit) as Array<{ run_date: string; digest_posted_at: string | null; response_count: number }>;
    return rows.map((r) => ({ runDate: r.run_date, digestPostedAt: r.digest_posted_at, responseCount: r.response_count }));
  }

  async listRecentResponses(standupId: number, limit: number): Promise<Array<{ runDate: string; response: CheckinResponse }>> {
    const rows = this.db
      .prepare(
        `SELECT r.run_date, x.run_id, x.user_id, x.answers, x.mood, x.submitted_at
         FROM responses x JOIN runs r ON r.id = x.run_id
         WHERE r.standup_id = ? ORDER BY r.run_date DESC, x.submitted_at DESC LIMIT ?`,
      )
      .all(standupId, limit) as unknown as Array<ResponseRow & { run_date: string }>;
    return rows.map((r) => ({ runDate: r.run_date, response: rowToResponse(r) }));
  }

  async getOpenBlocker(standupId: number, userId: string): Promise<Blocker | null> {
    const row = this.db
      .prepare("SELECT * FROM blockers WHERE standup_id = ? AND user_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(standupId, userId) as BlockerRow | undefined;
    return row ? rowToBlocker(row) : null;
  }

  async getBlockerById(id: number): Promise<Blocker | null> {
    const row = this.db.prepare("SELECT * FROM blockers WHERE id = ?").get(id) as BlockerRow | undefined;
    return row ? rowToBlocker(row) : null;
  }

  async openBlocker(standupId: number, userId: string, text: string, date: string): Promise<Blocker> {
    const row = this.db
      .prepare(
        "INSERT INTO blockers (standup_id, user_id, text, opened_date, last_confirmed_date) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(standupId, userId, text, date, date) as BlockerRow | undefined;
    if (!row) throw new Error("openBlocker: insert returned no row");
    return rowToBlocker(row);
  }

  async confirmBlocker(id: number, date: string, text?: string): Promise<void> {
    if (text !== undefined) {
      this.db.prepare("UPDATE blockers SET last_confirmed_date = ?, text = ? WHERE id = ?").run(date, text, id);
    } else {
      this.db.prepare("UPDATE blockers SET last_confirmed_date = ? WHERE id = ?").run(date, id);
    }
  }

  async resolveBlocker(id: number, at: string): Promise<void> {
    this.db.prepare("UPDATE blockers SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(at, id);
  }

  async listOpenBlockers(standupId: number): Promise<Blocker[]> {
    return (
      this.db.prepare("SELECT * FROM blockers WHERE standup_id = ? AND resolved_at IS NULL ORDER BY opened_date").all(standupId) as unknown as BlockerRow[]
    ).map(rowToBlocker);
  }

  async listResolvedBlockers(standupId: number, limit: number): Promise<Blocker[]> {
    return (
      this.db
        .prepare("SELECT * FROM blockers WHERE standup_id = ? AND resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?")
        .all(standupId, limit) as unknown as BlockerRow[]
    ).map(rowToBlocker);
  }

  async addKudos(kudos: Kudos): Promise<void> {
    this.db
      .prepare("INSERT INTO kudos (from_user, to_user, message, channel_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(kudos.fromUser, kudos.toUser, kudos.message, kudos.channelId, kudos.createdAt);
  }

  async kudosLeaderboard(sinceIso: string, limit: number): Promise<LeaderboardEntry[]> {
    const rows = this.db
      .prepare("SELECT to_user, COUNT(*) AS count FROM kudos WHERE created_at >= ? GROUP BY to_user ORDER BY count DESC LIMIT ?")
      .all(sinceIso, limit) as Array<{ to_user: string; count: number }>;
    return rows.map((r) => ({ userId: r.to_user, count: r.count }));
  }

  async purgeOlderThan(days: number, nowIso: string): Promise<void> {
    const cutoff = new Date(new Date(nowIso).getTime() - days * 24 * 60 * 60 * 1000);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    this.db.prepare("DELETE FROM runs WHERE run_date < ?").run(cutoffDate);
    this.db.prepare("DELETE FROM kudos WHERE created_at < ?").run(cutoff.toISOString());
  }
}
