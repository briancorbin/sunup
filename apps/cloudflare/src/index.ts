import { runCron } from "@sunup/core";
import { createSlackApp, handleExportRequest } from "@sunup/slack-app";
import { buildDeps, type Env } from "./app";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const deps = buildDeps(env);
    if (request.method === "GET" && url.pathname === "/export") {
      return await handleExportRequest(deps.storage, env.SLACK_SIGNING_SECRET, url);
    }
    const app = createSlackApp({
      deps,
      signingSecret: env.SLACK_SIGNING_SECRET,
      botToken: env.SLACK_BOT_TOKEN,
      origin: url.origin,
    });
    return await app.run(request, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(buildDeps(env), new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
