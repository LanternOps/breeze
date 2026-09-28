import { AsyncLocalStorage } from 'node:async_hooks';
import { eq } from 'drizzle-orm';

import { topologyGloballyDisabled } from '../../config/env';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { organizations, partners } from '../../db/schema';
import type { TopologyRequestContext } from './access';

export const TOPOLOGY_FLAG_KEYS = [
  'materialization',
  'ui',
  'physical',
  'interfaceHealth',
  'diagnostics',
  'ai',
] as const;

export type TopologyFlagName = (typeof TOPOLOGY_FLAG_KEYS)[number];

export type TopologyFlags = Record<TopologyFlagName, boolean>;

export type TopologyCapabilityReason =
  | 'materialization_disabled'
  | 'topology_preparing'
  | 'ui_disabled'
  | 'collection_unavailable'
  | 'physical_disabled'
  | 'physical_unavailable'
  | 'interface_health_disabled'
  | 'interface_health_unavailable'
  | 'diagnostics_disabled'
  | 'diagnostics_unavailable'
  | 'ai_disabled'
  | 'ai_unavailable';

export interface TopologyCapabilityState {
  available: boolean;
  reason: TopologyCapabilityReason | null;
}

export interface TopologyAgentCapabilities {
  collection?: boolean;
  physical?: boolean;
  interfaceHealth?: boolean;
  diagnostics?: boolean;
}

export interface TopologyCapabilities {
  materialization: TopologyCapabilityState;
  ui: TopologyCapabilityState;
  collection: TopologyCapabilityState;
  physical: TopologyCapabilityState;
  interfaceHealth: TopologyCapabilityState;
  diagnostics: TopologyCapabilityState;
  ai: TopologyCapabilityState;
}

export type TopologyRequestContextLike = Pick<TopologyRequestContext, 'scope'>;

