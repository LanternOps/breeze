/**
 * Cheap, pre-parse detection of whether a raw agent WS text frame carries
 * TERMINAL STATUS (`command_result`, `update_status`) — used to route the
 * frame to its own message-rate budget lane (`agentWsMessageBudget.ts`)
 * BEFORE paying for a full `JSON.parse` + schema-validate of a message that
 * might get dropped anyway.
 *
 * Deliberately a regex over a BOUNDED PREFIX of the raw string, not a full
 * JSON.parse: the whole point of checking the budget before the real parse
 * is to avoid spending parse+validate cost — proportional to the WHOLE
 * frame, which can be several MB for a real command_result — on a flooding
 * connection. `JSON.parse` still happens exactly once per frame, in the
 * normal message-handling path; this only decides which budget bucket a
 * frame is charged against, and does so by looking at a small, fixed-size
 * window rather than the entire (agent-controlled, effectively unbounded)
 * frame.
 *
 * The regex is ANCHORED to the start of the object and the window is
 * bounded to `SNIFF_PREFIX_CHARS` — both of the real message shapes this
 * classifies (`CommandResult`'s Go struct, `update_status`'s map) always
 * marshal `type` as the first key, well within that window. This closes the
 * false-positive vector a plain substring scan had: a `"type":"..."`
 * occurrence anywhere in the frame — including inside a user-influenced
 * string field value (command stdout, a terminal_output chunk) far from the
 * start — no longer misroutes an unrelated frame into the terminal-state
 * lane, because only a `type` key sitting immediately after the opening
 * brace, near the very start of the frame, is trusted. A frame that is not
 * shaped like a real envelope (type not first, or not found in the window)
 * returns null — routing to the general lane, the safe default — rather than
 * guessing from whatever text happens to be nearby.
 */

const TERMINAL_MESSAGE_TYPES = new Set(['command_result', 'update_status']);

/** Bytes of the raw frame examined — comfortably covers `{"type":"command_result",` plus formatting slack, nowhere near enough to reach a real payload field. */
const SNIFF_PREFIX_CHARS = 256;

// Anchored to the start of the (possibly whitespace-padded) object and to
// `type` being the FIRST key — not merely present somewhere in the prefix.
const TYPE_SNIFF_RE = /^\s*\{\s*"type"\s*:\s*"([a-zA-Z0-9_-]+)"/;
const COMMAND_ID_SNIFF_RE = /"commandId"\s*:\s*"([^"]{0,200})"/;

/**
 * Returns the sniffed `type` field when it names a terminal-state message
 * type, else null (covers "not terminal", "couldn't tell", and "not shaped
 * like a real envelope" — all three route to the general budget, the
 * conservative default).
 */
export function sniffTerminalMessageType(raw: string): 'command_result' | 'update_status' | null {
  const prefix = raw.length > SNIFF_PREFIX_CHARS ? raw.slice(0, SNIFF_PREFIX_CHARS) : raw;
  const match = TYPE_SNIFF_RE.exec(prefix);
  const type = match?.[1];
  return type && TERMINAL_MESSAGE_TYPES.has(type) ? (type as 'command_result' | 'update_status') : null;
}

/** Best-effort commandId for a log line / error frame — never throws, never trusted beyond that. */
export function sniffCommandId(raw: string): string | undefined {
  return COMMAND_ID_SNIFF_RE.exec(raw)?.[1];
}
