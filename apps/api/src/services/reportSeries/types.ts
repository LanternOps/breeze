/**
 * Multi-org report series — shared types (INDEX "Types"). The web mirrors the
 * exported interfaces in apps/web/src/components/reports/series/types.ts (W03).
 */
import type { db } from '../../db';
import type { reportSeries } from '../../db/schema';
import type { ReportDeliveryStatus } from '../reportDelivery';

export type { ReportDeliveryStatus };

export type ReportSeriesRow = typeof reportSeries.$inferSelect;

/** `db` itself or a transaction handle — every series service accepts either. */
export type SeriesTx = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

export type SeriesTargetMode = 'all' | 'selected';

export interface SeriesRecipientRule {
  primaryContact: boolean;
  roles: string[];
}

export type SeriesOrgState =
  | 'active'
  | 'excluded'
  | 'ineligible'
  | 'blocked_no_authority'
  | 'blocked_no_recipients';

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

export interface ReconcileResult {
  created: number;
  updated: number;
  archived: number;
  unarchived: number;
  /** orgIds whose child could not capture the owner's authority. */
  blocked: string[];
}

export type SeriesGateDecision =
  | 'run'
  | 'skip_disabled'
  | 'skip_untargeted'
  | 'skip_archived'
  | 'blocked_no_authority';

/**
 * The series response shape W03 consumes: `GET /reports/series` answers
 * `{ data: SeriesDetail[] }`; `GET /:id`, `POST /`, `PATCH /:id`,
 * `PUT /:id/targets` and `POST /:id/transfer-owner` answer a bare SeriesDetail.
 */
export interface SeriesDetail {
  series: ReportSeriesRow;
  targets: string[];
  orgs: SeriesOrgStatus[];
}

/** `GET /reports/series/:id/recipients/preview` and the unsaved POST twin. */
export interface SeriesRecipientPreview {
  totalCustomerRecipients: number;
  orgCount: number;
  orgsWithoutCustomerRecipient: Array<{ orgId: string; orgName: string }>;
}

/**
 * Orgs a series may target (spec §3.3). Pinned equal to
 * `isUsableOrgStatus` (services/tenantStatus.ts) by types.test.ts — a status
 * admitted there but not here (or vice versa) would make the worker gate and
 * the report authority resolvers disagree about the same org.
 */
export const SERIES_ELIGIBLE_ORG_STATUSES = ['active', 'trial'] as const;

export const SERIES_MANAGED_ERROR = 'series_managed' as const;

/** The 409 body every child writer answers (spec §3.3 "Child writers"). */
export function seriesManagedRefusal(seriesId: string) {
  return {
    error: SERIES_MANAGED_ERROR,
    seriesId,
    message:
      'This report is managed by a multi-org report. Edit the multi-org report, or detach this organization to edit it on its own.',
  } as const;
}

/**
 * Reads a stored `recipient_rule`. A malformed value fails closed to "nobody"
 * (not to the primary-contact default): a corrupt rule must never widen who
 * receives a customer's report.
 */
export function parseSeriesRecipientRule(value: unknown): SeriesRecipientRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { primaryContact: false, roles: [] };
  }
  const record = value as Record<string, unknown>;
  const roles = Array.isArray(record.roles)
    ? [...new Set(record.roles.filter((role): role is string => typeof role === 'string' && role.trim().length > 0))]
    : [];
  return { primaryContact: record.primaryContact === true, roles };
}

export function recipientRuleIsActive(rule: SeriesRecipientRule): boolean {
  return rule.primaryContact || rule.roles.length > 0;
}

export function emptyReconcileResult(): ReconcileResult {
  return { created: 0, updated: 0, archived: 0, unarchived: 0, blocked: [] };
}
