/**
 * Bounds on a device note (`set_device_context`) that is written with no
 * person approving it (#12140). They apply where
 * `ToolExecutionContext.unattendedNoteWrite` is set, which today is only the
 * MCP server's direct Tier-2 dispatch of this tool (routes/mcpServer.ts). A
 * note written in the in-app chat behind the approval card has none of these
 * bounds. Other callers that can reach the tool with no person approving it
 * (agent runs, flow steps, Wisp unattended reads) do not set the flag and are
 * not bounded here.
 *
 * Why: notes are persistent and org-wide, and every later prompt that loads a
 * device's notes reads them (get_device_context, the device-page preload,
 * get_alert_correlations `explain`). Unbounded unattended writes grow storage
 * and those prompts, and the readers cut the notes block at a fixed size,
 * newest first, so a run of large notes pushes older ones out of view.
 *
 * The numbers are the card-free note bounds of #11987 (aiNoteWrites.ts there),
 * where the reader arithmetic for 8 x 200 lives: 8 maximum-size notes take at
 * most 6,400 of the 16,000-character untrusted-data block.
 *   - content (the handler): `details` at most UNATTENDED_NOTE_MAX_DETAILS_CHARS
 *     characters as 2-space pretty JSON (never shorter than compact, so it
 *     bounds both readers); `summary` is already capped at 255 by the schema;
 *   - expiry (the handler): at most UNATTENDED_NOTE_MAX_EXPIRY_DAYS days, and a
 *     note that names none is given that expiry, so the active-note cap clears
 *     itself;
 *   - active notes (the service, brainDeviceContext.ts): none while the device
 *     has UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE or more active (unresolved,
 *     unexpired) notes from any path, counted under a per-device advisory lock
 *     in the insert's own transaction so parallel calls cannot all pass a count
 *     taken before any of them wrote.
 * Past a bound the call is refused with a message that says what to do; there
 * is no card to fall back to. The tool rate limit (aiToolRateLimits.ts) still
 * applies on top.
 *
 * Leaf module — NO imports.
 */

/** Active (unresolved, unexpired) notes on one device at or above which an unattended note is refused. */
export const UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE = 8;

/** Largest `details` an unattended note may carry, as 2-space pretty-printed JSON. */
export const UNATTENDED_NOTE_MAX_DETAILS_CHARS = 200;

/** Longest expiry an unattended note may have; also the expiry given to one that names none. */
export const UNATTENDED_NOTE_MAX_EXPIRY_DAYS = 30;

/** Returned when the device already has the maximum active notes. */
export const UNATTENDED_NOTE_ACTIVE_LIMIT_MESSAGE =
  `This note was not saved: the device already has ${UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE} active notes, `
  + 'the most a note written without approval can add to. Resolve a note that no longer applies with '
  + 'resolve_device_context, or add this note from the Breeze web app.';

/** Returned when the write cannot be bounded safely (a wiring fault, not a bound). */
export const UNATTENDED_NOTE_UNAVAILABLE_MESSAGE =
  'This note was not saved because of an internal error. Tell the user it was not saved.';

/**
 * Why an unattended note's content is refused, or null when it fits. The
 * message names the field and the limit so the caller can retry.
 */
export function unattendedNoteContentError(input: Record<string, unknown>): string | null {
  const days = input.expiresInDays;
  if (days !== undefined && days !== null) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > UNATTENDED_NOTE_MAX_EXPIRY_DAYS) {
      return `expiresInDays must be a whole number from 1 to ${UNATTENDED_NOTE_MAX_EXPIRY_DAYS} for a note written without approval; `
        + `leave it out to get ${UNATTENDED_NOTE_MAX_EXPIRY_DAYS} days.`;
    }
  }
  if (input.details === undefined || input.details === null) return null;
  if (typeof input.details !== 'object' || Array.isArray(input.details)) {
    return 'details must be a JSON object.';
  }
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(input.details, null, 2);
  } catch {
    // A cycle or a BigInt; tool input parsed from JSON has neither.
    serialised = undefined;
  }
  if (typeof serialised !== 'string') {
    return 'details must be a JSON object.';
  }
  if (serialised.length > UNATTENDED_NOTE_MAX_DETAILS_CHARS) {
    return `details is too large for a note written without approval: at most ${UNATTENDED_NOTE_MAX_DETAILS_CHARS} `
      + `characters as 2-space JSON (this one is ${serialised.length}). Shorten it, or keep the essentials in summary.`;
  }
  return null;
}

/** The expiry, in days, an unattended note is written with (call after `unattendedNoteContentError`). */
export function unattendedNoteExpiryDays(input: Record<string, unknown>): number {
  const days = input.expiresInDays;
  return typeof days === 'number' ? days : UNATTENDED_NOTE_MAX_EXPIRY_DAYS;
}
