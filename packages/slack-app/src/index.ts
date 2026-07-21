/**
 * The Slack-facing application, shared by every adapter (Cloudflare Workers,
 * Node, …). Adapters provide Deps (storage + slack client), the two Slack
 * secrets, and the public origin for export links — everything else lives here.
 */
import { SlackApp, type SlackEdgeAppEnv } from "slack-edge";
import {
  BLOCKER_RESOLVED_ACTION_ID,
  BLOCKER_STILL_ACTION_ID,
  CHECKIN_MODAL_CALLBACK_ID,
  CONFIG_MODAL_CALLBACK_ID,
  START_CHECKIN_ACTION_ID,
  HELP_TEXT,
  buildConfigModal,
  handleBlockerAction,
  handleCheckinSubmission,
  handleConfig,
  handleJoin,
  handleKudos,
  handleLeave,
  handleQuestions,
  handleRemove,
  handleSetup,
  handleSnooze,
  handleStatus,
  makeExportToken,
  openCheckinModal,
  openCheckinModalForRun,
  parseCheckinSubmission,
  parseConfigSubmission,
  publishHome,
  resolveStandupForCheckin,
  toCsv,
  verifyExportToken,
  type CheckinModalMetadata,
  type ConfigModalMetadata,
  type Deps,
  type Storage,
} from "@sunup/core";

export interface SlackAppOptions {
  deps: Deps;
  signingSecret: string;
  botToken: string;
  /** Public origin used in export links, e.g. https://sunup.example.workers.dev */
  origin: string;
}

/** GET /export?token=… — CSV download behind a short-lived HMAC-signed link. */
export async function handleExportRequest(storage: Storage, signingSecret: string, url: URL): Promise<Response> {
  const token = url.searchParams.get("token") ?? "";
  const standupId = await verifyExportToken(signingSecret, token, Math.floor(Date.now() / 1000));
  if (!standupId) return new Response("This export link is invalid or expired — run /sunup export again.", { status: 403 });
  const standup = await storage.getStandup(standupId);
  if (!standup) return new Response("Check-in not found.", { status: 404 });
  const rows = await storage.listRecentResponses(standupId, 10000);
  const filename = `sunup-${standup.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv`;
  return new Response(toCsv(standup, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function createSlackApp(opts: SlackAppOptions): SlackApp<SlackEdgeAppEnv> {
  const app = new SlackApp<SlackEdgeAppEnv>({
    env: { SLACK_SIGNING_SECRET: opts.signingSecret, SLACK_BOT_TOKEN: opts.botToken },
  });
  const { deps, origin } = opts;

  // /sunup and /sundown share one router; only the kind differs.
  for (const kind of ["sunup", "sundown"] as const) {
    app.command(
      `/${kind}`,
      async () => "", // ack within 3s; real work happens in the lazy handler
      async ({ context, payload }) => {
        const [sub = ""] = payload.text.trim().split(/\s+/);
        const argText = payload.text.trim().slice(sub.length).trim();
        const channelId = payload.channel_id;
        const userId = payload.user_id;

        const respond = async (text: string) => {
          await context.respond({ text, response_type: "ephemeral" });
        };

        switch (sub.toLowerCase()) {
          case "":
          case "checkin": {
            const standup = await resolveStandupForCheckin(deps, channelId, userId, kind);
            if (!standup) {
              await respond(
                `I couldn't tell which check-in you mean — run \`/${kind}\` in its channel, or \`/${kind} setup\` to create one here.`,
              );
              return;
            }
            await openCheckinModal(deps, payload.trigger_id, standup, new Date(), userId);
            return;
          }
          case "setup":
            return respond(await handleSetup(deps, channelId, userId, argText || undefined, kind));
          case "join":
            return respond(await handleJoin(deps, channelId, userId, kind));
          case "leave":
            return respond(await handleLeave(deps, channelId, userId, kind));
          case "status":
            return respond(await handleStatus(deps, channelId, kind));
          case "config": {
            if (!argText) {
              const standup = await deps.storage.getStandupByChannel(channelId, kind);
              if (!standup) return respond(`No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`);
              await deps.slack.openView(payload.trigger_id, buildConfigModal(standup));
              return;
            }
            const [field = "", ...valueParts] = argText.split(/\s+/);
            return respond(await handleConfig(deps, channelId, field.toLowerCase(), valueParts.join(" "), kind));
          }
          case "questions":
            return respond(await handleQuestions(deps, channelId, argText, kind));
          case "export": {
            const standup = await deps.storage.getStandupByChannel(channelId, kind);
            if (!standup) return respond(`No ${kind} check-in in this channel yet — create one with \`/${kind} setup\`.`);
            const expires = Math.floor(Date.now() / 1000) + 15 * 60;
            const token = await makeExportToken(opts.signingSecret, standup.id, expires);
            return respond(
              `📄 CSV export of *${standup.name}* — link valid for 15 minutes:\n${origin}/export?token=${token}`,
            );
          }
          case "snooze":
            return respond(await handleSnooze(deps, channelId, userId, argText.toLowerCase(), new Date(), kind));
          case "remove":
          case "delete":
            return respond(await handleRemove(deps, channelId, argText.toLowerCase() === "confirm", kind));
          case "help":
          default:
            return respond(HELP_TEXT);
        }
      },
    );
  }

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

  for (const [actionId, resolved] of [
    [BLOCKER_RESOLVED_ACTION_ID, true],
    [BLOCKER_STILL_ACTION_ID, false],
  ] as const) {
    app.action(
      actionId,
      async () => {},
      async ({ context, payload }) => {
        const action = payload.actions[0];
        const blockerId = Number(action && "value" in action ? action.value : NaN);
        if (!Number.isFinite(blockerId)) return;
        const reply = await handleBlockerAction(deps, blockerId, resolved, new Date());
        // New message in the DM — replacing the original would kill the check-in button.
        await context.respond?.({ text: reply, replace_original: false });
      },
    );
  }

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

  app.view(
    CONFIG_MODAL_CALLBACK_ID,
    // ack: validate fast; field errors render inline in the modal
    async ({ payload }) => {
      const metadata = JSON.parse(payload.view.private_metadata) as ConfigModalMetadata;
      const standup = await deps.storage.getStandup(metadata.standupId);
      if (!standup) return;
      const { errors } = parseConfigSubmission(standup, payload.view.state.values as never);
      if (Object.keys(errors).length > 0) return { response_action: "errors" as const, errors };
      return;
    },
    // lazy: persist and confirm
    async ({ payload }) => {
      const metadata = JSON.parse(payload.view.private_metadata) as ConfigModalMetadata;
      const standup = await deps.storage.getStandup(metadata.standupId);
      if (!standup) return;
      const { standup: updated, errors } = parseConfigSubmission(standup, payload.view.state.values as never);
      if (Object.keys(errors).length > 0) return;
      await deps.storage.updateStandup(updated);
      try {
        await deps.slack.postEphemeral(updated.channelId, payload.user.id, `✅ *${updated.name}* settings saved.`);
      } catch {
        // Bot may not be in the channel yet; the modal closing is confirmation enough.
      }
    },
  );

  app.event("app_home_opened", async ({ payload }) => {
    if (payload.tab !== "home") return;
    await publishHome(deps, payload.user, new Date());
  });

  return app;
}
