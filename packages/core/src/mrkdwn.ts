/**
 * Escape user-supplied text for Slack mrkdwn. Slack parses `<…>` as links,
 * mentions and special commands (`<!channel>`), and `&` as the start of an
 * entity — so every answer, blocker, kudos message, name or question that
 * people type must go through here before it lands in a `mrkdwn` text object
 * or a message `text` field. plain_text objects are NOT parsed and must not
 * be escaped.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
