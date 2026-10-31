/**
 * Wisp W08 (feature #9906; w00 A35) — the Wisp home and entity linking.
 *
 * `BreezeEntityRef` is the contract every surface shares: a thread links to a
 * Breeze object by (kind, id); the org is read FROM THE ENTITY on every read
 * (never trusted from the row or the caller), and the stored label is a cache.
 *
 * `WISP_ENTITY_KINDS` mirrors the `wisp_thread_links_entity_kind_chk` CHECK in
 * apps/api/migrations/*-wisp-thread-links.sql — change both together (a
 * contract test in apps/api compares them).
 */
import type { ActivityItem, BriefSection, CurrentActivity } from './wispActivity';
import type { Concern, ConcernSubjectKind } from './wispConcerns';

export const WISP_ENTITY_KINDS = [
  'ticket',
  'quote',
  'invoice',
  'contract',
  'device',
  'organization',
  'site',
  'alert',
  'run',
  'task',
  'user',
] as const;
export type WispEntityKind = (typeof WISP_ENTITY_KINDS)[number];

/** Concern subjects that can resolve to linked Breeze entities. */
export const CONCERN_KIND_TO_ENTITY_KIND: Readonly<Partial<Record<ConcernSubjectKind, WispEntityKind>>> = {
  org: 'organization',
  ticket: 'ticket',
  device: 'device',
  alert: 'alert',
  run: 'run',
  task: 'task',
  quote: 'quote',
  invoice: 'invoice',
  contract: 'contract',
  site: 'site',
};

export type WispLinkSource = 'user_pin' | 'wisp_pin' | 'auto';

/**
 * Kinds that never carry an org (`org_id IS NULL` links, visible to
 * partner-scoped sessions only). `organization` resolves to its own id.
 */
export const PARTNER_LEVEL_ENTITY_KINDS: ReadonlySet<WispEntityKind> = new Set<WispEntityKind>(['user']);

/** Links per thread (409 `link_limit` beyond it). */
export const WISP_THREAD_LINK_LIMIT = 50;
/** Maximum automatic links retained per thread. */
export const WISP_THREAD_AUTO_LINK_LIMIT = 20;
/** Maximum open or snoozed concerns considered for the working set. */
export const WISP_WORKING_SET_CONCERN_LIMIT = 50;
/** Maximum automatic links added per turn. */
export const WISP_AUTO_LINKS_PER_TURN = 5;
/** Maximum automatic-link lines included in the session seed. */
export const WISP_SEED_AUTO_LINK_MAX_LINES = 15;
/** `wisp_thread_links.label` CHECK. */
export const WISP_LINK_LABEL_MAX = 200;

export type BreezeEntityRef = { kind: WispEntityKind; id: string; orgId: string | null };

/** Why a link could not be resolved for this caller. `link_limit` is add-only. */
export type WispLinkRefusal = 'not_found' | 'forbidden' | 'outside_ceiling' | 'outside_token_scope' | 'link_limit';

export type WispThreadLink = {
  /** Null only for a derived concern link (`source === 'concern'`). */
  id: string | null;
  ref: BreezeEntityRef;
  /** Freshly resolved from the entity on this read (≤ 200 chars). */
  label: string;
  /** The entity's own status string, or null when the kind has none. */
  status: string | null;
  /** Same-origin path to the object's page (`wispEntityHref`). */
  href: string;
  source: WispLinkSource | 'concern';
  lastTouchedAt: string;
  createdAt: string;
};

/**
 * Same-origin page for an entity. Ids are path-encoded so a malformed id can
 * never leave its segment. `orgId` is accepted for kinds whose page needs it.
 */
export function wispEntityHref(kind: WispEntityKind, id: string, _orgId: string | null): string {
  const e = encodeURIComponent(id);
  switch (kind) {
    case 'ticket': return `/tickets/${e}`;
    case 'quote': return `/billing/quotes/${e}`;
    case 'invoice': return `/billing/invoices/${e}`;
    case 'contract': return `/contracts/${e}`;
    case 'device': return `/devices/${e}`;
    case 'organization': return `/organizations/${e}`;
    case 'site': return `/settings/sites/${e}`;
    case 'alert': return `/alerts/${e}`;
    case 'run': return `/ai-agents/runs/${e}`;
    case 'task': return `/operator/tasks/${e}`;
    case 'user': return `/settings/users#${e}`;
  }
}

/** `GET /wisp/thread*` thread block (W04 `threadDto`). */
export interface WispThreadDto {
  id: string;
  grantId: string;
  summary: string;
  summaryUpdatedAt: string | null;
  lastSessionId: string | null;
  focusOrgId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /wisp/thread*` grant block (W04 + A32 spend meter + A29 pausedReason). */
export interface WispThreadGrantSummary {
  id: string;
  status: string;
  orgId: string | null;
  expiresAt: string;
  currentRevisionId: string | null;
  budgetCentsPerDay: number;
  floorTickMinutes: number;
  spentTodayCents: number;
  budgetResetsAt: string;
  pausedReason: string | null;
}

/**
 * `GET /api/v1/wisp/home` — one read for first paint. Composed from tables
 * only (no model call). `thread`, `focusOrgName`, `grant` and
 * `wideningAvailable` are the same members `GET /wisp/thread/:id` returns.
 */
export interface WispHomePayload {
  thread: WispThreadDto;
  focusOrgName: string | null;
  grant: WispThreadGrantSummary;
  wideningAvailable: boolean;
  /** Newest morning brief for this grant from the last 36 h, or null. */
  brief: { sentAt: string; sections: BriefSection[] } | null;
  /** Open + snoozed concerns, approvals first then severity, capped at 50. */
  needsYou: Concern[];
  activity: { items: ActivityItem[]; nextCursor: string | null };
  current: CurrentActivity;
  links: WispThreadLink[];
  partner: { enabled: boolean };
}

export interface WispHomeResponse {
  data: WispHomePayload;
}

/** `GET/PUT /api/v1/wisp/partner-settings`. */
export interface WispPartnerSettings {
  enabled: boolean;
}
