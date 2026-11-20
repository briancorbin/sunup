/**
 * In-memory doubles for the two ports core depends on, so runCron and the
 * service layer can be driven end to end without SQLite or Slack.
 */
import type { SlackPort, Storage } from "../src/index";
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
} from "../src/index";

export class MemoryStorage implements Storage {
  standups: Standup[] = [];
  participants: Participant[] = [];
  runs: Run[] = [];
  runParticipants: RunParticipant[] = [];
  responses: CheckinResponse[] = [];
  blockers: Blocker[] = [];
  kudos: Kudos[] = [];
  private nextId = 1;

  async listStandups(): Promise<Standup[]> {
    return this.standups.map((s) => ({ ...s }));
  }
  async getStandup(id: number): Promise<Standup | null> {
    const s = this.standups.find((x) => x.id === id);
    return s ? { ...s } : null;
  }
  async getStandupByChannel(channelId: string, kind: StandupKind): Promise<Standup | null> {
    const s = this.standups.find((x) => x.channelId === channelId && x.kind === kind);
    return s ? { ...s } : null;
  }
  async createStandup(input: Omit<Standup, "id" | "lastRetroDate">): Promise<Standup> {
    const s: Standup = { ...input, id: this.nextId++, lastRetroDate: null };
    this.standups.push(s);
    return { ...s };
  }
  async updateStandup(standup: Standup): Promise<void> {
    const i = this.standups.findIndex((x) => x.id === standup.id);
    if (i >= 0) this.standups[i] = { ...standup, createdBy: this.standups[i]!.createdBy };
  }
  async deleteStandup(id: number): Promise<void> {
    this.standups = this.standups.filter((s) => s.id !== id);
    this.participants = this.participants.filter((p) => p.standupId !== id);
    const runIds = new Set(this.runs.filter((r) => r.standupId === id).map((r) => r.id));
    this.runs = this.runs.filter((r) => r.standupId !== id);
    this.runParticipants = this.runParticipants.filter((rp) => !runIds.has(rp.runId));
    this.responses = this.responses.filter((r) => !runIds.has(r.runId));
    this.blockers = this.blockers.filter((b) => b.standupId !== id);
  }
  async setLastRetroDate(standupId: number, date: string): Promise<void> {
    const s = this.standups.find((x) => x.id === standupId);
    if (s) s.lastRetroDate = date;
  }

  async listParticipants(standupId: number): Promise<Participant[]> {
    return this.participants.filter((p) => p.standupId === standupId).map((p) => ({ ...p }));
  }
  async listStandupsForUser(userId: string): Promise<Standup[]> {
    const ids = new Set(this.participants.filter((p) => p.userId === userId).map((p) => p.standupId));
    return this.standups.filter((s) => ids.has(s.id)).map((s) => ({ ...s }));
  }
  async addParticipant(standupId: number, userId: string, tz: string | null): Promise<void> {
    const existing = this.participants.find((p) => p.standupId === standupId && p.userId === userId);
    if (existing) {
      existing.tz = tz ?? existing.tz;
      return;
    }
    this.participants.push({ standupId, userId, tz, snoozedUntil: null, lastPromptDate: null });
  }
  async removeParticipant(standupId: number, userId: string): Promise<void> {
    this.participants = this.participants.filter((p) => !(p.standupId === standupId && p.userId === userId));
  }
  async setParticipantTz(userId: string, tz: string): Promise<void> {
    for (const p of this.participants) if (p.userId === userId) p.tz = tz;
  }
  async setParticipantPromptDate(standupId: number, userId: string, date: string): Promise<void> {
    const p = this.participants.find((x) => x.standupId === standupId && x.userId === userId);
    if (p) p.lastPromptDate = date;
  }
  async setSnooze(standupId: number, userId: string, until: string | null): Promise<void> {
    const p = this.participants.find((x) => x.standupId === standupId && x.userId === userId);
    if (p) p.snoozedUntil = until;
  }

