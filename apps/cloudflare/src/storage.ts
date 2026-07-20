import type {
  CheckinResponse,
  Kudos,
  LeaderboardEntry,
  Participant,
  Run,
  RunParticipant,
  RunSummary,
  Standup,
  Storage,
} from "@sunup/core";

interface StandupRow {
  id: number;
  name: string;
  channel_id: string;
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

export class D1Storage implements Storage {
  constructor(private readonly db: D1Database) {}

  async listStandups(): Promise<Standup[]> {
    const { results } = await this.db.prepare("SELECT * FROM standups").all<StandupRow>();
    return results.map(rowToStandup);
  }

  async getStandup(id: number): Promise<Standup | null> {
    const row = await this.db.prepare("SELECT * FROM standups WHERE id = ?").bind(id).first<StandupRow>();
    return row ? rowToStandup(row) : null;
  }

  async getStandupByChannel(channelId: string): Promise<Standup | null> {
    const row = await this.db.prepare("SELECT * FROM standups WHERE channel_id = ?").bind(channelId).first<StandupRow>();
    return row ? rowToStandup(row) : null;
  }

  async createStandup(input: Omit<Standup, "id" | "lastRetroDate">): Promise<Standup> {
    const row = await this.db
      .prepare(
        `INSERT INTO standups (name, channel_id, questions, schedule_days, prompt_time, digest_time, timezone, user_tz_prompts, reminder_minutes, include_mood)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .bind(
        input.name,
        input.channelId,
        JSON.stringify(input.questions),
        JSON.stringify(input.scheduleDays),
        input.promptTime,
        input.digestTime,
        input.timezone,
        input.userTzPrompts ? 1 : 0,
        input.reminderMinutes,
        input.includeMood ? 1 : 0,
      )
      .first<StandupRow>();
    if (!row) throw new Error("createStandup: insert returned no row");
    return rowToStandup(row);
  }

  async updateStandup(standup: Standup): Promise<void> {
    await this.db
      .prepare(
        `UPDATE standups SET name = ?, questions = ?, schedule_days = ?, prompt_time = ?, digest_time = ?, timezone = ?, user_tz_prompts = ?, reminder_minutes = ?, include_mood = ? WHERE id = ?`,
      )
      .bind(
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
      )
      .run();
  }

  async deleteStandup(id: number): Promise<void> {
    await this.db.prepare("DELETE FROM standups WHERE id = ?").bind(id).run();
  }

  async setLastRetroDate(standupId: number, date: string): Promise<void> {
    await this.db.prepare("UPDATE standups SET last_retro_date = ? WHERE id = ?").bind(date, standupId).run();
  }

  async listParticipants(standupId: number): Promise<Participant[]> {
    const { results } = await this.db
      .prepare("SELECT standup_id, user_id, tz, snoozed_until FROM participants WHERE standup_id = ?")
      .bind(standupId)
      .all<{ standup_id: number; user_id: string; tz: string | null; snoozed_until: string | null }>();
    return results.map((r) => ({ standupId: r.standup_id, userId: r.user_id, tz: r.tz, snoozedUntil: r.snoozed_until }));
  }

  async listStandupsForUser(userId: string): Promise<Standup[]> {
    const { results } = await this.db
      .prepare("SELECT s.* FROM standups s JOIN participants p ON p.standup_id = s.id WHERE p.user_id = ?")
      .bind(userId)
      .all<StandupRow>();
    return results.map(rowToStandup);
  }

  async addParticipant(standupId: number, userId: string, tz: string | null): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO participants (standup_id, user_id, tz) VALUES (?, ?, ?) ON CONFLICT (standup_id, user_id) DO UPDATE SET tz = COALESCE(excluded.tz, tz)",
      )
      .bind(standupId, userId, tz)
      .run();
  }

  async removeParticipant(standupId: number, userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM participants WHERE standup_id = ? AND user_id = ?").bind(standupId, userId).run();
  }

  async setParticipantTz(userId: string, tz: string): Promise<void> {
    await this.db.prepare("UPDATE participants SET tz = ? WHERE user_id = ?").bind(tz, userId).run();
  }

  async setSnooze(standupId: number, userId: string, until: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE participants SET snoozed_until = ? WHERE standup_id = ? AND user_id = ?")
      .bind(until, standupId, userId)
      .run();
  }

  async getOrCreateRun(standupId: number, runDate: string): Promise<Run> {
    await this.db
      .prepare("INSERT OR IGNORE INTO runs (standup_id, run_date) VALUES (?, ?)")
      .bind(standupId, runDate)
      .run();
    const run = await this.getRun(standupId, runDate);
    if (!run) throw new Error("getOrCreateRun: run missing after insert");
    return run;
  }

  async getRun(standupId: number, runDate: string): Promise<Run | null> {
    const row = await this.db
      .prepare("SELECT * FROM runs WHERE standup_id = ? AND run_date = ?")
      .bind(standupId, runDate)
      .first<RunRow>();
    return row ? rowToRun(row) : null;
  }

  async getRunById(runId: number): Promise<Run | null> {
    const row = await this.db.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
    return row ? rowToRun(row) : null;
  }

  async markDigestPosted(runId: number, at: string, messageTs: string | null): Promise<void> {
    await this.db.prepare("UPDATE runs SET digest_posted_at = ?, digest_ts = ? WHERE id = ?").bind(at, messageTs, runId).run();
  }

  async listRunParticipants(runId: number): Promise<RunParticipant[]> {
    const { results } = await this.db
      .prepare("SELECT run_id, user_id, prompted_at, reminded_at FROM run_participants WHERE run_id = ?")
      .bind(runId)
      .all<{ run_id: number; user_id: string; prompted_at: string | null; reminded_at: string | null }>();
    return results.map((r) => ({ runId: r.run_id, userId: r.user_id, promptedAt: r.prompted_at, remindedAt: r.reminded_at }));
  }

  async markPrompted(runId: number, userId: string, at: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO run_participants (run_id, user_id, prompted_at) VALUES (?, ?, ?) ON CONFLICT (run_id, user_id) DO UPDATE SET prompted_at = excluded.prompted_at",
      )
      .bind(runId, userId, at)
      .run();
  }

  async markReminded(runId: number, userId: string, at: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO run_participants (run_id, user_id, reminded_at) VALUES (?, ?, ?) ON CONFLICT (run_id, user_id) DO UPDATE SET reminded_at = excluded.reminded_at",
      )
      .bind(runId, userId, at)
      .run();
  }

  async upsertResponse(response: CheckinResponse): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO responses (run_id, user_id, answers, mood, submitted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id, user_id) DO UPDATE SET answers = excluded.answers, mood = excluded.mood, submitted_at = excluded.submitted_at`,
      )
      .bind(response.runId, response.userId, JSON.stringify(response.answers), response.mood, response.submittedAt)
      .run();
  }

