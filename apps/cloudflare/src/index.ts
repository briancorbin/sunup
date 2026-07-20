import { runCron } from "@sunup/core";
import { buildApp, buildDeps, type Env } from "./app";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return await buildApp(env).run(request, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(buildDeps(env), new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
