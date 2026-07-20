/**
 * Minimal Slack Web API client over fetch — no SDK dependency, so it runs on
 * any Web-standard runtime (Workers, Node 18+, Deno, Bun, Lambda).
 */
export class SlackClient {
  constructor(private readonly botToken: string) {}

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(params),
    });
    const data = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!data.ok) {
      throw new SlackApiError(method, data.error ?? "unknown_error");
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

  /** User's IANA timezone, or null if unavailable. */
  async userTz(userId: string): Promise<string | null> {
    try {
      const res = await this.call<{ user: { tz?: string } }>("users.info", { user: userId });
      return res.user.tz ?? null;
    } catch {
      return null;
    }
  }
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack API ${method} failed: ${code}`);
    this.name = "SlackApiError";
  }
}