  async getOrCreateRun(standupId: number, runDate: string): Promise<Run> {
    const existing = await this.getRun(standupId, runDate);
    if (existing) return existing;
    const run: Run = { id: this.nextId++, standupId, runDate, digestPostedAt: null, digestTs: null };
    this.runs.push(run);
    return { ...run };
  }
  async getRun(standupId: number, runDate: string): Promise<Run | null> {
    const r = this.runs.find((x) => x.standupId === standupId && x.runDate === runDate);
    return r ? { ...r } : null;
  }
  async getRunById(runId: number): Promise<Run | null> {
    const r = this.runs.find((x) => x.id === runId);
    return r ? { ...r } : null;
  }
  async claimDigest(runId: number, at: string): Promise<boolean> {
    const r = this.runs.find((x) => x.id === runId);
    if (!r || r.digestPostedAt) return false;
    r.digestPostedAt = at;
    return true;
  }
  async releaseDigestClaim(runId: number): Promise<void> {
    const r = this.runs.find((x) => x.id === runId);
    if (r && !r.digestTs) r.digestPostedAt = null;
  }
  async markDigestPosted(runId: number, at: string, messageTs: string | null): Promise<void> {
    const r = this.runs.find((x) => x.id === runId);
    if (r) {
      r.digestPostedAt = at;
      r.digestTs = messageTs;
    }
  }
  async listRunParticipants(runId: number): Promise<RunParticipant[]> {
    return this.runParticipants.filter((rp) => rp.runId === runId).map((rp) => ({ ...rp }));
  }
  private rp(runId: number, userId: string): RunParticipant {
    let rp = this.runParticipants.find((x) => x.runId === runId && x.userId === userId);
    if (!rp) {
      rp = { runId, userId, promptedAt: null, remindedAt: null };
      this.runParticipants.push(rp);
    }
    return rp;
  }
  async markPrompted(runId: number, userId: string, at: string): Promise<void> {
    this.rp(runId, userId).promptedAt = at;
  }
  async markReminded(runId: number, userId: string, at: string): Promise<void> {
    this.rp(runId, userId).remindedAt = at;
  }

  async upsertResponse(response: CheckinResponse): Promise<void> {
    this.responses = this.responses.filter((r) => !(r.runId === response.runId && r.userId === response.userId));
    this.responses.push({ ...response });
  }
  async listResponses(runId: number): Promise<CheckinResponse[]> {
    return this.responses.filter((r) => r.runId === runId).map((r) => ({ ...r }));
  }
  async getResponse(runId: number, userId: string): Promise<CheckinResponse | null> {
    const r = this.responses.find((x) => x.runId === runId && x.userId === userId);
    return r ? { ...r } : null;
  }
  private runsDesc(standupId: number): Run[] {
    return this.runs.filter((r) => r.standupId === standupId).sort((a, b) => b.runDate.localeCompare(a.runDate));
  }
  async listUserRunHistory(standupId: number, userId: string, limit: number): Promise<Array<{ runDate: string; responded: boolean }>> {
    return this.runsDesc(standupId)
      .slice(0, limit)
      .map((r) => ({ runDate: r.runDate, responded: this.responses.some((x) => x.runId === r.id && x.userId === userId) }));
  }
  async listRecentRuns(standupId: number, limit: number): Promise<RunSummary[]> {
    return this.runsDesc(standupId)
      .slice(0, limit)
      .map((r) => ({
        runDate: r.runDate,
        responseCount: this.responses.filter((x) => x.runId === r.id).length,
        digestPostedAt: r.digestPostedAt,
      }));
  }
  async listRecentResponses(standupId: number, limit: number): Promise<Array<{ runDate: string; response: CheckinResponse }>> {
    const out: Array<{ runDate: string; response: CheckinResponse }> = [];
    for (const r of this.runsDesc(standupId)) {
      for (const x of this.responses.filter((y) => y.runId === r.id)) out.push({ runDate: r.runDate, response: { ...x } });
    }
    return out.slice(0, limit);
  }

  async getOpenBlocker(standupId: number, userId: string): Promise<Blocker | null> {
    const b = this.blockers.find((x) => x.standupId === standupId && x.userId === userId && !x.resolvedAt);
    return b ? { ...b } : null;
  }
  async getBlockerById(id: number): Promise<Blocker | null> {
    const b = this.blockers.find((x) => x.id === id);
    return b ? { ...b } : null;
  }
  async openBlocker(standupId: number, userId: string, text: string, date: string): Promise<Blocker> {
    const b: Blocker = { id: this.nextId++, standupId, userId, text, openedDate: date, lastConfirmedDate: date, resolvedAt: null };
    this.blockers.push(b);
    return { ...b };
  }
  async confirmBlocker(id: number, date: string, text?: string): Promise<void> {
    const b = this.blockers.find((x) => x.id === id);
    if (b) {
      b.lastConfirmedDate = date;
      if (text) b.text = text;
    }
  }
  async resolveBlocker(id: number, at: string): Promise<void> {
    const b = this.blockers.find((x) => x.id === id);
    if (b && !b.resolvedAt) b.resolvedAt = at;
  }
  async listOpenBlockers(standupId: number): Promise<Blocker[]> {
    return this.blockers
      .filter((b) => b.standupId === standupId && !b.resolvedAt)
      .sort((a, b) => a.openedDate.localeCompare(b.openedDate))
      .map((b) => ({ ...b }));
  }
  async listResolvedBlockers(standupId: number, limit: number): Promise<Blocker[]> {
    return this.blockers
      .filter((b) => b.standupId === standupId && b.resolvedAt)
      .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
      .slice(0, limit)
      .map((b) => ({ ...b }));
  }

