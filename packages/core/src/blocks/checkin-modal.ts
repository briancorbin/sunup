import type { Blocker, CheckinResponse, Run, Standup } from "../types";
import { blockerAgeDays, kindBehavior } from "../types";
import { formatRunDate } from "../time";

export const CHECKIN_MODAL_CALLBACK_ID = "sunup_checkin_modal";
export const START_CHECKIN_ACTION_ID = "sunup_start_checkin";
export const BLOCKER_RESOLVED_ACTION_ID = "sunup_blocker_resolved";
export const BLOCKER_STILL_ACTION_ID = "sunup_blocker_still";

export interface CheckinModalMetadata {
  standupId: number;
  runId: number;
}

const MOOD_OPTIONS = [
  { value: "5", label: "😄 Great" },
  { value: "4", label: "🙂 Good" },
  { value: "3", label: "😐 Okay" },
  { value: "2", label: "😕 Meh" },
  { value: "1", label: "😫 Rough" },
];

export function buildCheckinModal(standup: Standup, run: Run, existing: CheckinResponse | null): unknown {
  const blocks: unknown[] = standup.questions.map((question, i) => {
    const isBlockersQuestion = i === standup.questions.length - 1;
    return {
      type: "input",
      block_id: `q_${i}`,
      optional: isBlockersQuestion,
      label: { type: "plain_text", text: question.slice(0, 150) },
      element: {
        type: "plain_text_input",
        action_id: "answer",
        multiline: true,
        ...(existing?.answers[i] ? { initial_value: existing.answers[i] } : {}),
      },
    };
  });

  if (standup.includeMood) {
    const initial = existing?.mood ? MOOD_OPTIONS.find((o) => o.value === String(existing.mood)) : undefined;
    blocks.push({
      type: "input",
      block_id: "mood",
      optional: true,
      label: { type: "plain_text", text: "How are you feeling today?" },
      element: {
        type: "radio_buttons",
        action_id: "answer",
        options: MOOD_OPTIONS.map((o) => ({ value: o.value, text: { type: "plain_text", text: o.label } })),
        ...(initial ? { initial_option: { value: initial.value, text: { type: "plain_text", text: initial.label } } } : {}),
      },
    });
  }

  const metadata: CheckinModalMetadata = { standupId: standup.id, runId: run.id };
  return {
    type: "modal",
    callback_id: CHECKIN_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: standup.name.slice(0, 24) },
    submit: { type: "plain_text", text: existing ? "Update" : "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${kindBehavior(standup).emoji} Check-in for *${formatRunDate(run.runDate)}*` }],
      },
      ...blocks,
    ],
  };
}

/**
 * DM prompt with the "Start check-in" button. When the user has an open
 * blocker from a previous day, a follow-up asks whether it's resolved.
 */
export function buildPromptMessage(
  standup: Standup,
  runId: number,
  isReminder: boolean,
  openBlocker?: Blocker,
  todayDate?: string,
): { text: string; blocks: unknown[] } {
  const text = isReminder
    ? `⏰ Friendly nudge — your *${standup.name}* check-in hasn't been submitted yet.`
    : kindBehavior(standup).greeting(standup.name);
  const blocks: unknown[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          action_id: START_CHECKIN_ACTION_ID,
          value: String(runId),
          text: { type: "plain_text", text: "Start check-in" },
        },
      ],
    },
  ];

  if (openBlocker) {
    const age = todayDate ? blockerAgeDays(openBlocker, todayDate) : null;
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚧 You said this was blocking you${age && age > 2 ? ` (*${age} days* now)` : ""}:\n> ${openBlocker.text.split("\n")[0]}\nStill blocked?`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            action_id: BLOCKER_RESOLVED_ACTION_ID,
            value: String(openBlocker.id),
            text: { type: "plain_text", text: "✅ Resolved" },
          },
          {
            type: "button",
            action_id: BLOCKER_STILL_ACTION_ID,
            value: String(openBlocker.id),
            text: { type: "plain_text", text: "😤 Still blocked" },
          },
        ],
      },
    );
  }

  return { text, blocks };
}
