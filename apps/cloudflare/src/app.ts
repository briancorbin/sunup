import { SlackApp, type SlackEdgeAppEnv } from "slack-edge";
import {
  CHECKIN_MODAL_CALLBACK_ID,
  START_CHECKIN_ACTION_ID,
  HELP_TEXT,
  type Deps,
  type CheckinModalMetadata,
  SlackClient,
  handleCheckinSubmission,
  handleConfig,
  handleJoin,
  handleKudos,
  handleLeave,
  handleQuestions,
  handleSetup,
  handleStatus,
  openCheckinModal,
  openCheckinModalForRun,
  parseCheckinSubmission,
  publishHome,
  resolveStandupForCheckin,
} from "@sunup/core";
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

export function buildApp(env: Env): SlackApp<Env> {
  const app = new SlackApp({ env });
  const deps = buildDeps(env);

  app.command(
    "/sunup",
    async () => "", // ack within 3s; real work happens in the lazy handler
    async ({ context, payload }) => {
      const [sub = "", ...rest] = payload.text.trim().split(/\s+/);
      const argText = payload.text.trim().slice(sub.length).trim();
      const channelId = payload.channel_id;
      const userId = payload.user_id;

      const respond = async (text: string) => {
        await context.respond({ text, response_type: "ephemeral" });
      };

      switch (sub.toLowerCase()) {
        case "":
        case "checkin": {
          const standup = await resolveStandupForCheckin(deps, channelId, userId);
          if (!standup) {
            await respond(
              "I couldn't tell which check-in you mean — run `/sunup` in the check-in channel, or `/sunup setup` to create one here.",
            );
            return;
          }
          await openCheckinModal(deps, payload.trigger_id, standup, new Date(), userId);
          return;
        }
        case "setup":
          return respond(await handleSetup(deps, channelId, userId, argText || undefined));
        case "join":
          return respond(await handleJoin(deps, channelId, userId));
        case "leave":
          return respond(await handleLeave(deps, channelId, userId));
        case "status":
          return respond(await handleStatus(deps, channelId));
        case "config": {
          const [field = "", ...valueParts] = argText.split(/\s+/);
          return respond(await handleConfig(deps, channelId, field.toLowerCase(), valueParts.join(" ")));
        }
        case "questions":
          return respond(await handleQuestions(deps, channelId, argText));
        case "help":
        default:
          return respond(HELP_TEXT);
      }
    },
  );

  app.command(
    "/kudos",
    async () => "",
    async ({ context, payload }) => {
      const error = await handleKudos(deps, payload.user_id, payload.channel_id, payload.text, new Date().toISOString());
      if (error) {
        await context.respond({ text: error, response_type: "ephemeral" });
      }
    },
  );

  app.action(
    START_CHECKIN_ACTION_ID,
    async () => {},
    async ({ payload }) => {
      const action = payload.actions[0];
      const runId = Number(action && "value" in action ? action.value : NaN);
      if (!Number.isFinite(runId) || !payload.trigger_id) return;
      await openCheckinModalForRun(deps, payload.trigger_id, runId, payload.user.id);
    },
  );

  app.view(CHECKIN_MODAL_CALLBACK_ID, async ({ payload }) => {
    const metadata = JSON.parse(payload.view.private_metadata) as CheckinModalMetadata;
    const standup = await deps.storage.getStandup(metadata.standupId);
    if (!standup) return;
    const response = parseCheckinSubmission(
      standup,
      metadata,
      payload.user.id,
      payload.view.state.values as never,
      new Date().toISOString(),
    );
    await handleCheckinSubmission(deps, standup, response);
  });

  app.event("app_home_opened", async ({ payload }) => {
    if (payload.tab !== "home") return;
    await publishHome(deps, payload.user, new Date());
  });

  return app;
}
