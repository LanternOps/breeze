/**
 * Alert → PSA ticket configuration (#10499, W2-A).
 *
 * Stored in `psa_connections.alert_ticketing` (jsonb, NULL = never configured),
 * one schema per provider because board/status/priority ids are provider
 * specific. Only ConnectWise Manage has a schema in W2.
 *
 * The column is readable by org sessions through the partner-wide SELECT
 * branch on `psa_connections`, so these schemas are STRICT: nothing that looks
 * like a credential (or any key not listed here) can be stored.
 *
 * Runtime state (rev, enabled-at, pause) lives in columns, never here — see
 * the W2-A migration `2027-01-17-210000-psa-alert-ticketing.sql`.
 */

import { z } from 'zod';
import type { PsaProviderId } from './psa';

/** Breeze alert severities, least severe first (`alert_severity` enum). */
export const ALERT_TICKETING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type AlertTicketingSeverity = (typeof ALERT_TICKETING_SEVERITIES)[number];

/**
 * Default minimum severity. Breeze has no `warning` severity: a monitor that
 * watches a warning-level condition (the requesting MSP's UPS monitors) raises
 * a medium or low alert. `low` keeps both, so warnings are never silently
 * dropped by the default (#10528 post-approval requirement).
 */
export const DEFAULT_ALERT_TICKETING_MIN_SEVERITY: AlertTicketingSeverity = 'low';

export function alertTicketingSeverityMeetsMinimum(severity: string, minimum: AlertTicketingSeverity): boolean {
  const rank = (ALERT_TICKETING_SEVERITIES as readonly string[]).indexOf(severity);
  return rank >= 0 && rank >= ALERT_TICKETING_SEVERITIES.indexOf(minimum);
}

/** ConnectWise record ids are positive 32-bit integers. */
export const connectwiseRecordIdSchema = z.number().int().positive().max(2_147_483_647);

const MAX_FILTER_IDS = 200;

const priorityBySeveritySchema = z.object({
  critical: connectwiseRecordIdSchema.optional(),
  high: connectwiseRecordIdSchema.optional(),
  medium: connectwiseRecordIdSchema.optional(),
  low: connectwiseRecordIdSchema.optional(),
  info: connectwiseRecordIdSchema.optional(),
}).strict();

const connectwiseAlertTicketingFields = {
  enabled: z.boolean(),
  boardId: connectwiseRecordIdSchema.optional(),
  openStatusId: connectwiseRecordIdSchema.optional(),
  closedStatusId: connectwiseRecordIdSchema.optional(),
  typeId: connectwiseRecordIdSchema.optional(),
  priorityBySeverity: priorityBySeveritySchema.default({}),
  minSeverity: z.enum(ALERT_TICKETING_SEVERITIES).default(DEFAULT_ALERT_TICKETING_MIN_SEVERITY),
  ruleIds: z.array(z.string().uuid()).max(MAX_FILTER_IDS).optional(),
  monitorIds: z.array(z.string().uuid()).max(MAX_FILTER_IDS).optional(),
  closeOnResolve: z.boolean().default(false),
  noteOnAcknowledge: z.boolean().default(false),
  hourlyCreateCap: z.number().int().min(1).max(1000).default(100),
  lookbackHours: z.number().int().min(1).max(168).default(24),
};

type EnabledFields = { enabled: boolean; boardId?: number; openStatusId?: number; closedStatusId?: number };

function requireIdsWhenEnabled(value: EnabledFields, ctx: z.RefinementCtx): void {
  if (!value.enabled) return;
  for (const field of ['boardId', 'openStatusId', 'closedStatusId'] as const) {
    if (value[field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} is required when alert tickets are enabled` });
    }
  }
}

/** What a partner admin submits (PUT body `config`). */
export const connectwiseAlertTicketingSchema = z
  .object(connectwiseAlertTicketingFields)
  .strict()
  .superRefine(requireIdsWhenEnabled);

/**
 * What the server stores. Adds the server-written instance fingerprint the
 * admin confirmed company links against (a keyed HMAC fingerprint, never the
 * base URL or company id themselves — org sessions can read this column).
 */
export const connectwiseAlertTicketingStoredSchema = z
  .object({
    ...connectwiseAlertTicketingFields,
    companyLinksConfirmedFor: z.string().min(1).max(200).optional(),
  })
  .strict()
  .superRefine(requireIdsWhenEnabled);

export type ConnectwiseAlertTicketing = z.infer<typeof connectwiseAlertTicketingSchema>;
export type ConnectwiseAlertTicketingStored = z.infer<typeof connectwiseAlertTicketingStoredSchema>;

/** The submit schema for a provider, or null when it cannot auto-ticket. */
export function alertTicketingSchemaFor(provider: PsaProviderId): typeof connectwiseAlertTicketingSchema | null {
  return provider === 'connectwise' ? connectwiseAlertTicketingSchema : null;
}

/** The stored schema for a provider, or null when it cannot auto-ticket. */
export function alertTicketingStoredSchemaFor(
  provider: PsaProviderId,
): typeof connectwiseAlertTicketingStoredSchema | null {
  return provider === 'connectwise' ? connectwiseAlertTicketingStoredSchema : null;
}

/**
 * PUT /psa/connections/:id/alert-ticketing body. `config` is validated against
 * the connection's provider schema in the route, after the connection loads.
 */
export const psaAlertTicketingPutSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  expectedRev: z.number().int().min(0),
  confirmCompanyLinks: z.boolean().optional(),
}).strict();

export type PsaAlertTicketingPut = z.infer<typeof psaAlertTicketingPutSchema>;

/** Why a connection's alert ticketing is not active (`resolveAlertTicketingConfig`). */
export const ALERT_TICKETING_INACTIVE_REASONS = [
  'unsupported_provider',
  'not_external',
  'not_bound',
  'disabled',
  'invalid_config',
  'paused',
  'company_links_unverified',
] as const;
export type AlertTicketingInactiveReason = (typeof ALERT_TICKETING_INACTIVE_REASONS)[number];
