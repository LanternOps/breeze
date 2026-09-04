import { approvalBatchGroupKey, approvalBatchGroupParts } from '@breeze/shared';

/**
 * Pure list-shaping helpers for the AI-agent approvals inbox — issue #4456.
 *
 * `ApprovalsInbox.tsx` renders; this module decides WHAT it renders: which
 * cards may be batched, which of them form a group, and how a flat page of rows
 * is filtered, sorted and clustered before any of that. Everything here is a
 * pure function of its arguments (no hooks, no fetches, no i18n), so each rule
 * can be tested directly instead of through the component.
 *
 * The one rule that is NOT defined here is the batch-grouping key itself: it
 * lives in `@breeze/shared`'s `approvalBatchGroupKey` because the server
 * enforces the same rule, and the two used to be copies kept in step only by
 * matching comments (#4457).
 */

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface PendingApproval {
  id: string;
  requestingClientLabel: string;
  requestingMachineLabel: string | null;
  actionLabel: string;
  actionToolName: string;
  actionArguments: Record<string, unknown>;
  riskTier: RiskTier;
  riskSummary: string;
  customerTenant: string | null;
  status: 'pending';
  expiresAt: string;
  decidedAt: null;
  decisionReason: null;
  executionId: string | null;
  intentId: string | null;
  approvalScope: string | null;
  isRecursive: boolean;
  createdAt: string;
  /** Wave 3b: who proposed this intent. Serialize emits it on every row;
   *  anything but 'ai_agent' renders the classic requester attribution. */
  origin: 'human' | 'ai_agent';
  agentName: string | null;
  /** P2-2: the linked intent's org, the multiplexed tools' `action`
   *  discriminator, and the resolved target device. All three are null for a
   *  row with no intent; `action` is also null for a non-multiplexed tool. */
  orgId: string | null;
  /** The `orgId` organization's display name, resolved server-side. Null for
   *  a row with no intent (no orgId) or when the org row no longer exists —
   *  either way the UI falls back to the "Unknown organization" copy. */
  orgName: string | null;
  action: string | null;
  targetDevice: { id: string; hostname: string } | null;
}

/** One header + its cards: a set the server would accept as ONE decision. */
export interface ApprovalGroup {
  /** Raw `(orgId, tool, action)` triple — the identity all state is keyed by. */
  identity: string;
  /** DOM-safe projection of the same triple, used only for `data-testid`. */
  testKey: string;
  /** What the header names the group after. */
  tool: string;
  members: PendingApproval[];
}

export type Section =
  | { kind: 'row'; approval: PendingApproval }
  | { kind: 'group'; group: ApprovalGroup };

/**
 * Exactly the server's batch eligibility rule (`loadHomogeneousBatch` in
 * `services/approvals/batchDecide.ts`): a SUPERVISED, AGENT-ORIGINATED, still
 * pending card. Four-eyes cards are excluded structurally — they are never
 * `supervised` — so the two-person rule can never be satisfied by a batch tap.
 *
 * The UI must only ever offer a batch the server would accept; a looser
 * predicate here does not weaken the server (it 422s the whole set), but it
 * does hand the approver a button that always fails.
 */
export function isGroupable(approval: PendingApproval): boolean {
  return (
    approval.origin === 'ai_agent' &&
    approval.approvalScope === 'supervised' &&
    approval.orgId !== null &&
    // A CRITICAL card can never be batched. The batch route deliberately does
    // not plumb `reauthVerified` (batchDecide.ts), so the L4 ladder a critical
    // card has to clear is unsatisfiable in a batch and the whole set 401s
    // `reauth_required` — a permanent dead end, since re-auth is collected per
    // decision. The ceremony runs at the HIGHEST tier present, so ONE critical
    // card would sink an otherwise decidable group; excluding it here leaves
    // every critical card on the single-card path, which can collect re-auth.
    approval.riskTier !== 'critical'
  );
}

