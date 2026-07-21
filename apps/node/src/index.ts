import { serve } from "@hono/node-server";
import { DatabaseSync } from "node:sqlite";
import { SlackClient, runCron, type Deps } from "@sunup/core";
import { createSlackApp, handleExportRequest } from "@sunup/slack-app";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "./migrate";
import { SqliteStorage } from "./storage";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const botToken = required("SLACK_BOT_TOKEN");
const signingSecret = required("SLACK_SIGNING_SECRET");
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? "./sunup.db";
// Public URL for export links; set this when running behind a tunnel/proxy.
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const cronMinutes = Math.max(1, Number(process.env.CRON_INTERVAL_MINUTES ?? 5));
const retention = Number(process.env.RETENTION_DAYS);

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
const ran = migrate(db, migrationsDir);
if (ran.length > 0) console.log(`Applied migrations: ${ran.join(", ")}`);

const deps: Deps = {
  storage: new SqliteStorage(db),
  slack: new SlackClient(botToken),
  ...(Number.isFinite(retention) && retention > 0 ? { retentionDays: retention } : {}),
};

const app = createSlackApp({ deps, signingSecret, botToken, origin: baseUrl });

serve({
  port,
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return new Response("ok");
    if (request.method === "GET" && url.pathname === "/export") {
      return await handleExportRequest(deps.storage, signingSecret, url);
    }
    return await app.run(request);
  },
});
console.log(`🌅 sunup (node) listening on :${port} — db: ${dbPath}, export links via ${baseUrl}`);

// The scheduler tick is idempotent (marker-guarded sends), so a plain interval
// is a perfectly good trigger.
const tick = () => runCron(deps, new Date()).catch((err) => console.error("sunup cron tick failed", err));
tick();
setInterval(tick, cronMinutes * 60 * 1000);