const DEFAULT_TOPOLOGY_FLAGS: TopologyFlags = {
  materialization: false,
  ui: false,
  physical: false,
  interfaceHealth: false,
  diagnostics: false,
  ai: false,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function flagOverrides(settings: unknown): Partial<TopologyFlags> {
  const values = asRecord(asRecord(settings).topologyFeatureFlags);
  const result: Partial<TopologyFlags> = {};

  for (const key of TOPOLOGY_FLAG_KEYS) {
    if (typeof values[key] === 'boolean') result[key] = values[key];
  }

  return result;
}

export function resolveTopologyFlags({
  partnerSettings,
  orgSettings,
  globallyDisabled = false,
}: {
  partnerSettings?: unknown;
  orgSettings?: unknown;
  globallyDisabled?: boolean;
}): TopologyFlags {
  if (globallyDisabled) return { ...DEFAULT_TOPOLOGY_FLAGS };

  return {
    ...DEFAULT_TOPOLOGY_FLAGS,
    ...flagOverrides(partnerSettings),
    ...flagOverrides(orgSettings),
  };
}

export interface ResolvedTopologyFlags {
  orgId: string;
  flags: TopologyFlags;
}

const resolvedTopologyFlags = new AsyncLocalStorage<ResolvedTopologyFlags>();

/**
 * Serve `loadTopologyFlags` from flags the caller already resolved, for the
 * duration of `fn`. Use it when topology code runs inside a transaction that
 * holds locks other requests queue on: the partner-axis read below escapes to
 * a SECOND pooled connection (`readWithPartnerAxisVisibility`), and postgres-js
 * has no acquire timeout. The agent heartbeat ran this inside its org
 * transaction while holding the per-org partner-export advisory lock; once the
 * pool filled with same-org heartbeats queued on that lock, the holder could
 * never get its second connection and US wedged (2026-09-22). Resolve the flags
 * in a short system context BEFORE opening the transaction, then wrap.
 *
 * A lookup for any other org fails closed (all flags off) rather than falling
 * back to a nested read, so a device moved mid-request never reopens the hole.
 */
export function withResolvedTopologyFlags<T>(
  resolved: ResolvedTopologyFlags,
  fn: () => Promise<T>,
): Promise<T> {
  return resolvedTopologyFlags.run(
    { orgId: resolved.orgId, flags: { ...resolved.flags } },
    fn,
  );
}

/**
 * Load flag inputs without widening the caller's org visibility. The org row
 * is resolved under request RLS first; only its stored partner id is used for
 * the partner-axis read. See `withResolvedTopologyFlags` before calling this
 * from inside a lock-holding transaction.
 */
export async function loadTopologyFlags(
  ctx: TopologyRequestContextLike,
): Promise<TopologyFlags> {
  if (topologyGloballyDisabled()) return resolveTopologyFlags({ globallyDisabled: true });

  const resolved = resolvedTopologyFlags.getStore();
  if (resolved) {
    return resolved.orgId === ctx.scope.orgId
      ? { ...resolved.flags }
      : resolveTopologyFlags({ globallyDisabled: true });
  }

  const [org] = await db
    .select({
      partnerId: organizations.partnerId,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(eq(organizations.id, ctx.scope.orgId))
    .limit(1);

  if (!org) {
    return resolveTopologyFlags({ globallyDisabled: topologyGloballyDisabled() });
  }

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .limit(1)
  );

  // A missing partner row is treated like an unreadable flag source. This
  // preserves the fail-closed behavior of the established ML flag loader.
  if (!partner) {
    return resolveTopologyFlags({ globallyDisabled: topologyGloballyDisabled() });
  }

  return resolveTopologyFlags({
    partnerSettings: partner.settings,
    orgSettings: org.settings,
    globallyDisabled: topologyGloballyDisabled(),
  });
}

/**
 * D9/D15.4: the deployed physical-view capability. It gates EXPOSURE only
 * (graphs, counts, neighborhoods, detail/evidence/health, cursors); canonical
 * publication, support and aging keep running while it is off, so re-enabling
 * needs no reprojection. Independent of whether any collector is present —
 * collectability is reported through graph coverage instead.
 */
export function topologyPhysicalExposed(flags: Pick<TopologyFlags, 'materialization' | 'physical'>): boolean {
  return flags.materialization && flags.physical;
}

/**
 * M3 Task 6: interface measurement (port health and history) is exposed only
 * with the physical capability (interfaces are physical evidence) AND the
 * `interfaceHealth` flag. Like `physical`, it gates EXPOSURE only.
 */
export function topologyInterfaceHealthExposed(flags: Pick<TopologyFlags, 'materialization' | 'physical' | 'interfaceHealth'>): boolean {
  return topologyPhysicalExposed(flags) && flags.interfaceHealth === true;
}
function capability(
  available: boolean,
  reason: TopologyCapabilityReason,
): TopologyCapabilityState {
  return { available, reason: available ? null : reason };
}

function dependentCapability(
  materialization: boolean,
  enabled: boolean,
  supported: boolean,
  disabledReason: TopologyCapabilityReason,
  unavailableReason: TopologyCapabilityReason,
): TopologyCapabilityState {
  if (!materialization) return capability(false, 'materialization_disabled');
  if (!enabled) return capability(false, disabledReason);
  return capability(supported, unavailableReason);
}

/**
 * `aiReady` (M4-D4, #6000) is the server/provider/org AI policy answer
 * (`topologyAiAvailable` minus the flags, see `aiToolGate.ts`) — AI readiness
 * is never an agent capability bit.
 */
export function getTopologyCapabilities(
  flags: TopologyFlags,
  siteGraphReady: boolean,
  agentCapabilities: TopologyAgentCapabilities,
  aiReady = false,
): TopologyCapabilities {
  const effectiveUi = flags.ui && flags.materialization && siteGraphReady;
  const uiReason: TopologyCapabilityReason = !flags.materialization
    ? 'materialization_disabled'
    : !siteGraphReady
      ? 'topology_preparing'
      : 'ui_disabled';

  return {
    materialization: capability(flags.materialization, 'materialization_disabled'),
    ui: { available: effectiveUi, reason: effectiveUi ? null : uiReason },
    collection: flags.materialization
      ? capability(agentCapabilities.collection === true, 'collection_unavailable')
      : capability(false, 'materialization_disabled'),
    physical: dependentCapability(
      flags.materialization,
      flags.physical,
      agentCapabilities.physical === true,
      'physical_disabled',
      'physical_unavailable',
    ),
    interfaceHealth: dependentCapability(
      flags.materialization,
      flags.interfaceHealth,
      agentCapabilities.interfaceHealth === true,
      'interface_health_disabled',
      'interface_health_unavailable',
    ),
    diagnostics: dependentCapability(
      flags.materialization,
      flags.diagnostics,
      agentCapabilities.diagnostics === true,
      'diagnostics_disabled',
      'diagnostics_unavailable',
    ),
    ai: dependentCapability(
      flags.materialization,
      flags.ai,
      aiReady,
      'ai_disabled',
      'ai_unavailable',
    ),
  };
}
