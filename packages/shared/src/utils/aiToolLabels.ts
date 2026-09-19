/**
 * Human labels for AI tool rows in chat (#5107).
 *
 * The chat transcript used to print the raw identifier — `MANAGE_ALERTS ·
 * COMPLETED`, `GET_FLEET_FINDINGS · COMPLETED`. A technician reading their
 * own session should see what the assistant did, not the symbol it called.
 *
 * ## Why a verb table and not a 200-entry dictionary
 *
 * There are ~200 registered tools and new ones land most weeks. A hand-written
 * per-tool map would be stale within a release and would silently regress any
 * unmapped tool back to a raw name. Instead:
 *
 *   1. strip the SDK's `mcp__<server>__` prefix,
 *   2. conjugate the leading verb token from a small table (`get_` → Checking
 *      / Checked), and
 *   3. fall back to plain title case for anything that does not start with a
 *      known verb (`disk_cleanup` → "Disk cleanup").
 *
 * Step 3 is the contract that matters: an unmapped tool is still readable, so
 * adding a tool never requires touching this file.
 *
 * `apps/mobile` mirrors this file rather than importing it — the mobile app has
 * no `@breeze/shared` dependency on purpose (Metro/RN bundling), the same
 * constraint documented on `services/ticketPushPrefs.ts` there. The mirror is
 * cosmetic-only, so drift degrades a caption, never behaviour.
 */

/** The two states a tool row can be in. */
export type AiToolLabelState = 'running' | 'completed';

/**
 * Leading verb token → (present participle, past tense). Order is irrelevant;
 * lookup is on the exact first underscore-separated token.
 */
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

/** Strips the `mcp__<server>__` qualification the SDK adds to tool names. */
function bareToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed.includes('__')) return trimmed;
  const tail = trimmed.split('__').filter(Boolean).pop();
  return tail ?? '';
}

/**
 * `get_fleet_findings` → "Get fleet findings". The last-resort label, exported
 * because some surfaces (a tool picker, an audit table) want the neutral name
 * rather than a conjugated caption.
 *
 * Never returns an empty string: a nameless tool row still has to render.
 */
export function titleCaseToolName(toolName: string): string {
  const words = bareToolName(toolName).split('_').filter(Boolean);
  const first = words[0];
  if (first === undefined) return 'Tool';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/**
 * `input.action` values that mean the call only read data despite the tool's
 * leading verb (`manage_automations` with `action: 'list'` mutates nothing).
 * A tech reading "Updated automations" for a call that only looked something
 * up reads it as a change they never asked for (#5170) — force the `get`
 * verb forms whenever the call carries one of these, regardless of the tool
 * name's own verb.
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
 * The label for a tool row, e.g. `aiToolLabel('manage_alerts', 'completed')`
 * → "Updated alerts". Falls back to `titleCaseToolName` for any tool whose
 * name does not begin with a known verb, or which is nothing but a verb.
 *
 * `input` is the tool call's arguments. When `input.action` is a read-only
 * verb (list/get/search/…), the row renders with the `get` conjugation
 * ("Checking"/"Checked") no matter what the tool name's leading verb is.
 */
export function aiToolLabel(
  toolName: string,
  state: AiToolLabelState,
  input?: Record<string, unknown>,
): string {
  const words = bareToolName(toolName).split('_').filter(Boolean);
  const verb = words[0];
  if (verb === undefined) return 'Tool';

  const forms = isReadOnlyAction(input) ? VERB_FORMS.get : VERB_FORMS[verb.toLowerCase()];
  const subject = words.slice(1).join(' ');
  // A bare verb ("get_", "run") has no subject to attach, so "Checked" alone
  // would say nothing — fall through to the neutral name instead.
  if (!forms || !subject) return titleCaseToolName(toolName);

  return `${state === 'running' ? forms[0] : forms[1]} ${subject}`;
}
