import { runCron } from "@sunup/core";
import { buildApp, buildDeps, handleExportRequest, type Env } from "./app";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/export") {
      return await handleExportRequest(env, url);
    }
    return await buildApp(env, url.origin).run(request, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(buildDeps(env), new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
