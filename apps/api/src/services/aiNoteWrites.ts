/**
 * Tier-2 note writes that run without the per_step approval card in an
 * interactive chat, with or without a Wisp grant. (A helper session never
 * reaches this: PAM gates it earlier in the same function.)
 *
 *   set_device_context   appends one note (issue, quirk, follow-up, preference)
 *                        to a device's context. The write is a bare insert: it
 *                        never edits, hides or deletes an existing note and
 *                        sends nothing to the device.
 *
 * Why a note written from injected tool output is still safe to READ: notes
 * return to a model through get_device_context, the device-page system-prompt
 * preload (aiAgent.ts buildSystemPrompt) and get_alert_correlations `explain`
 * (RCA evidence). Each path sanitises the note text and fences it as untrusted
 * data. A new reader of brain_device_context must do the same.
 *
 * What the card used to stop (#11986): notes are org-wide and persistent, and
 * both model-facing readers (get_device_context and the device-page preload)
 * render a device's active notes newest-first into ONE untrusted-data block
 * cut at UNTRUSTED_BLOCK_MAX_LENGTH (16,000) characters. A run of large junk
 * notes would fill that block and push every older note out of view. RCA
 * (alertCorrelationRca.ts) reads 10 notes. The card-free path (and, in a chat,
 * the unattended-reads path for the same note) is therefore bounded, and past
 * any bound the note falls back to the card (a person can still approve it;
 * nothing is refused):
 *   - per conversation: NOTE_WRITE_AUTO_MAX_PER_SESSION card-free notes,
 *     counted from `ai_tool_executions` (rows of this session that ran with no
 *     recorded approver), so the count survives a session rebuild, a restart
 *     and a deploy;
 *   - per device, active notes: none while the device has
 *     NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE or more active (unresolved,
 *     unexpired) notes from any path;
 *   - per device, per day: none once the device has
 *     NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY notes written in the last 24 h;
 *   - content: `summary` is capped at 255 by the input schema; `details`
 *     must pretty-print (2-space JSON, the larger of the readers' two
 *     renderings) to at most NOTE_WRITE_AUTO_MAX_DETAILS_CHARS characters;
 *   - expiry: at most NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS days; a note with no
 *     expiry is given that one. A longer expiry asks.
 * The device counts run AFTER the org/site/device access check, under the
 * caller's RLS, and are counted again by the handler under a per-device
 * advisory lock in the insert's own transaction, so calls that run in
 * parallel cannot all pass a count taken before any of them wrote. A call
 * that loses that recount writes nothing and tells the model to call again,
 * which then shows the card. A failed count asks.
 *
 * Why K = NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE = 8 (the reader arithmetic,
 * get_device_context, the larger of the two renderings, per note):
 *   "[ACTIVE] PREFERENCE: " 21 + summary 255 + "\nDetails: " 10 + details 200
 *   + "\nRecorded: <iso> | ID: <uuid>" 78 + separator 7 = 571 characters.
 * The sanitiser can grow text where it swaps "System:" (7) for "[filtered]"
 * (10), at most x10/7 on the summary and details: 21 + 365 + 10 + 286 + 78 +
 * 7 = 767, budgeted as 800. K card-free notes therefore take at most
 * 8 x 800 = 6,400 of the 16,000-character block (40%), leaving 9,600 for older
 * notes: more than two maximum-size approved notes (each at most ~3,350:
 * summary 365, details clipped at 2,000 then grown to ~2,860, framing ~120).
 * The reader tests (aiToolsDevice.contextSanitize.test.ts,
 * aiAgent.deviceMemory.test.ts) render both readers with K maximum-size
 * card-free notes in front of a large older note and check it stays in view. Tool rate limit (aiToolRateLimits.ts) still applies on top.
 *
 * `createSessionPreToolUse` (aiAgentSdk.ts) applies this with the read-only
 * path's exclusions (#3130): never on a paused session, never as an unmatched
 * step of an active plan, never for a tenant or flow tool of the same name.
 * The tool KEEPS Tier 2: the executing `ai_tool_executions` row, RBAC
 * (`devices:write`), the site-scope check in the handler, the rate limits and,
 * in a Wisp chat, the ceiling gate all still apply, and it stays a write
 * everywhere else (NOT `TIER2_READONLY_TOOLS`, so MCP hints and agent
 * allowlists are unchanged). A Tier-3 resolution never takes the path.
 *
 * Deliberately NOT here:
 *   - `resolve_device_context`: hides a note from every later session.
 *   - `manage_tags`: changes what device filters and policies match.
 *
 * CONTRACT (aiNoteWrites.contract.test.ts): every entry is a registered Tier-2
 * tool with no action multiplexing, no per-action tier entry, and no read-only
 * classification.
 *
 * Leaf module — NO imports — so the chat gate can read it cheaply.
 */
export const TIER2_NOTE_WRITE_TOOLS: ReadonlySet<string> = new Set<string>(['set_device_context']);

/** Card-free note writes per chat session; the next one shows the card. */
export const NOTE_WRITE_AUTO_MAX_PER_SESSION = 10;

/** Notes written on one device in the last 24 h after which a note shows the card. */
export const NOTE_WRITE_AUTO_MAX_PER_DEVICE_PER_DAY = 5;

/**
 * Active (unresolved, unexpired) notes on one device at or above which a note
 * shows the card. The arithmetic for 8 is in the header.
 */
export const NOTE_WRITE_AUTO_MAX_ACTIVE_PER_DEVICE = 8;

/** Largest `details` a card-free note may carry, as 2-space pretty-printed JSON. */
export const NOTE_WRITE_AUTO_MAX_DETAILS_CHARS = 200;

/** Longest expiry a card-free note may have; also the expiry given to one that names none. */
export const NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS = 30;

/** The tool whose ledger rows the per-conversation bound counts. */
export const NOTE_WRITE_AUTO_MAX_PER_SESSION_TOOL = 'set_device_context';

/** Returned by the handler when a card-free note arrives in a state the gate should have prevented. */
export const NOTE_WRITE_UNAVAILABLE_MESSAGE = 'This note was not saved because of an internal error. Tell the user it was not saved.';

/** Returned by the handler when the locked recount finds the device past a bound. */
export const NOTE_WRITE_NEEDS_APPROVAL_MESSAGE =
  'This note was not saved: the device already has as many notes as can be added without approval. '
  + 'Call set_device_context again to ask the user to approve it.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The content bounds of a card-free note: a device id to count against,
 * `details` absent or small, and an expiry absent or short. Anything else asks.
 */
export function noteWriteFitsContentBounds(input: Record<string, unknown>): boolean {
  if (typeof input.deviceId !== 'string' || !UUID_RE.test(input.deviceId)) return false;
  const days = input.expiresInDays;
  if (days !== undefined && days !== null) {
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS) return false;
  }
  if (input.details === undefined || input.details === null) return true;
  let serialised: string | undefined;
  try {
    // Pretty-printed is never shorter than compact, so this bounds both readers.
    serialised = JSON.stringify(input.details, null, 2);
  } catch {
    return false;
  }
  return typeof serialised === 'string' && serialised.length <= NOTE_WRITE_AUTO_MAX_DETAILS_CHARS;
}

/** The expiry, in days, a card-free note is written with. */
export function noteWriteCardFreeExpiryDays(input: Record<string, unknown>): number {
  const days = input.expiresInDays;
  return typeof days === 'number' ? days : NOTE_WRITE_AUTO_MAX_EXPIRY_DAYS;
}
