#!/usr/bin/env node
/**
 * Generate demo data SQL for a sunup standup: a fake team of engineers with
 * ~3 weeks of check-in history, blockers, moods, and kudos. Useful for demoing
 * the digest, App Home dashboard, and leaderboard without waiting weeks.
 *
 * Usage:
 *   node scripts/seed-demo.mjs --standup 2 --user U012REALUSER --channel C012CHANNEL > /tmp/seed.sql
 *   npx wrangler d1 execute sunup --remote --file /tmp/seed.sql
 *
 * Idempotent: uses INSERT OR IGNORE, so re-running is safe. Only writes PAST
 * weekdays — today's run stays owned by the live scheduler.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const STANDUP_ID = Number(args.standup);
const REAL_USER = args.user;
const CHANNEL = args.channel;
const DAYS = Number(args.days ?? 15);
if ("cleanup" in args) {
  // Remove everything the seed created (demo users all start with U0DEMO).
  console.log(
    [
      "DELETE FROM participants WHERE user_id LIKE 'U0DEMO%';",
      "DELETE FROM run_participants WHERE user_id LIKE 'U0DEMO%';",
      "DELETE FROM responses WHERE user_id LIKE 'U0DEMO%';",
      "DELETE FROM kudos WHERE from_user LIKE 'U0DEMO%' OR to_user LIKE 'U0DEMO%';",
    ].join("\n"),
  );
  process.exit(0);
}
if (!STANDUP_ID || !REAL_USER || !CHANNEL) {
  console.error("Usage: seed-demo.mjs --standup <id> --user <U...> --channel <C...> [--days 15]  (or --cleanup)");
  process.exit(1);
}

// Deterministic PRNG so re-runs produce the same data.
let seed = 0x5eed;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const TEAM = [
  {
    id: REAL_USER,
    yesterday: [
      "Reviewed the storage-port PR and got the retention purge merged",
      "Paired on the digest formatting bug, shipped the fix",
      "Cleaned up the cron idempotency edge cases, added tests",
      "Wrote the porting guide for alternate ecosystems",
    ],
    today: [
      "Wiring up the App Home participation view",
      "Cutting the 0.2 release and updating the README",
      "Triaging the timezone rollover reports",
      "Heads-down on the reminder scheduling logic",
    ],
    blockers: ["none", "none", "none", "Waiting on a review for the migrations PR"],
  },
  {
    id: "U0DEMOBACK1", // Priya — backend
    yesterday: [
      "Shipped the payments reconciliation job, backfilled 30 days",
      "Fixed the N+1 on the invoices endpoint — p95 down 40%",
      "Migrated the orders table to the new schema behind a flag",
      "Got the webhook retry queue draining cleanly again",
    ],
    today: [
      "Rolling the schema flag to 100% and watching error rates",
      "Writing the idempotency-key RFC for the payments API",
      "Load-testing checkout ahead of the launch",
      "Pairing with mobile on the receipts endpoint contract",
    ],
    blockers: ["none", "none", "Waiting on data eng for the events backfill", "Staging DB creds expired again"],
  },
  {
    id: "U0DEMOFRONT", // Marcus — frontend
    yesterday: [
      "Rebuilt the settings page on the new form primitives",
      "Fixed the dashboard flicker on theme switch",
      "Got Storybook coverage for the checkout flow",
      "Shaved 180KB off the vendor bundle",
    ],
    today: [
      "Accessibility pass on the modals — focus traps everywhere",
      "Implementing the empty states from Thursday's design review",
      "Migrating the last class components off the legacy router",
      "Demo prep for the design sync",
    ],
    blockers: ["none", "Blocked on final copy for the onboarding screens", "none", "none"],
  },
  {
    id: "U0DEMOINFRA", // Sam — infra
    yesterday: [
      "Moved CI caches to the new runners — builds ~4 min faster",
      "Terraformed the staging environment parity gaps",
      "Rotated the service-mesh certs, zero downtime",
      "Chased down the flaky e2e suite — it was DNS. It's always DNS",
    ],
    today: [
      "Rolling out the autoscaler tweaks to prod",
      "Writing the on-call runbook for the queue backlog alert",
      "Upgrading the k8s node pools canary-first",
      "Cost review — tracking down the egress spike",
    ],
    blockers: ["none", "none", "Waiting on security sign-off for the IAM changes", "Flaky CI is back on the integration suite"],
  },
  {
    id: "U0DEMOMOBIL", // Dana — mobile
    yesterday: [
      "Fixed the Android cold-start regression from the RN bump",
      "Shipped 3.14 to the app stores, staged rollout at 20%",
      "Got Detox green on the new checkout flow",
      "Profiled the list jank on older iPhones — memoization won",
    ],
    today: [
      "Watching crash-free rates on the 3.14 rollout",
      "Deep-link handling for the campaign launch",
      "Upgrading to the new architecture behind a flag",
      "Pairing with Priya on the receipts endpoint",
    ],
    blockers: ["none", "App review has been 'In Review' for 3 days", "none", "Waiting on the API contract for receipts"],
  },
];

const KUDOS = [
  [TEAM[1].id, TEAM[3].id, "for the CI cache work — the whole team feels it"],
  [REAL_USER, TEAM[1].id, "for calmly unbricking the webhook queue at 5pm on a Friday"],
  [TEAM[2].id, REAL_USER, "for the cleanest code review comments I've ever gotten"],
  [TEAM[4].id, TEAM[2].id, "for jumping on the theme flicker even though it wasn't yours"],
  [TEAM[3].id, TEAM[4].id, "for the cold-start fix — startup feels instant now"],
  [TEAM[1].id, REAL_USER, "for the porting guide — onboarding docs that actually onboard"],
  [REAL_USER, TEAM[3].id, "It was DNS. It's always DNS. Thanks for proving it"],
  [TEAM[4].id, TEAM[1].id, "for pairing on the receipts contract — saved me a week"],
  [TEAM[2].id, TEAM[3].id, "for the staging parity fixes, previews finally match prod"],
  [REAL_USER, TEAM[2].id, "for the a11y pass — tab order is chef's kiss"],
];

// Last N weekdays strictly before today (local time — close enough for demo data).
const dates = [];
const cursor = new Date();
while (dates.length < DAYS) {
  cursor.setDate(cursor.getDate() - 1);
  const dow = cursor.getDay();
  if (dow !== 0 && dow !== 6) dates.push(cursor.toISOString().slice(0, 10));
}
dates.reverse();

const lines = ["-- sunup demo seed (generated by scripts/seed-demo.mjs)"];

for (const member of TEAM) {
  if (member.id === REAL_USER) continue;
  lines.push(
    `INSERT OR IGNORE INTO participants (standup_id, user_id, tz) VALUES (${STANDUP_ID}, ${q(member.id)}, 'America/New_York');`,
  );
}

for (const date of dates) {
  lines.push(`INSERT OR IGNORE INTO runs (standup_id, run_date, digest_posted_at) VALUES (${STANDUP_ID}, ${q(date)}, ${q(`${date}T15:30:00.000Z`)});`);
  const runRef = `(SELECT id FROM runs WHERE standup_id = ${STANDUP_ID} AND run_date = ${q(date)})`;
  for (const member of TEAM) {
    // Everyone was prompted; ~88% responded (the real user always did — enjoy the streak).
    lines.push(
      `INSERT OR IGNORE INTO run_participants (run_id, user_id, prompted_at, reminded_at) VALUES (${runRef}, ${q(member.id)}, ${q(`${date}T13:00:00.000Z`)}, NULL);`,
    );
    if (member.id !== REAL_USER && rand() < 0.12) continue;
    const idx = Math.floor(rand() * member.yesterday.length);
    const blocker = rand() < 0.22 ? pick(member.blockers.filter((b) => b !== "none")) ?? "none" : "none";
    const answers = JSON.stringify([member.yesterday[idx], member.today[idx], blocker]);
    const mood = blocker === "none" ? pick([3, 4, 4, 5, 5]) : pick([2, 3, 3]);
    const minute = String(Math.floor(rand() * 50) + 10).padStart(2, "0");
    lines.push(
      `INSERT OR IGNORE INTO responses (run_id, user_id, answers, mood, submitted_at) VALUES (${runRef}, ${q(member.id)}, ${q(answers)}, ${mood}, ${q(`${date}T13:${minute}:00.000Z`)});`,
    );
  }
}

KUDOS.forEach(([from, to, message], i) => {
  const date = dates[Math.floor((i / KUDOS.length) * dates.length)];
  lines.push(
    `INSERT OR IGNORE INTO kudos (from_user, to_user, message, channel_id, created_at) VALUES (${q(from)}, ${q(to)}, ${q(message)}, ${q(CHANNEL)}, ${q(`${date}T18:00:00.000Z`)});`,
  );
});

console.log(lines.join("\n"));