  async addKudos(kudos: Kudos): Promise<void> {
    this.kudos.push({ ...kudos });
  }
  async kudosLeaderboard(sinceIso: string, limit: number, channelId?: string): Promise<LeaderboardEntry[]> {
    const counts = new Map<string, number>();
    for (const k of this.kudos) {
      if (k.createdAt < sinceIso) continue;
      if (channelId && k.channelId !== channelId) continue;
      counts.set(k.toUser, (counts.get(k.toUser) ?? 0) + 1);
    }
    return [...counts]
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  async purgeOlderThan(days: number, nowIso: string): Promise<void> {
    const cutoff = new Date(new Date(nowIso).getTime() - days * 86_400_000).toISOString();
    const cutoffDate = cutoff.slice(0, 10);
    const dead = new Set(this.runs.filter((r) => r.runDate < cutoffDate).map((r) => r.id));
    this.runs = this.runs.filter((r) => !dead.has(r.id));
    this.runParticipants = this.runParticipants.filter((rp) => !dead.has(rp.runId));
    this.responses = this.responses.filter((r) => !dead.has(r.runId));
    this.kudos = this.kudos.filter((k) => k.createdAt >= cutoff);
    this.blockers = this.blockers.filter((b) => !(b.resolvedAt && b.resolvedAt < cutoff));
  }
}

export interface SentMessage {
  channel: string;
  text: string;
  blocks?: unknown[];
  /** The Date the test clock showed when this was sent. */
  at: Date;
}

/** Records every send; `failWith` makes the next DM open fail with the given error. */
export class FakeSlack implements SlackPort {
  messages: SentMessage[] = [];
  updates: Array<{ channel: string; ts: string; text: string }> = [];
  ephemerals: Array<{ channel: string; user: string; text: string }> = [];
  admins = new Set<string>();
  tzByUser = new Map<string, string>();
  /** Errors to throw from the next openDm calls, in order. */
  dmFailures: unknown[] = [];
  /** Every openDm attempt, in order. */
  dmOpens: string[] = [];
  /** Runs inside postMessage before it returns — simulates a race while posting. */
  onPost?: (channel: string) => Promise<void>;
  now: () => Date = () => new Date();
  private ts = 1;

  async postMessage(channel: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    if (this.onPost) await this.onPost(channel);
    this.messages.push({ channel, text, blocks, at: this.now() });
    return { ts: `${this.ts++}.000` };
  }
  async updateMessage(channel: string, ts: string, text: string): Promise<unknown> {
    this.updates.push({ channel, ts, text });
    return {};
  }
  async postEphemeral(channel: string, user: string, text: string): Promise<unknown> {
    this.ephemerals.push({ channel, user, text });
    return {};
  }
  async openDm(userId: string): Promise<string> {
    this.dmOpens.push(userId);
    const fail = this.dmFailures.shift();
    if (fail) throw fail;
    return `D_${userId}`;
  }
  async openView(): Promise<unknown> {
    return {};
  }
  async publishHome(): Promise<unknown> {
    return {};
  }
  async userLabel(userId: string): Promise<string | null> {
    return userId;
  }
  async userTz(userId: string): Promise<string | null> {
    return this.tzByUser.get(userId) ?? null;
  }
  async userIsAdmin(userId: string): Promise<boolean> {
    return this.admins.has(userId);
  }

  /** DMs sent to one user (channel D_<user>), oldest first. */
  dmsTo(userId: string): SentMessage[] {
    return this.messages.filter((m) => m.channel === `D_${userId}`);
  }
  /** Messages posted to a channel, oldest first. */
  inChannel(channelId: string): SentMessage[] {
    return this.messages.filter((m) => m.channel === channelId);
  }
}

/** Walk `runCron` from `start` to `end` (inclusive) in `stepMinutes` increments. */
export async function simulate(
  deps: { storage: Storage; slack: FakeSlack },
  start: Date,
  end: Date,
  stepMinutes: number,
  tick: (now: Date) => Promise<void>,
): Promise<void> {
  for (let t = start.getTime(); t <= end.getTime(); t += stepMinutes * 60_000) {
    const now = new Date(t);
    deps.slack.now = () => now;
    await tick(now);
  }
}
