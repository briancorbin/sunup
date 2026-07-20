<p align="center">
  <img src="assets/logo.svg" alt="sunup — a robin perched on the rising sun" width="240"/>
</p>

<h1 align="center">sunup</h1>

<p align="center">
  Async daily check-ins, digests, and kudos for Slack — <b>open source, self-hosted, free</b>.<br/>
  Your team's data lives in <i>your</i> infrastructure. No per-seat pricing, ever.
</p>

---

## What it does

- **☀️ Async check-ins** — at a time you choose, sunup DMs each participant a prompt. They answer a short form (configurable questions) whenever suits them — each person is prompted at the chosen hour *in their own timezone*.
- **📰 Channel digest** — at digest time, one tidy message summarizes everyone's answers in the team channel.
- **🚧 Blocker surfacing** — blockers get their own highlighted section in the digest, so leads can scan for them.
- **⏰ Nudges** — non-responders get one friendly reminder before the digest posts.
- **🎉 Kudos** — `/kudos @teammate for shipping the thing` posts a celebration and feeds a 30-day leaderboard.
- **📈 Mood pulse** — an optional 1–5 mood question, shown in the digest only as a team average (and only with 3+ responses).
- **🏠 Dashboard** — click sunup in your sidebar: today's status, streaks, team participation history, and the kudos leaderboard, right in Slack's App Home.

**Privacy by design:** sunup requests *no message-reading scopes*. It only ever sees what people type into its own forms. Scopes: `chat:write`, `commands`, `im:write`, `users:read` (the last one just for timezones).

## Setup (~15 minutes)

You'll deploy your own instance: your Slack app, your Cloudflare account, your database.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free tier is far more than enough)
- Node 18+ and `npm`
- Permission to install a custom app in your Slack workspace

### 1. Deploy the Worker

```sh
git clone https://github.com/briancorbin/sunup.git
cd sunup
npm install
npx wrangler login

# Create the database, then paste its id into apps/cloudflare/wrangler.jsonc
npx wrangler d1 create sunup --cwd apps/cloudflare
npm run db:migrate --workspace apps/cloudflare

npm run deploy
```

Note the Worker URL printed at the end (e.g. `https://sunup.<you>.workers.dev`).

### 2. Create the Slack app

1. Open [slack-app-manifest.yml](slack-app-manifest.yml) and replace `YOUR-WORKER-URL` with your Worker URL.
2. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste it in.
3. Optional but nice: under *Basic Information → Display Information*, upload [assets/icon-1024.png](assets/icon-1024.png) as the app icon.
4. On the app page: **Install to Workspace**.
5. Grab two values:
   - **Bot User OAuth Token** (`xoxb-…`) from *OAuth & Permissions*
   - **Signing Secret** from *Basic Information*

### 3. Wire them together

```sh
cd apps/cloudflare
npx wrangler secret put SLACK_BOT_TOKEN      # paste the xoxb- token
npx wrangler secret put SLACK_SIGNING_SECRET # paste the signing secret
```

(If Slack showed a ⚠️ next to the request URLs before the secrets existed, hit "Retry" on the *Event Subscriptions* page — it should turn green now.)

### 4. Use it

In your team channel:

```
/invite @Sunup        ← so it can post the digest
/sunup setup          ← creates the check-in with sensible defaults
```

Teammates run `/sunup join`. That's it. `/sunup help` shows everything else:

| Command | What it does |
| --- | --- |
| `/sunup` | Submit (or edit) today's check-in |
| `/sunup setup [name]` | Create a check-in for the current channel |
| `/sunup join` / `leave` | Manage your participation |
| `/sunup status` | Show the channel's check-in config |
| `/sunup config <field> <value>` | `prompt 08:30`, `digest 12:00`, `days mon,wed,fri`, `tz Europe/London`, `reminder 30`, `mood off`, `name Standup` |
| `/sunup questions Q1 \| Q2 \| Q3` | Set custom questions (the last is the blockers question) |
| `/sunup remove` | Delete the channel's check-in and its history (asks to confirm) |
| `/kudos @user <message>` | Celebrate a teammate |

### Optional: data retention

Set `RETENTION_DAYS` in `apps/cloudflare/wrangler.jsonc` (e.g. `"90"`) to automatically purge check-in and kudos data older than that.

## Architecture

sunup is deliberately split so the bot logic is portable and the platform is a plugin:

```
packages/core        the entire bot — scheduling, check-in flow, digests,
                     kudos, Block Kit UI. Pure TypeScript + Web APIs (fetch,
                     Intl). Zero platform imports. Talks to persistence only
                     through the Storage interface (src/ports.ts).

apps/cloudflare      the Cloudflare adapter — a Worker (HTTP entry via
                     slack-edge), a D1 implementation of Storage, and a cron
                     trigger that calls core's runCron() every 10 minutes.
```

The scheduler tick (`runCron`) is **idempotent** — every send is guarded by a persisted marker — so it's safe on any at-least-once trigger.

### Porting to another ecosystem

Want sunup on AWS, Fly, a VPS, or bare Node? Add an `apps/<platform>` that provides three things:

1. **An HTTP entry** that hands Slack requests to [slack-edge](https://github.com/seratch/slack-edge) (runs on anything Web-standard) or any equivalent that verifies signatures and routes events
2. **A `Storage` implementation** (`packages/core/src/ports.ts` — ~25 straightforward methods; the D1 one in `apps/cloudflare/src/storage.ts` is the reference)
3. **A trigger** that calls `runCron(deps, new Date())` every 5–15 minutes

Core never imports platform code — PRs adding adapters are very welcome.

## Development

```sh
npm run typecheck   # all workspaces
npm test            # core unit tests (vitest)
npm run dev --workspace apps/cloudflare   # local Worker (pair with a tunnel for Slack callbacks)
```

**Demo data:** want the dashboard and digests to look lived-in without waiting three weeks? `apps/cloudflare/scripts/seed-demo.mjs` generates a fake 4-engineer team with realistic check-in history, blockers, moods, and kudos around your real standup (see its header for usage; `--cleanup` emits the SQL to remove it all).

For live Slack callbacks against a dev instance, either deploy a second Worker (e.g. `sunup-dev`) or run `wrangler dev` behind a tunnel (`cloudflared tunnel --url http://localhost:8787`) and point a dev Slack app's URLs at it.

## License

[MIT](LICENSE)
