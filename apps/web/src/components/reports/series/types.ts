import type { ReportFormat, ReportSchedule, ReportType } from '../ReportsList';

/**
 * Web mirror of the multi-org report series contract (INDEX
 * "Cross-wave contract"; API: apps/api/src/services/reportSeries/types.ts and
 * apps/api/src/services/reportDelivery.ts). Type-only; nothing here runs.
 */
// W01 owns the web declaration (DeliveryStatusChip.tsx); re-exported, never redeclared.
export type { ReportDeliveryStatus } from '../DeliveryStatusChip';
import type { ReportDeliveryStatus } from '../DeliveryStatusChip';
export type SeriesTargetMode = 'all' | 'selected';
export interface SeriesRecipientRule { primaryContact: boolean; roles: string[] }
export type SeriesOrgState = 'active' | 'excluded' | 'detached' | 'ineligible' | 'blocked_no_authority' | 'blocked_no_recipients';
export interface SeriesOrgStatus {
  orgId: string;
  orgName: string;
  state: SeriesOrgState;
  childReportId: string | null;
  lastRun: {
    status: string;
    deliveryStatus: ReportDeliveryStatus | null;
    recipientCount: number | null;
    completedAt: string | null;
  } | null;
}

/** `report_series` as the API serialises it (Drizzle camelCase). */
export interface SeriesDefinition {
  id: string;
  name: string;
  type: ReportType;
  format: ReportFormat;
  schedule: ReportSchedule;
  config: Record<string, unknown>;
  targetMode: SeriesTargetMode;
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
  revision: number;
  enabled: boolean;
  ownerUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /reports/series/:id` (INDEX) — also each element of `GET /reports/series`'s `data`. */
export interface SeriesDetail {
  series: SeriesDefinition;
  /** Exclusions in 'all' mode, inclusions in 'selected' mode. */
  targets: string[];
  orgs: SeriesOrgStatus[];
}

export interface SeriesRecipientPreview {
  totalCustomerRecipients: number;
  orgCount: number;
  orgsWithoutCustomerRecipient: { orgId: string; orgName: string }[];
}

export interface SeriesTargets { targetMode: SeriesTargetMode; orgIds: string[] }

export interface SeriesCreateBody extends SeriesTargets {
  name: string;
  type: string;
  format: ReportFormat;
  schedule: SeriesSchedule;
  config: Record<string, unknown>;
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
}

/** PATCH /reports/series/:id — shared fields and `enabled` (Pause/Resume); targets go through PUT /targets. */
export type SeriesUpdateBody = Partial<
  Pick<SeriesCreateBody, 'name' | 'format' | 'schedule' | 'config' | 'recipientRule' | 'internalCc'>
> & { enabled?: boolean };

/** A series is recurring-only (INDEX: the series zod schema rejects one_time). */
export type SeriesSchedule = Exclude<ReportSchedule, 'one_time'>;

export type CoversMode = 'org' | 'series' | 'combined';
export interface SeriesCoversFields extends SeriesTargets {
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
}
/**
 * The org itself is not part of the Covers value: W01's `useReportTargetOrg`
 * (in the host) owns which org a single-org report targets, and CoversControl
 * renders the host's picker in its org slot.
 */
export type CoversValue =
  | { mode: 'org' }
  | { mode: 'combined' }
  | ({ mode: 'series' } & SeriesCoversFields);

export type RecipientOverrideMode = 'add' | 'remove';
/** 'default' = no override row: the series rule decides. */
export type RecipientChoice = 'default' | RecipientOverrideMode;
export interface ChildRecipientOverride { contactId: string; mode: RecipientOverrideMode }

/** The fields of `GET /orgs/organizations/:id/contacts` rows this wave reads. */
export interface OrgContact {
  id: string;
  name: string | null;
  email: string | null;
  roles: string[];
  isPrimary: boolean;
  siteId: string | null;
}

export interface PartnerUserOption { id: string; name: string; email: string }

// ── Series W04: Combine (mirrors apps/api/src/services/reportSeries/combinePlan.ts) ──
export type CombineTargetMode = 'selected' | 'all';

export interface CombineCandidateRow {
  reportId: string;
  name: string;
  lastGeneratedAt: string | null;
  action: 'adopt' | 'archive';
  deliverableLinked: boolean;
  /** Latest run was a scope denial: not sending today; combining resumes it. */
  stalled: boolean;
  contactRecipients: { contactId: string; name: string | null; email: string | null }[];
  emailRecipients: string[];
}

export interface CombineCandidateOrg {
  orgId: string;
  orgName: string;
  rows: CombineCandidateRow[];
}

export interface CombineCandidateGroup {
  groupKey: string;
  type: string;
  format: 'csv' | 'pdf' | 'excel';
  schedule: 'daily' | 'weekly' | 'monthly';
  suggestedName: string;
  orgs: CombineCandidateOrg[];
  sharedCc: string[];
  conflictingCc: { email: string; reportIds: string[] }[];
  /** The plan this group shows; the combine POST echoes it. */
  planFingerprint: string;
}

export interface CombineRequest {
  groupKey: string;
  planFingerprint: string;
  reportIds: string[];
  name: string;
  targetMode: CombineTargetMode;
  ccResolution: { include: string[]; drop: string[] };
}

export interface CombineCcConflictBody {
  error: 'combine_cc_conflict';
  shared: string[];
  unresolved: { email: string; reportIds: string[] }[];
  unexpected: string[];
}
