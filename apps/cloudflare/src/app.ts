import { SlackClient, type Deps } from "@sunup/core";
import type { SlackEdgeAppEnv } from "slack-edge";
import { D1Storage } from "./storage";

export interface Env extends SlackEdgeAppEnv {
  DB: D1Database;
  /** Required despite being optional upstream — single-workspace installs always use a bot token. */
  SLACK_BOT_TOKEN: string;
  RETENTION_DAYS?: string;
}

export function buildDeps(env: Env): Deps {
  const retention = Number(env.RETENTION_DAYS);
  return {
    storage: new D1Storage(env.DB),
    slack: new SlackClient(env.SLACK_BOT_TOKEN),
    ...(Number.isFinite(retention) && retention > 0 ? { retentionDays: retention } : {}),
  };
}
