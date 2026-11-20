import { runCron } from "@sunup/core";
import { createSlackApp, handleExportRequest, handleReportRequest, resolveLinkSecret } from "@sunup/slack-app";
import { buildDeps, type Env } from "./app";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const deps = buildDeps(env);
    const linkSecret = await resolveLinkSecret(env);
    if (request.method === "GET" && url.pathname === "/export") {
      return await handleExportRequest(deps.storage, linkSecret, url);
    }
    if (request.method === "GET" && url.pathname === "/report") {
      return await handleReportRequest(deps, linkSecret, url);
    }
    const app = createSlackApp({
      deps,
      signingSecret: env.SLACK_SIGNING_SECRET,
      botToken: env.SLACK_BOT_TOKEN,
      linkSecret,
      origin: url.origin,
    });
    return await app.run(request, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(buildDeps(env), new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
