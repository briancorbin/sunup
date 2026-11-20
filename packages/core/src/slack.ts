/**
 * The slice of Slack that core depends on. `SlackClient` is the real thing;
 * tests substitute an in-memory fake.
 */
export interface SlackPort {
  postMessage(channel: string, text: string, blocks?: unknown[]): Promise<{ ts: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<unknown>;
  postEphemeral(channel: string, user: string, text: string): Promise<unknown>;
  openDm(userId: string): Promise<string>;
  openView(triggerId: string, view: unknown): Promise<unknown>;
  publishHome(userId: string, view: unknown): Promise<unknown>;
  userLabel(userId: string): Promise<string | null>;
  userTz(userId: string): Promise<string | null>;
  userIsAdmin(userId: string): Promise<boolean>;
}

/**
 * Minimal Slack Web API client over fetch — no SDK dependency, so it runs on
 * any Web-standard runtime (Workers, Node 22+, Deno, Bun, Lambda).
 */
export class SlackClient implements SlackPort {
  constructor(private readonly botToken: string) {}

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    // Form-encoded, not JSON: Slack accepts application/json only for a subset
    // of methods — lookups like users.info silently reject it. Form encoding
    // (complex values as JSON strings) works for every Web API method.
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        Authorization: `Bearer ${this.botToken}`,
      },
      body: form.toString(),
    });
    let data: { ok: boolean; error?: string } & T;
    try {
      data = (await res.json()) as { ok: boolean; error?: string } & T;
    } catch {
      // Non-JSON body: an HTML 5xx or a dropped connection. Transient by nature.
      throw new SlackApiError(method, res.status >= 500 ? "service_unavailable" : "invalid_response", res.status);
    }
    if (!data.ok) {
      throw new SlackApiError(method, data.error ?? "unknown_error", res.status);
    }
    return data;
  }

  postMessage(channel: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    return this.call("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}) });
  }

  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]): Promise<unknown> {
    return this.call("chat.update", { channel, ts, text, ...(blocks ? { blocks } : {}) });
  }

  postEphemeral(channel: string, user: string, text: string): Promise<unknown> {
    return this.call("chat.postEphemeral", { channel, user, text });
  }

  /** Open (or fetch) the DM channel with a user; returns its channel id. */
  async openDm(userId: string): Promise<string> {
    const res = await this.call<{ channel: { id: string } }>("conversations.open", { users: userId });
    return res.channel.id;
  }

  openView(triggerId: string, view: unknown): Promise<unknown> {
    return this.call("views.open", { trigger_id: triggerId, view });
  }

  publishHome(userId: string, view: unknown): Promise<unknown> {
    return this.call("views.publish", { user_id: userId, view });
  }

  /** Human display name for a user, or null if unavailable. */
  async userLabel(userId: string): Promise<string | null> {
    try {
      const res = await this.call<{ user: { name?: string; real_name?: string; profile?: { display_name?: string } } }>(
        "users.info",
        { user: userId },
      );
      return res.user.profile?.display_name || res.user.real_name || res.user.name || null;
    } catch {
      return null;
    }
  }

  /** User's IANA timezone, or null if unavailable. */
  async userTz(userId: string): Promise<string | null> {
    try {
      const res = await this.call<{ user: { tz?: string } }>("users.info", { user: userId });
      return res.user.tz ?? null;
    } catch {
      return null;
    }
  }

  /** Workspace admin or owner? False when the lookup fails — never fail open. */
  async userIsAdmin(userId: string): Promise<boolean> {
    try {
      const res = await this.call<{ user: { is_admin?: boolean; is_owner?: boolean; is_primary_owner?: boolean } }>("users.info", {
        user: userId,
      });
      return Boolean(res.user.is_admin || res.user.is_owner || res.user.is_primary_owner);
    } catch {
      return false;
    }
  }
}

/** Slack error codes that mean "try again later", not "this will never work". */
const TRANSIENT_CODES = new Set(["ratelimited", "rate_limited", "internal_error", "service_unavailable", "fatal_error", "request_timeout", "invalid_response"]);

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(`Slack API ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }

  /** True for rate limits, 5xx and timeouts — the caller should retry on a later tick. */
  get transient(): boolean {
    return TRANSIENT_CODES.has(this.code) || (this.status != null && (this.status === 429 || this.status >= 500));
  }
}

/**
 * Did a send fail for good (deactivated user, missing scope, bad channel) or
 * only for now? Anything that isn't a definite Slack "no" — network errors,
 * 429s, 5xx — counts as transient so the caller retries instead of giving up.
 */
export function isPermanentSlackError(err: unknown): boolean {
  return err instanceof SlackApiError && !err.transient;
}
