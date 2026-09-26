import { z } from 'zod';
import { unifiClientRowSchema, unifiDeviceDetailRowSchema, unifiDeviceRowSchema, unifiStatisticsRowSchema } from './topologyPhysical';

/**
 * Normalized UniFi rows retained by the API ingest seam (M2 Task 5, amendment D16).
 *
 * The API UniFi adapter (apps/api/src/services/topology/unifiAdapter.ts) turns each
 * wire resource row into its normalized form by adding server-derived identity
 * material; the physical projector (Task 6) turns that material into nodes and
 * bindings. Nothing here is taken from the upload:
 *
 * - `endpointKey`: the controller endpoint's own scoped identity,
 *   `unifi:<hostKey>:<controllerSiteId>:<kind>:<value>` (components
 *   URI-encoded, so a cloud host id containing `:` stays unambiguous). `hostKey`
 *   is the collector's UniFi host id (self-hosted controllers: the collector id).
 *   Devices use `device:<controllerDeviceId>`; clients use `mac:<mac>` when the
 *   controller reported one (roaming keeps identity), else `client:<clientId>`.
 * - `uplinkEndpointKey`: the uplink device resolved ONLY inside the same
 *   host/controller-site namespace (`device:<uplinkDeviceId>`), or null.
 * - `inventoryDeviceId`: a Breeze device bound through a unique, same-site
 *   agent-reported NIC MAC, or null. Every other endpoint stays unbound in M2.
 */
export const UNIFI_ENDPOINT_KINDS = ['device', 'mac', 'client'] as const;
export type UnifiEndpointKind = (typeof UNIFI_ENDPOINT_KINDS)[number];
export function unifiEndpointKey(input: { hostKey: string; controllerSiteId: string; kind: UnifiEndpointKind; value: string }): string {
  const enc = encodeURIComponent;
  return `unifi:${enc(input.hostKey)}:${enc(input.controllerSiteId)}:${input.kind}:${enc(input.value)}`;
}

const endpointKeySchema = z.string().min(1).max(1024).regex(/^unifi:[^:]+:[^:]+:(device|mac|client):[^:]+$/, 'Invalid UniFi endpoint key');
const inventoryDeviceIdSchema = z.uuid().nullable();

export const normalizedUnifiDeviceRowSchema = unifiDeviceRowSchema.safeExtend({ endpointKey: endpointKeySchema, inventoryDeviceId: inventoryDeviceIdSchema });
export const normalizedUnifiClientRowSchema = unifiClientRowSchema.safeExtend({
  endpointKey: endpointKeySchema, uplinkEndpointKey: endpointKeySchema.nullable(), inventoryDeviceId: inventoryDeviceIdSchema,
});
export const normalizedUnifiDeviceDetailRowSchema = unifiDeviceDetailRowSchema.safeExtend({ endpointKey: endpointKeySchema, uplinkEndpointKey: endpointKeySchema.nullable() });
export const normalizedUnifiStatisticsRowSchema = unifiStatisticsRowSchema.safeExtend({ endpointKey: endpointKeySchema });

export type NormalizedUnifiDeviceRow = z.infer<typeof normalizedUnifiDeviceRowSchema>;
export type NormalizedUnifiClientRow = z.infer<typeof normalizedUnifiClientRowSchema>;
export type NormalizedUnifiDeviceDetailRow = z.infer<typeof normalizedUnifiDeviceDetailRowSchema>;
export type NormalizedUnifiStatisticsRow = z.infer<typeof normalizedUnifiStatisticsRowSchema>;
