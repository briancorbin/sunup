import type { Standup } from "../types";
import { isValidTimezone } from "../time";

export const CONFIG_MODAL_CALLBACK_ID = "sunup_config_modal";

export interface ConfigModalMetadata {
  standupId: number;
}

/** The loose shape of view_submission state values we read. */
export type ViewValues = Record<
  string,
  Record<
    string,
    {
      value?: string | null;
      selected_time?: string | null;
      selected_option?: { value: string } | null;
      selected_options?: Array<{ value: string }> | null;
    }
  >
>;

// Monday-first display order; values are JS weekday numbers (0 = Sunday).
const DAY_OPTIONS: Array<[string, string]> = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
];

const REMINDER_OPTIONS = [0, 15, 30, 45, 60, 90, 120];

function opt(value: string, label: string): { value: string; text: { type: string; text: string } } {
  return { value, text: { type: "plain_text", text: label } };
}

function input(blockId: string, label: string, element: Record<string, unknown>, opts?: { optional?: boolean; hint?: string }): unknown {
  return {
    type: "input",
    block_id: blockId,
    optional: opts?.optional ?? false,
    label: { type: "plain_text", text: label },
    ...(opts?.hint ? { hint: { type: "plain_text", text: opts.hint } } : {}),
    element: { action_id: "answer", ...element },
  };
}

export function buildConfigModal(standup: Standup): unknown {
  const reminderValues = REMINDER_OPTIONS.includes(standup.reminderMinutes)
    ? REMINDER_OPTIONS
    : [...REMINDER_OPTIONS, standup.reminderMinutes].sort((a, b) => a - b);
  const reminderLabel = (m: number) => (m === 0 ? "Off" : `${m} min before digest`);

  const metadata: ConfigModalMetadata = { standupId: standup.id };
  return {
    type: "modal",
    callback_id: CONFIG_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Sunup settings" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      input("name", "Check-in name", { type: "plain_text_input", initial_value: standup.name, max_length: 60 }),
      input("days", "Days", {
        type: "checkboxes",
        options: DAY_OPTIONS.map(([v, l]) => opt(v, l)),
        initial_options: DAY_OPTIONS.filter(([v]) => standup.scheduleDays.includes(Number(v))).map(([v, l]) => opt(v, l)),
      }),
      input("prompt_time", "Prompt time", { type: "timepicker", initial_time: standup.promptTime }),
      input("tz_mode", "Prompt people at that time in…", {
        type: "radio_buttons",
        options: [opt("user", "Each person's own timezone"), opt("fixed", "The check-in's timezone")],
        initial_option: standup.userTzPrompts
          ? opt("user", "Each person's own timezone")
          : opt("fixed", "The check-in's timezone"),
      }),
      input("digest_time", "Digest time", { type: "timepicker", initial_time: standup.digestTime }, {
        hint: "The digest always posts in the check-in's timezone.",
      }),
      input("timezone", "Check-in timezone", { type: "plain_text_input", initial_value: standup.timezone }, {
        hint: "IANA name, e.g. America/New_York or Europe/London.",
      }),
      input("reminder", "Reminder", {
        type: "static_select",
        options: reminderValues.map((m) => opt(String(m), reminderLabel(m))),
        initial_option: opt(String(standup.reminderMinutes), reminderLabel(standup.reminderMinutes)),
      }),
      input("mood", "Mood question", {
        type: "radio_buttons",
        options: [opt("on", "Ask how everyone's feeling (1–5)"), opt("off", "Skip it")],
        initial_option: standup.includeMood ? opt("on", "Ask how everyone's feeling (1–5)") : opt("off", "Skip it"),
      }),
      input(
        "questions",
        "Questions",
        { type: "plain_text_input", multiline: true, initial_value: standup.questions.join("\n") },
        { hint: "One per line. The last line is the blockers question." },
      ),
    ],
  };
}

/**
 * Validate + apply a config modal submission onto the existing standup.
 * `errors` is keyed by block_id, ready for Slack's response_action: "errors".
 */
export function parseConfigSubmission(standup: Standup, values: ViewValues): { standup: Standup; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = values.name?.answer?.value?.trim() ?? "";
  if (!name) errors.name = "Give the check-in a name.";

  const scheduleDays = (values.days?.answer?.selected_options ?? []).map((o) => Number(o.value));
  if (scheduleDays.length === 0) errors.days = "Pick at least one day.";

  const timezone = values.timezone?.answer?.value?.trim() ?? standup.timezone;
  if (!isValidTimezone(timezone)) errors.timezone = "Not a valid IANA timezone (e.g. America/New_York).";

  const questions = (values.questions?.answer?.value ?? "")
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  if (questions.length === 0) errors.questions = "At least one question.";

  return {
    standup: {
      ...standup,
      name: name || standup.name,
      scheduleDays: [...new Set(scheduleDays)].sort(),
      promptTime: values.prompt_time?.answer?.selected_time ?? standup.promptTime,
      digestTime: values.digest_time?.answer?.selected_time ?? standup.digestTime,
      timezone: isValidTimezone(timezone) ? timezone : standup.timezone,
      userTzPrompts: (values.tz_mode?.answer?.selected_option?.value ?? (standup.userTzPrompts ? "user" : "fixed")) === "user",
      reminderMinutes: Number(values.reminder?.answer?.selected_option?.value ?? standup.reminderMinutes),
      includeMood: (values.mood?.answer?.selected_option?.value ?? (standup.includeMood ? "on" : "off")) === "on",
      questions: questions.length > 0 ? questions : standup.questions,
    },
    errors,
  };
}
