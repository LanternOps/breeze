/**
 * Wisp W06 (feature #9906; w00 A28 morning brief, A31 activity timeline) —
 * the DTOs `GET /api/v1/wisp/thread/:id/activity` returns and the brief
 * sections the in-app brief notice carries in `metadata.brief`.
 *
 * The activity timeline is a DERIVED union (no table): assessment runs,
 * concern transitions, approval intents minted by grant-bearing runs, memory
 * blocks authored under the grant, nudges and briefs. Every item passed the
 * grant's live ceiling before it left the API.
 */

export const WISP_ACTIVITY_KINDS = ['assessment', 'concern', 'specialist', 'approval', 'memory', 'nudge', 'brief'] as const;
export type WispActivityKind = (typeof WISP_ACTIVITY_KINDS)[number];

export interface ActivityItem {
  /** Stable per (kind, source row); the keyset cursor's tiebreaker and a list key. */
  id: string;
  /** ISO timestamp the item is ordered by (newest first). */
  at: string;
  kind: WispActivityKind;
  /** null = partner-level (no single org). */
  orgId: string | null;
  title: string;
  detail: string | null;
  /** Relative same-origin path, when the item has a page. */
  href: string | null;
  costCents: number | null;
}

/** The live "Wisp is checking Greenwood…" line: the queued/running assessment, or null. */
export type CurrentActivity = { orgId: string; orgName: string; startedAt: string } | null;

export interface WispThreadActivityResponse {
  data: { items: ActivityItem[]; nextCursor: string | null; current: CurrentActivity };
}

/** One section of the deterministic morning brief (w00 A28); empty sections are omitted. */
export interface BriefSection {
  heading: string;
  lines: string[];
}
