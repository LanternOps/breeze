/**
 * Shared device-credential lifecycle checks.
 *
 * Every ingress that authenticates a DEVICE credential (agent REST middleware,
 * the agent WebSocket upgrade, the Breeze Helper tray token) has to answer the
 * same four questions after the token hash matches:
 *
 *   1. was this device's agent token suspended?   (`devices.agent_token_suspended_at`)
 *   2. is the device decommissioned?
 *   3. is the device quarantined?
 *   4. is the owning tenant still allowed to authenticate its fleet?
 *      (`getAgentTenantState` — org AND partner lifecycle)
 *
 * They were previously restated at each ingress, and helperAuth only had (2)
 * and (3): a suspended token, or a suspended/churned/severed tenant, still got
 * a working Helper session (AI chat, LLM, tool results, screenshots).
 *
 * This module owns the PREDICATES; each caller keeps its own error SHAPE
 * (HTTPException / `c.json` / `{ ok: false, reason }`), because those shapes
 * are part of each ingress's contract with its client. The functions are
 * deliberately granular rather than one composite gate: agentAuth interleaves
 * these checks with the re-enrollment probe, the uninstall-drain predicate and
 * its rate limiters, and collapsing them into a single call site would change
 * which denial an agent sees when two conditions apply at once.
 */

import { getAgentTenantState, type AgentTenantState } from '../services/tenantStatus';

export type DeviceLifecycleDenialReason =
  | 'token_suspended'
  | 'decommissioned'
  | 'quarantined'
  | 'tenant_inactive';

export interface DeviceLifecycleDenial {
  denied: true;
  reason: DeviceLifecycleDenialReason;
}

/**
 * Task 18 — an auto-suspended agent token fails closed at EVERY device-credential
 * ingress. Callers must not leak the suspension reason: a compromised agent sees
 * the same opaque denial as a stale token.
 */
export function checkDeviceTokenSuspension(device: {
  agentTokenSuspendedAt: Date | null;
}): DeviceLifecycleDenial | null {
  return device.agentTokenSuspendedAt ? { denied: true, reason: 'token_suspended' } : null;
}

/**
 * Terminal device statuses. `allowDecommissioned` exists for the ONE sanctioned
 * exception (#3986): the device-remove uninstall drain, where a decommissioned
 * device must still reach us to collect its queued `self_uninstall`. The caller
 * computes that predicate (`isDeviceUninstallDraining`) — this function never
 * re-derives or relaxes it.
 */
export function checkDeviceStatus(
  device: { status: string | null },
  options: { allowDecommissioned?: boolean } = {},
): DeviceLifecycleDenial | null {
  if (device.status === 'decommissioned' && !options.allowDecommissioned) {
    return { denied: true, reason: 'decommissioned' };
  }
  if (device.status === 'quarantined') {
    return { denied: true, reason: 'quarantined' };
  }
  return null;
}

export type DeviceTenantVerdict =
  | DeviceLifecycleDenial
  | { denied: false; tenantState: AgentTenantState };

/**
 * Tenant-status gate: a suspended/churned/pending/soft-deleted org or partner
 * must not keep authenticating its device fleet. The device-level checks above
 * don't cover the org/partner lifecycle.
 *
 * `allowDraining` selects the two established behaviours:
 *  - `true`  (agent REST): an `offboarding` tenant resolves to 'draining' and
 *    stays authenticated on the narrowed drain surface, so a queued
 *    `self_uninstall` remains deliverable. The caller then narrows its routes.
 *  - `false` (WS upgrade, Helper): only 'active' authenticates. A WS socket is a
 *    fully-capable control channel the drain filtering cannot see, and a Helper
 *    session is interactive AI/remote surface, not an uninstall delivery path.
 */
export async function checkDeviceTenantState(
  orgId: string,
  options: { allowDraining: boolean },
): Promise<DeviceTenantVerdict> {
  const tenantState = await getAgentTenantState(orgId);
  if (!tenantState) return { denied: true, reason: 'tenant_inactive' };
  if (!options.allowDraining && tenantState !== 'active') {
    return { denied: true, reason: 'tenant_inactive' };
  }
  return { denied: false, tenantState };
}

/**
 * All four checks in one call, for ingresses with no interleaved concerns
 * (helperAuth). Order matches the agent REST path: token suspension first
 * (cheapest, and the compromise signal), then terminal device status, then the
 * tenant lookup — which is the only one that can touch Redis/Postgres.
 */
export async function evaluateDeviceCredentialLifecycle(
  device: { status: string | null; agentTokenSuspendedAt: Date | null; orgId: string },
  options: { allowDraining: boolean; allowDecommissioned?: boolean },
): Promise<DeviceTenantVerdict> {
  const suspension = checkDeviceTokenSuspension(device);
  if (suspension) return suspension;

  const status = checkDeviceStatus(device, { allowDecommissioned: options.allowDecommissioned });
  if (status) return status;

  return checkDeviceTenantState(device.orgId, { allowDraining: options.allowDraining });
}
