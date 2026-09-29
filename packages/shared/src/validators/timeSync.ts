import { z } from 'zod';
import {
  TIME_SYNC_TYPES,
  TIME_SYNC_SERVICE_STATES,
  TIME_SYNC_SERVICE_START_TYPES,
  TIME_SYNC_STATUS_METHODS,
  TIME_SYNC_SOURCE_KINDS,
  TIME_SYNC_JOIN_TYPES,
  TIME_SYNC_DOMAIN_ROLES,
  TIME_SYNC_AUTO_UPDATE,
  TIME_SYNC_SNAPSHOT_EVENTS_MAX,
} from '../constants/timeSync';

export const timeSyncEnforcementResultSchema = z
  .object({
    resultId: z.string().uuid(),
    fingerprint: z.string().max(80),
    at: z.string().datetime({ offset: true }),
    outcome: z.enum(['ok', 'failed', 'skipped']),
    reason: z.enum([
      'applied',
      'already_compliant',
      'role_unknown',
      'conflict_gpo',
      'readback_mismatch',
      'exec_failed',
      'invalid_settings',
      'auto_timezone_on',
      'no_expected_timezone',
    ]),
    before: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    after: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    error: z.string().max(512).nullable(),
  })
  .strict();
export const timeSyncEnforcementReportSchema = z
  .object({
    ntp: timeSyncEnforcementResultSchema.nullable(),
    timezone: timeSyncEnforcementResultSchema.nullable(),
  })
  .strict();
export type TimeSyncEnforcementState = z.infer<
  typeof timeSyncEnforcementReportSchema
>;

/** Agent → API snapshot (spec §4.6). camelCase keys; `null` for unknown. */
export const timeStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    collectedAt: z.string().datetime({ offset: true }),
    config: z
      .object({
        type: z.enum(TIME_SYNC_TYPES).nullable(),
        ntpServer: z.string().max(1024).nullable(),
        specialPollIntervalSeconds: z.number().int().nonnegative().nullable(),
        policyManaged: z.boolean(),
        policyManagedValues: z.array(z.string().max(64)).max(20),
        serviceState: z.enum(TIME_SYNC_SERVICE_STATES),
        serviceStartType: z.enum(TIME_SYNC_SERVICE_START_TYPES),
        hostTimeProviderEnabled: z.boolean().nullable(),
      })
      .strict(),
    status: z
      .object({
        method: z.enum(TIME_SYNC_STATUS_METHODS),
        source: z.string().max(512).nullable(),
        sourceKind: z.enum(TIME_SYNC_SOURCE_KINDS),
        lastSuccessfulSyncAt: z.string().datetime({ offset: true }).nullable(),
        lastSyncError: z.string().max(512).nullable(),
        stratum: z.number().int().min(0).max(16).nullable(),
        pollIntervalSeconds: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    domain: z
      .object({
        joinType: z.enum(TIME_SYNC_JOIN_TYPES),
        role: z.enum(TIME_SYNC_DOMAIN_ROLES),
        domainDns: z.string().max(255).nullable(),
        forestDns: z.string().max(255).nullable(),
        pdcName: z.string().max(255).nullable(),
      })
      .strict(),
    timezone: z
      .object({
        windowsId: z.string().max(128).nullable(),
        biasMinutes: z.number().int().min(-1440).max(1440).nullable(),
        dynamicDstDisabled: z.boolean().nullable(),
        autoUpdate: z.enum(TIME_SYNC_AUTO_UPDATE),
      })
      .strict(),
    events: z
      .array(
        z
          .object({
            recordId: z.number().int().nonnegative(),
            eventId: z.number().int().nonnegative(),
            level: z.number().int().min(0).max(5),
            occurredAt: z.string().datetime({ offset: true }),
            message: z.string().max(1000),
            properties: z.array(z.string().max(500)).max(10),
          })
          .strict(),
      )
      .max(TIME_SYNC_SNAPSHOT_EVENTS_MAX),
    enforcement: timeSyncEnforcementReportSchema.nullable(), // W01a defines the schema (§F.3) so W01b can send `null` and W03b can send values without a validator change
  })
  .strict();
export type TimeStatusSnapshot = z.infer<typeof timeStatusSnapshotSchema>;

export function isValidNtpServerHost(value: string): boolean {
  if (value.length < 1 || value.length > 253 || /[\s,;\/\\]/.test(value))
    return false;
  // Zod's IP validators avoid accepting a colon-plus-port as an IPv6 address.
  if (z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success)
    return true;
  if (value.includes(':')) return false;
  return value
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}
export const ntpServerHostSchema: z.ZodString = z
  .string()
  .refine(isValidNtpServerHost, {
    message:
      'Use an IPv4 or IPv6 literal or an RFC-1123 hostname without flags or a port',
  });
export function parseNtpServerHosts(raw: string | null): string[] {
  return (raw ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((host) => host.replace(/(?:,0x[0-9a-f]+)+$/i, ''));
}
