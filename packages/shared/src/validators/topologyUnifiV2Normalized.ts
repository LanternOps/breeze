import { z } from 'zod';
import {
  normalizedUnifiClientRowSchema, normalizedUnifiDeviceDetailRowSchema, normalizedUnifiDeviceRowSchema, normalizedUnifiStatisticsRowSchema,
} from './topologyUnifiNormalized';
import {
  refineUnifiDeviceV2Capabilities, UNIFI_DEVICE_V2_CAPABILITY_MESSAGE, unifiDeviceDetailV2Fields, unifiDeviceV2Fields, unifiStatisticsV2Fields,
} from './topologyUnifiV2';

/**
 * Normalized UniFi v2 rows retained by the API ingest seam: the v1 normalized row
 * (wire row + server-derived endpoint identity) plus the v2 fields. Same resource
 * kinds and the same identity material as v1.
 *
 * The retained section schemas accept the UNION `v2 | v1`, v2 FIRST. A v1 row has
 * none of the v2 fields, so it can never parse as v2; and a v2 row is tried against
 * v2 before v1, so zod's default object stripping can never drop a v2 field from a
 * row that is then digested (that would be a silent digest drift).
 */
export const UNIFI_TOPOLOGY_NORMALIZED_V2_CONTRACT = 'unifi_topology_normalized_v2';
export const normalizedUnifiDeviceRowV2Schema = normalizedUnifiDeviceRowSchema.safeExtend(unifiDeviceV2Fields)
  .refine(refineUnifiDeviceV2Capabilities, UNIFI_DEVICE_V2_CAPABILITY_MESSAGE);
export const normalizedUnifiClientRowV2Schema = normalizedUnifiClientRowSchema;
export const normalizedUnifiDeviceDetailRowV2Schema = normalizedUnifiDeviceDetailRowSchema.safeExtend(unifiDeviceDetailV2Fields);
export const normalizedUnifiStatisticsRowV2Schema = normalizedUnifiStatisticsRowSchema.safeExtend(unifiStatisticsV2Fields);

/** Retained-row unions used by physicalSourceSectionSchema (topologyPhysicalNormalized). */
export const retainedUnifiDeviceRowSchema = z.union([normalizedUnifiDeviceRowV2Schema, normalizedUnifiDeviceRowSchema]);
export const retainedUnifiDeviceDetailRowSchema = z.union([normalizedUnifiDeviceDetailRowV2Schema, normalizedUnifiDeviceDetailRowSchema]);
export const retainedUnifiStatisticsRowSchema = z.union([normalizedUnifiStatisticsRowV2Schema, normalizedUnifiStatisticsRowSchema]);

export type NormalizedUnifiDeviceRowV2 = z.infer<typeof normalizedUnifiDeviceRowV2Schema>;
export type NormalizedUnifiDeviceDetailRowV2 = z.infer<typeof normalizedUnifiDeviceDetailRowV2Schema>;
export type NormalizedUnifiStatisticsRowV2 = z.infer<typeof normalizedUnifiStatisticsRowV2Schema>;