/**
 * The batch homogeneity key for one card — `(orgId, actionToolName, normalized
 * action)`, NUL-joined.
 *
 * Delegates to `@breeze/shared` (#4457) so this is literally the same function
 * the server's `loadHomogeneousBatch` runs: the inbox can no longer offer an
 * "Approve all (N)" over a set the server would refuse, nor split a set it
 * would have accepted. A `PendingApproval` satisfies the shared input shape
 * structurally — `orgId`, `actionToolName` and `action` are exactly the DTO
 * fields `serialize` projects for that purpose.
 */
export function groupIdentity(approval: PendingApproval): string {
  return approvalBatchGroupKey(approval);
}

/** DOM-safe rendering of the same triple. Lossy (distinct triples could in
 *  principle collapse), which is why it is used ONLY for `data-testid` while
 *  every decision keys off `groupIdentity`. */
export function groupTestKey(approval: PendingApproval): string {
  return approvalBatchGroupParts(approval)
    .map((part) => part.replace(/[^A-Za-z0-9_-]+/g, '-'))
    .join('--');
}

/**
 * Org is the OUTERMOST grouping (critique #1): two cards for different orgs
 * that happen to share a `(tool, action)` must never render adjacent to each
 * other as if they were the same request. This stable-sorts the rows so every
 * org's cards sit together, in the org's own first-appearance order, WITHOUT
 * touching each org's internal relative order — `buildSections` below still
 * decides tool/action grouping exactly as before, it just runs over rows
 * that are already clustered by org.
 *
 * Known, accepted trade-off: the server pages strictly by `createdAt`, but
 * this reclusters by org (first-appearance order). A "Load more" page's rows
 * can therefore land ABOVE some already-visible rows if they belong to an
 * org that appeared earlier in the list — no row is ever lost or hidden,
 * just not always appended at the visual bottom.
 */
export function clusterByOrg(rows: PendingApproval[]): PendingApproval[] {
  const buckets = new Map<string, PendingApproval[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.orgId ?? '';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else {
      buckets.set(key, [row]);
      order.push(key);
    }
  }
  return order.flatMap((key) => buckets.get(key)!);
}

export type SortOrder = 'expiringSoonest' | 'newest';

/** Case-insensitive substring match over the fields Priya (an MSP tech
 *  approving across dozens of orgs) scans an inbox by: the action label, the
 *  target machine's hostname, and the proposing agent's name. An empty or
 *  whitespace-only query matches every row. */
export function matchesSearch(approval: PendingApproval, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (
    approval.actionLabel.toLowerCase().includes(needle) ||
    (approval.targetDevice?.hostname.toLowerCase().includes(needle) ?? false) ||
    (approval.agentName?.toLowerCase().includes(needle) ?? false)
  );
}

/** One selectable option in the organization filter, in first-appearance
 *  order among the currently loaded rows. `key` is what the `<select>`
 *  stores and compares against — `orgId ?? ''` — so a null-`orgId` row
 *  groups under one synthetic "Unknown organization" option instead of
 *  splintering per row. */
export interface OrgFilterOption {
  key: string;
  name: string;
  count: number;
}

export function buildOrgOptions(rows: PendingApproval[], unknownLabel: string): OrgFilterOption[] {
  const byKey = new Map<string, OrgFilterOption>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.orgId ?? '';
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byKey.set(key, { key, name: row.orgName ?? unknownLabel, count: 1 });
    order.push(key);
  }
  return order.map((key) => byKey.get(key)!);
}

/** Explicit-index stable sort: ties (identical `expiresAt`/`createdAt` — the
 *  common case across fixtures, and for cards created in the same request)
 *  keep their original relative order rather than depending on the engine's
 *  sort-stability guarantee. Runs BEFORE `clusterByOrg` below, not after:
 *  clustering only reorders which ORG's bucket comes first and preserves
 *  each bucket's internal order, so sorting the flat list first is what
 *  actually decides the order approvers see within (and, secondarily,
 *  across) organizations — org-first clustering (critique #1) is preserved
 *  either way. */
