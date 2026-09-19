/**
 * The ONE definition of the AI-agent approvals batch-grouping ("homogeneity")
 * rule — issue #4457.
 *
 * P2-2 (#4189) lets an approver decide MANY pending approval cards with ONE
 * assertion ceremony. Collapsing N ceremonies into one is only safe because the
 * set is provably a single decision, and *this* key is what "a single decision"
 * means: every member must share the same
 * `(orgId, actionToolName, normalized action)` triple.
 *
 * Two independent call sites derive that key, and they must never disagree:
 *
 *  - the SERVER (`services/approvals/batchDecide.ts`, `loadHomogeneousBatch`),
 *    which 422s `batch_not_homogeneous` and decides NOTHING when a set spans
 *    more than one key, deriving `action` from the row's raw
 *    `action_arguments`; and
 *  - the WEB inbox (`components/approvals/approvalGrouping.ts`), which offers
 *    an "Approve all (N)" header only over rows that share a key, deriving
 *    `action` from the DTO field `serialize` projects out of that same
 *    `action_arguments`.
 *
 * They used to be two copies kept in step by matching comments. A drift in the
 * *loosening* direction on the server is a real authorization hazard: one batch
 * ceremony would then cover a heterogeneous set the approver never read as one
 * decision. A drift in the *tightening* direction on the web is a dead button.
 * Neither is possible while both import from here, so do not re-implement this
 * rule at a call site — extend it here and let both surfaces move together.
 *
 * Pure and dependency-free (no Node builtins) so it is safe in the browser
 * bundle via the root barrel.
 */

/**
 * The minimum an approval must expose to be placed in a batch group. Both a
 * loaded DB row (`intent.orgId` + `approval.actionToolName` +
 * `approval.actionArguments.action`) and a serialized inbox DTO satisfy this
 * shape structurally.
 */
export interface ApprovalBatchGroupSource {
  /** The LINKED INTENT's org — not the approval row's. Null for a row with no
   *  intent, which is never batchable but still needs a stable key. */
  orgId: string | null;
  /** The tool the intent proposes calling. */
  actionToolName: string;
  /**
   * The multiplexed tools' `action` discriminator (`manage_services:restart`,
   * `manage_patches:install`, …), RAW: pass `action_arguments.action` straight
   * through, or the serialized `action` field. Typed `unknown` on purpose —
   * `action_arguments` is jsonb, so a non-string is representable and must be
   * classified here rather than at each call site.
   */
  action: unknown;
}

/**
 * NUL. Chosen because no value that reaches the key can contain it — a tool
 * name is an identifier and Postgres `text` cannot hold a NUL byte — so no
 * field value can forge a boundary and make `(a, "b:c", "")` collide with
 * `(a, "b", "c")`.
 */
export const APPROVAL_BATCH_GROUP_SEPARATOR = '\u0000';

/**
 * The action discriminator, trimmed and lower-cased so a purely cosmetic
 * difference in how two intents spelled the same action does not split an
 * otherwise identical set.
 *
 * Null — meaning "this tool is not action-multiplexed" — for anything that is
 * not a string. That is itself a group of its own, so a set mixing "has an
 * action" with "has none" is heterogeneous and gets refused.
 */
export function normalizeApprovalBatchAction(action: unknown): string | null {
  return typeof action === 'string' ? action.trim().toLowerCase() : null;
}

/**
 * The three parts the key is built from, in order. Exposed separately only so
 * the web inbox can render a DOM-safe `data-testid` from the same triple; every
 * decision — client and server — keys off {@link approvalBatchGroupKey}.
 */
export function approvalBatchGroupParts(
  source: ApprovalBatchGroupSource,
): [string, string, string] {
  return [
    source.orgId ?? '',
    source.actionToolName,
    normalizeApprovalBatchAction(source.action) ?? '',
  ];
}

/** `(orgId, actionToolName, normalized action)` — the whole homogeneity key. */
export function approvalBatchGroupKey(source: ApprovalBatchGroupSource): string {
  return approvalBatchGroupParts(source).join(APPROVAL_BATCH_GROUP_SEPARATOR);
}
