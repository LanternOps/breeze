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
 * The handoff check is on the STATUS FIELD and is checked FIRST — before
 * `isError` — so a stale server, or an older message row replayed out of
 * history, still renders as approved rather than reverting to red. Everything
 * else keeps the previous behaviour exactly.
 */
export function toolRowStatus(event: { isError?: boolean; output?: unknown }): ToolRowStatus {
  const { output, isError } = event;
  if (
    typeof output === 'object' &&
    output !== null &&
    (output as { status?: unknown }).status === APPROVED_EXECUTING_STATUS
  ) {
    return 'approved';
  }
  if (!isError) return 'completed';
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
 * `aiToolLabel('manage_alerts', 'completed')` → "Updated alerts". Falls back
 * to title case for any tool that does not begin with a known verb, so a newly
 * registered tool never renders as a raw identifier again.
 */
export function aiToolLabel(toolName: string, state: AiToolLabelState): string {
  const words = toolNameWords(toolName);
  if (words.length === 0) return 'Tool';

  const forms = VERB_FORMS[words[0].toLowerCase()];
  const subject = words.slice(1).join(' ');
  if (!forms || !subject) return titleCaseToolName(toolName);

  return `${state === 'running' ? forms[0] : forms[1]} ${subject}`;
}