export function sortRows(rows: PendingApproval[], order: SortOrder): PendingApproval[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const diff =
        order === 'expiringSoonest'
          ? new Date(a.row.expiresAt).getTime() - new Date(b.row.expiresAt).getTime()
          : new Date(b.row.createdAt).getTime() - new Date(a.row.createdAt).getTime();
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map(({ row }) => row);
}

/** Comma-joined hostnames for a group header, so "Approve all (N)" names its
 *  own scope instead of leaving the approver to open every card to find out
 *  which machines it covers. Caps at GROUP_HOSTNAME_MAX_SHOWN names (kept
 *  short enough that the header's `line-clamp-2` rarely has to truncate
 *  mid-name) and folds everything past that — including any member with no
 *  `targetDevice` at all — into one trailing "+K more" count. Returns null
 *  when nothing in the group carries a hostname, so the caller renders no
 *  line at all rather than an empty one. */
export const GROUP_HOSTNAME_MAX_SHOWN = 6;
export function groupHostnameSummary(
  members: PendingApproval[],
): { shown: string[]; more: number } | null {
  const hostnames = members
    .map((member) => member.targetDevice?.hostname)
    .filter((hostname): hostname is string => Boolean(hostname));
  if (hostnames.length === 0) return null;
  const shown = hostnames.slice(0, GROUP_HOSTNAME_MAX_SHOWN);
  return { shown, more: members.length - shown.length };
}

/** Whether a card's expiry has already passed as of `now`. `now` is a ticking
 *  state value (not a fresh `Date.now()` read) so every card in the list
 *  re-evaluates together on the same 10s tick instead of drifting apart. */
export function isExpired(expiresAt: string, now: number): boolean {
  const remainingMs = new Date(expiresAt).getTime() - now;
  return Number.isFinite(remainingMs) && remainingMs <= 0;
}

/**
 * Cards in first-appearance order, with every ≥2-member eligible group pulled
 * together under one header and everything else left as a standalone row.
 * A group of one is deliberately NOT a group: a header offering "Approve all
 * (1)" is noise, and the single-card path already covers it.
 *
 * `driftedIds` (issue #4459): a card the server just reported as `offending`
 * on a `batch_not_homogeneous` 422 is excluded from grouping here — same
 * treatment as `!isGroupable`. This is what "deselects" it: it renders as a
 * standalone row (single-card decide) on the very next render, while its
 * former groupmates re-group (possibly as a smaller batch) and are
 * immediately re-batchable without the approver redoing the selection.
 */
export function buildSections(rows: PendingApproval[], driftedIds: ReadonlySet<string>): Section[] {
  const groupable = (row: PendingApproval) => isGroupable(row) && !driftedIds.has(row.id);
  const membersByIdentity = new Map<string, PendingApproval[]>();
  for (const row of rows) {
    if (!groupable(row)) continue;
    const identity = groupIdentity(row);
    const bucket = membersByIdentity.get(identity);
    if (bucket) bucket.push(row);
    else membersByIdentity.set(identity, [row]);
  }

  const emitted = new Set<string>();
  const sections: Section[] = [];
  for (const row of rows) {
    if (!groupable(row)) {
      sections.push({ kind: 'row', approval: row });
      continue;
    }
    const identity = groupIdentity(row);
    const members = membersByIdentity.get(identity) ?? [row];
    if (members.length < 2) {
      sections.push({ kind: 'row', approval: row });
      continue;
    }
    if (emitted.has(identity)) continue;
    emitted.add(identity);
    sections.push({
      kind: 'group',
      group: {
        identity,
        testKey: groupTestKey(row),
        // Two groups from the same tool differ only by their action, so the
        // header has to carry it or they render identically.
        tool: row.action ? `${row.actionToolName}:${row.action}` : row.actionToolName,
        members,
      },
    });
  }
  return sections;
}
