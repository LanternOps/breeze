/**
 * Pure presentation logic for the chat tool row (#5107).
 *
 * Split out of `ToolIndicator.tsx` because this app has no React Native test
 * runtime: `vitest.config.ts` deliberately includes only `.ts` so component
 * imports never pull RN/Expo into Vitest. Anything worth asserting therefore
 * lives here, and the `.tsx` is left as markup over these functions.
 */

/**
 * Terminal states a completed tool row can be in.
 *
 * `approved` is the one this file exists for: the user approved a tier-3
 * action on their phone, the durable approval worker took it, and the live
 * chat session declined to run it a second time. The API reports that with
 * `isError: false` and `status: 'approved_executing'` — see
 * `apps/api/src/services/aiToolHandoff.ts`. Before that it was an error
 * result, so the chat painted `MANAGE_SERVICES · FAILED` in deny-red at the
 * exact moment the user had just said yes.
 */
export type ToolRowStatus = 'completed' | 'approved' | 'denied' | 'failed';

/** The wire literal. Must match `APPROVED_EXECUTING_STATUS` on the API. */
export const APPROVED_EXECUTING_STATUS = 'approved_executing';

function errorText(output: unknown): string {
  if (!output || typeof output !== 'object') return '';
  const value = (output as { error?: unknown }).error;
  return typeof value === 'string' ? value : '';
}

const MAX_TOOL_ROW_ERROR_TEXT_LENGTH = 400;

/**
 * The human-readable error text for a FAILED/DENIED tool row (#5170). Rows in
 * those states had no expand affordance at all — see the comment on
 * `toolRowStatus` above, written when this row was still unreachable.
 * `output.error` wins over `output.message` since that's the field
 * `errorText()` above already trusts as the tool's own error string.
 */