  async listResponses(runId: number): Promise<CheckinResponse[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM responses WHERE run_id = ? ORDER BY submitted_at")
      .bind(runId)
      .all<ResponseRow>();
    return results.map(rowToResponse);
  }

  async getResponse(runId: number, userId: string): Promise<CheckinResponse | null> {
    const row = await this.db
      .prepare("SELECT * FROM responses WHERE run_id = ? AND user_id = ?")
      .bind(runId, userId)
      .first<ResponseRow>();
    return row ? rowToResponse(row) : null;
  }

  async listUserRunHistory(standupId: number, userId: string, limit: number): Promise<Array<{ runDate: string; responded: boolean }>> {
    const { results } = await this.db
      .prepare(
        `SELECT r.run_date, (SELECT COUNT(*) FROM responses x WHERE x.run_id = r.id AND x.user_id = ?) AS responded
         FROM runs r WHERE r.standup_id = ? ORDER BY r.run_date DESC LIMIT ?`,
      )
      .bind(userId, standupId, limit)
      .all<{ run_date: string; responded: number }>();
    return results.map((r) => ({ runDate: r.run_date, responded: r.responded > 0 }));
  }

  async listRecentRuns(standupId: number, limit: number): Promise<RunSummary[]> {
    const { results } = await this.db
      .prepare(
        `SELECT r.run_date, r.digest_posted_at, (SELECT COUNT(*) FROM responses x WHERE x.run_id = r.id) AS response_count
         FROM runs r WHERE r.standup_id = ? ORDER BY r.run_date DESC LIMIT ?`,
      )
      .bind(standupId, limit)
      .all<{ run_date: string; digest_posted_at: string | null; response_count: number }>();
    return results.map((r) => ({ runDate: r.run_date, digestPostedAt: r.digest_posted_at, responseCount: r.response_count }));
  }

  async listRecentResponses(standupId: number, limit: number): Promise<Array<{ runDate: string; response: CheckinResponse }>> {
    const { results } = await this.db
      .prepare(
        `SELECT r.run_date, x.run_id, x.user_id, x.answers, x.mood, x.submitted_at
         FROM responses x JOIN runs r ON r.id = x.run_id
         WHERE r.standup_id = ? ORDER BY r.run_date DESC, x.submitted_at DESC LIMIT ?`,
      )
      .bind(standupId, limit)
      .all<ResponseRow & { run_date: string }>();
    return results.map((r) => ({ runDate: r.run_date, response: rowToResponse(r) }));
  }

  async addKudos(kudos: Kudos): Promise<void> {
    await this.db
      .prepare("INSERT INTO kudos (from_user, to_user, message, channel_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(kudos.fromUser, kudos.toUser, kudos.message, kudos.channelId, kudos.createdAt)
      .run();
  }

  async kudosLeaderboard(sinceIso: string, limit: number): Promise<LeaderboardEntry[]> {
    const { results } = await this.db
      .prepare("SELECT to_user, COUNT(*) AS count FROM kudos WHERE created_at >= ? GROUP BY to_user ORDER BY count DESC LIMIT ?")
      .bind(sinceIso, limit)
      .all<{ to_user: string; count: number }>();
    return results.map((r) => ({ userId: r.to_user, count: r.count }));
  }

  async purgeOlderThan(days: number, nowIso: string): Promise<void> {
    const cutoff = new Date(new Date(nowIso).getTime() - days * 24 * 60 * 60 * 1000);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    // Runs cascade to run_participants and responses.
    await this.db.prepare("DELETE FROM runs WHERE run_date < ?").bind(cutoffDate).run();
    await this.db.prepare("DELETE FROM kudos WHERE created_at < ?").bind(cutoff.toISOString()).run();
  }
}
