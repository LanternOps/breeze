import { z } from 'zod';
import { collectionOutcomeSchema } from './topology';
import { refineTopologySectionRows } from './topologyCollection';
import { unifiClientRowSchema, unifiDeviceDetailRowSchema, unifiDeviceRowSchema, unifiStatisticsRowSchema } from './topologyPhysical';
import { topologyDigestSchema, topologyReasonSchema, topologySequenceSchema, topologyTimestampSchema, topologyUint32Schema, topologyUtf8KeySchema, topologyWireGuard } from './topologyPrimitives';

/**
 * UniFi topology v2 — wire contract (UniFi Wi-Fi monitoring spec, sections 4 and 5).
 *
 * v1 is frozen: its row schemas, canonical strings and digests do not change.
 * v2 keeps the v1 resource kinds and identity rules and extends three row types
 * with typed Wi-Fi evidence. Every new nullable value is an explicit `null` after
 * normalization; a key the controller omitted is never converted to zero.
 *
 * Wire shapes only: nothing here grants tenant, site or collector authority.
 */
export const UNIFI_TOPOLOGY_V2_MAX_BYTES = 8 * 1024 * 1024;
export const UNIFI_RADIO_MAX_ENTRIES = 16;
/** Documented adopted-device capability sets (Network 10.6.106 `features` / `interfaces`). */
export const UNIFI_DEVICE_FEATURES = ['switching', 'accessPoint', 'gateway'] as const;
export const UNIFI_DEVICE_INTERFACE_KINDS = ['ports', 'radios'] as const;

const key = topologyUtf8KeySchema;
const uint = topologyUint32Schema;
const percent = z.number().min(0).max(100);
/** Bits per second. Integer and number-safe so it can never be mistaken for, or stored as, a byte counter. */
const rateBps = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Documented values are 2.4, 5, 6 and 60 GHz. The frequency is the only cross-endpoint radio key, so it is bounded, not enumerated. */
const frequencyGHz = z.number().positive().max(100);
const hasNoDuplicates = (values: readonly string[] | null) => values === null || new Set(values).size === values.length;

/** One radio from `GET .../devices/{id}` `interfaces.radios`. `channel` and the rest are optional on the controller. */
export const unifiRadioOverviewSchema = z.object({
  frequencyGHz, channel: uint.nullable(), channelWidthMHz: uint.nullable(), wlanStandard: key.nullable(),
});
/** One radio from `GET .../statistics/latest` `interfaces.radios`. `txRetriesPct: 0` is a real measurement. */
export const unifiRadioStatisticsSchema = z.object({ frequencyGHz, txRetriesPct: percent.nullable() });

/** Field groups are shared by the wire rows and the normalized retained rows (topologyUnifiV2Normalized). */
export const unifiDeviceV2Fields = {
  features: z.array(z.enum(UNIFI_DEVICE_FEATURES)).max(UNIFI_DEVICE_FEATURES.length).nullable(),
  interfaces: z.array(z.enum(UNIFI_DEVICE_INTERFACE_KINDS)).max(UNIFI_DEVICE_INTERFACE_KINDS.length).nullable(),
};
export const unifiDeviceDetailV2Fields = { radios: z.array(unifiRadioOverviewSchema).max(UNIFI_RADIO_MAX_ENTRIES).nullable() };
export const unifiStatisticsV2Fields = {
  uplinkRxRateBps: rateBps.nullable(), uplinkTxRateBps: rateBps.nullable(),
  lastHeartbeatAt: topologyTimestampSchema.nullable(), nextHeartbeatAt: topologyTimestampSchema.nullable(),
  radios: z.array(unifiRadioStatisticsSchema).max(UNIFI_RADIO_MAX_ENTRIES).nullable(),
};
export const refineUnifiDeviceV2Capabilities = (v: { features: readonly string[] | null; interfaces: readonly string[] | null }) =>
  hasNoDuplicates(v.features) && hasNoDuplicates(v.interfaces);
export const UNIFI_DEVICE_V2_CAPABILITY_MESSAGE = 'Capability sets must not contain duplicates';

export const unifiDeviceRowV2Schema = unifiDeviceRowSchema.safeExtend(unifiDeviceV2Fields)
  .refine(refineUnifiDeviceV2Capabilities, UNIFI_DEVICE_V2_CAPABILITY_MESSAGE);
/** Client rows are unchanged: the wireless count is derived from the existing `WIRELESS` subset. */
export const unifiClientRowV2Schema = unifiClientRowSchema;
export const unifiDeviceDetailRowV2Schema = unifiDeviceDetailRowSchema.safeExtend(unifiDeviceDetailV2Fields);
export const unifiStatisticsRowV2Schema = unifiStatisticsRowSchema.safeExtend(unifiStatisticsV2Fields);

function unifiResourceV2<K extends string, S extends z.ZodType<{ rowKey: string }>>(kind: K, row: S, limit: number) {
  return z.object({ controllerSiteId: key, kind: z.literal(kind), contentDigest: topologyDigestSchema, outcome: collectionOutcomeSchema,
    reasonCode: topologyReasonSchema.optional(), rowCount: uint, omittedRowCount: uint.optional(), rows: z.array(row).max(limit),
  }).superRefine(refineTopologySectionRows);
}
export const unifiResourceV2Schema = z.discriminatedUnion('kind', [
  unifiResourceV2('device_list', unifiDeviceRowV2Schema, 2048), unifiResourceV2('client_list', unifiClientRowV2Schema, 10000),
  unifiResourceV2('device_details', unifiDeviceDetailRowV2Schema, 2048), unifiResourceV2('statistics', unifiStatisticsRowV2Schema, 2048),
]);
export const unifiTopologyV2Schema = z.object({
  version: z.literal(2), producerEpoch: key, snapshotId: z.uuid(), sequence: topologySequenceSchema, capturedAt: topologyTimestampSchema,
  captureAgeAtSendMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(), expectedIntervalSeconds: z.number().int().min(60).max(86400),
  resources: z.array(unifiResourceV2Schema).max(256),
}).superRefine((v, ctx) => {
  const ids = v.resources.map(r => JSON.stringify([r.controllerSiteId, r.kind]));
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate controller-site resource' });
});
// Resource rows carry the controller's own `deviceId` (never a Breeze device id).
export const unifiTopologyV2WireSchema = topologyWireGuard(UNIFI_TOPOLOGY_V2_MAX_BYTES, { rowFieldExemptions: ['deviceId'] }).pipe(unifiTopologyV2Schema);
/** Version rejection is report-local, like v1: a non-2 report is never parsed against the v2 shape. */
export function parseUnifiTopologyV2(value: unknown) {
  if (value && typeof value === 'object' && 'version' in value && value.version !== 2) return { accepted: false as const, reason: 'unsupported_major_version' as const };
  const result = unifiTopologyV2WireSchema.safeParse(value);
  return result.success ? { accepted: true as const, report: result.data } : { accepted: false as const, reason: 'invalid_report' as const, issues: result.error.issues };
}