export function toolRowErrorText(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const obj = output as { error?: unknown; message?: unknown };
  const raw =
    typeof obj.error === 'string' ? obj.error : typeof obj.message === 'string' ? obj.message : null;
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length <= MAX_TOOL_ROW_ERROR_TEXT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_TOOL_ROW_ERROR_TEXT_LENGTH)}…`;
}

/**
 * Heuristic, and deliberately still a heuristic: a permission-style error
 * reads as DENIED, everything else as FAILED. Unlike the approval handoff
 * above, an approval REJECTION carries no dedicated marker on the wire yet, so
 * this remains a text sniff over the known rejection phrases the SDK emits.
 */
function isDenialText(output: unknown): boolean {
  const lower = errorText(output).toLowerCase();
  if (!lower) return false;
  return lower.includes('rejected') || lower.includes('denied') || lower.includes('not approved');
}

/**
 * Classifies a completed tool event.
 *
 * TRUST ORDER MATTERS. `event.handoff` is set by the server's own pre-tool-use
 * gate and is the only authoritative signal; `output.status` is a FALLBACK for
 * rows replayed from history, where the SSE-level field is not persisted.
 *
 * The fallback is gated on `!isError` on purpose. A tool owns its own output
 * payload, so an ungated shape check would let any tool — a buggy one, or a
 * third-party extension — emit `{ error: 'restart failed', status:
 * 'approved_executing' }` and have the chat paint its genuine failure as an
 * approved, in-flight action. On mobile that is unrecoverable: this row has no
 * expand affordance, so the error text would be unreachable in the UI. Nothing
 * is lost by the gate: a server that predates the handoff contract sends no
 * `status` field at all, so there was never a real stale-server case for it to
 * rescue.
 */
export function toolRowStatus(event: {
  isError?: boolean;
  output?: unknown;
  handoff?: string;
}): ToolRowStatus {
  const { output, isError, handoff } = event;
  if (handoff === APPROVED_EXECUTING_STATUS) return 'approved';
  if (!isError) {
    return typeof output === 'object' &&
      output !== null &&
      (output as { status?: unknown }).status === APPROVED_EXECUTING_STATUS
      ? 'approved'
      : 'completed';
  }
  return isDenialText(output) ? 'denied' : 'failed';
}

/** The caption printed after the tool label. */
export function toolRowSuffix(status: ToolRowStatus): string {
  switch (status) {
    case 'approved':
      return 'APPROVED · RUNNING';
    case 'denied':
      return 'DENIED';
    case 'failed':
      return 'FAILED';
    case 'completed':
      return 'DONE';
  }
}

// ---------------------------------------------------------------------------
// Tool labels
// ---------------------------------------------------------------------------
//
// MIRROR of `packages/shared/src/utils/aiToolLabels.ts`. This app has no
// `@breeze/shared` dependency on purpose (Metro/RN bundling) — the same
// constraint already documented on `services/ticketPushPrefs.ts` and
// `services/ticketAttachmentContract.ts`. Keep the two tables in step when you
// touch either; drift here degrades a caption, never behaviour.

export type AiToolLabelState = 'running' | 'completed';

const VERB_FORMS: Record<string, readonly [running: string, completed: string]> = {
  acknowledge: ['Acknowledging', 'Acknowledged'],
  analyze: ['Analyzing', 'Analyzed'],
  apply: ['Applying', 'Applied'],
  assign: ['Assigning', 'Assigned'],
  browse: ['Browsing', 'Browsed'],
  cancel: ['Cancelling', 'Cancelled'],
  capture: ['Capturing', 'Captured'],
  collect: ['Collecting', 'Collected'],
  configure: ['Configuring', 'Configured'],
  create: ['Creating', 'Created'],
  detect: ['Detecting', 'Detected'],
  execute: ['Running', 'Ran'],
  generate: ['Generating', 'Generated'],
  get: ['Checking', 'Checked'],
  list: ['Listing', 'Listed'],
  lookup: ['Looking up', 'Looked up'],
  manage: ['Updating', 'Updated'],
  preview: ['Previewing', 'Previewed'],
  query: ['Searching', 'Searched'],
  remediate: ['Remediating', 'Remediated'],
  remove: ['Removing', 'Removed'],
  request: ['Requesting', 'Requested'],
  resolve: ['Resolving', 'Resolved'],
  restore: ['Restoring', 'Restored'],
  revoke: ['Revoking', 'Revoked'],
  run: ['Running', 'Ran'],
  search: ['Searching', 'Searched'],
  set: ['Setting', 'Set'],
  sync: ['Syncing', 'Synced'],
  take: ['Capturing', 'Captured'],
  test: ['Testing', 'Tested'],
  trigger: ['Starting', 'Started'],
};

function toolNameWords(toolName: string): string[] {
  const trimmed = toolName.trim();
  const bare = trimmed.includes('__') ? (trimmed.split('__').filter(Boolean).pop() ?? '') : trimmed;
  return bare.split('_').filter(Boolean);
}

/** `get_fleet_findings` → "Get fleet findings". Never empty. */
export function titleCaseToolName(toolName: string): string {
  const words = toolNameWords(toolName);
  if (words.length === 0) return 'Tool';
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * `input.action` values that mean the call only read data despite the tool's
 * leading verb (`manage_automations` with `action: 'list'` mutates nothing).
 * MIRROR of the same set in `packages/shared/src/utils/aiToolLabels.ts`.
 */
const READ_ONLY_ACTIONS = new Set([
  'list',
  'get',
  'search',
  'status',
  'show',
  'read',
  'query',
  'describe',
  'check',
  'preview',
  'view',
]);

function isReadOnlyAction(input: Record<string, unknown> | undefined): boolean {
  const action = input?.action;
  return typeof action === 'string' && READ_ONLY_ACTIONS.has(action.toLowerCase());
}

/**
 * `aiToolLabel('manage_alerts', 'completed')` → "Updated alerts". Falls back
 * to title case for any tool that does not begin with a known verb, so a newly
 * registered tool never renders as a raw identifier again.
 *
 * `input` is the tool call's arguments. When `input.action` is a read-only
 * verb (list/get/search/…), the row renders with the `get` conjugation
 * regardless of the tool name's own leading verb (#5170).
 */
export function aiToolLabel(
  toolName: string,
  state: AiToolLabelState,
  input?: Record<string, unknown>,
): string {
  const words = toolNameWords(toolName);
  if (words.length === 0) return 'Tool';

  const forms = isReadOnlyAction(input) ? VERB_FORMS.get : VERB_FORMS[words[0].toLowerCase()];
  const subject = words.slice(1).join(' ');
  if (!forms || !subject) return titleCaseToolName(toolName);

  return `${state === 'running' ? forms[0] : forms[1]} ${subject}`;
}
