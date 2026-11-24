import { z } from 'zod';

/**
 * Learned networks B2 (#12369): the discovery network gate's shared contract.
 * Spec docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md §8.2-8.4;
 * index contract B2, C2 and C3.
 */

/** Every code a gated discovery job or AI scan can fail with, in the gate's evaluation order. */
export const DISCOVERY_GATE_FAILURE_CODES = [
  'profile_moved', 'network_not_assigned', 'credentials_need_reentry', 'no_network_assigned',
  'no_agent_on_network', 'agent_not_eligible', 'network_mismatch', 'network_changed', 'network_unverified',
] as const;
export type DiscoveryGateFailureCode = (typeof DISCOVERY_GATE_FAILURE_CODES)[number];

/** Why no agent at a gated site could take a guarded scan. */
export type NoAgentReason = 'none_online' | 'none_on_network' | 'agents_need_update';
/** Why one named agent (requested, pinned or the AI tool's target) cannot take a guarded scan. */
export type IneligibleReason =
  | 'not_found' | 'other_site' | 'offline' | 'ephemeral' | 'parked' | 'not_on_network' | 'needs_update';

/** The shape stored on `discovery_jobs.errors`. */
export interface DiscoveryJobError {
  message: string;
  code?: DiscoveryGateFailureCode;
  reason?: NoAgentReason | IneligibleReason;
}

/** One allowed fingerprint, as sent to the agent in `expectedNetwork`. */
export interface ExpectedGateway { networkId: string; gatewayId: string; address: string; mac: string }
/** The guarded command's `expectedNetwork`: 1..EXPECTED_GATEWAYS_MAX gateways. */
export interface ExpectedNetwork { gateways: ExpectedGateway[] }
/** The fingerprint a guarded result proves it ran behind (C3). */
export interface VerifiedNetwork {
  networkId: string; gatewayId: string; gatewayAddress: string; gatewayMac: string; interfaceName: string;
}

export const EXPECTED_GATEWAYS_MAX = 64;

/** Base command type -> its guarded counterpart. W06b adds the probe types. */
export const GUARDED_COMMAND_TYPES = { network_discovery: 'network_discovery_guarded' } as const;

const CANONICAL_MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;
const SHARED_VIRTUAL_ROUTER_PREFIXES = ['00:00:5e:00:01:', '00:00:0c:07:ac:'] as const;

/**
 * True for a VRRP (00:00:5e:00:01:xx) or HSRP (00:00:0c:07:ac:xx) virtual-router MAC: one that many
 * unrelated networks may share, so it identifies a router pair rather than one network (spec §8.5).
 */
export function isSharedVirtualRouterMac(mac: string): boolean {
  const normalized = mac.toLowerCase().replace(/-/g, ':');
  if (!CANONICAL_MAC.test(normalized)) return false;
  return SHARED_VIRTUAL_ROUTER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export const verifiedNetworkSchema: z.ZodType<VerifiedNetwork> = z.object({
  networkId: z.uuid(),
  gatewayId: z.uuid(),
  gatewayAddress: z.ipv4(),
  gatewayMac: z.string().regex(CANONICAL_MAC),
  interfaceName: z.string().min(1).max(128),
});
