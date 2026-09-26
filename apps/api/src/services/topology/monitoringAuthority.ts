import { createHash } from 'node:crypto';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import type { TopologyPolicyDefinition, TopologyPolicyRoutingContext, TopologyScope } from '@breeze/shared';
import { hasSatisfiedMfa, isInteractiveUserSession, withAuthDbAccessContext } from '../../middleware/auth';
import { TopologyError, requireTopologySiteAccess, type TopologyRequestContext } from './access';
import { loadTopologyFlags } from './flags';
import { TopologyOperationError } from './operationErrors';
import { currentApplicationAuthority, freezeApplicationAuthority } from './templateApplicationAuthority';

/**
 * M3-D3/D4/D13 standing arm authority, shared by policy arms and telemetry
 * arms. An arm stores a TYPED frozen actor — the human session's identity,
 * narrowed org/site ceilings and auth/MFA epochs — plus the permission
 * authority version witnessed at arm time. It is never a bearer grant: every
 * boundary (enqueue, delivery, result publication) re-derives the actor's live
 * authority and fails closed.
 *
 * The ceilings are NARROWED to the armed site's org (and site, for a
 * site-restricted actor) at freeze time, so a stored arm can never be replayed
 * against another tenant even if the actor's reach was wider.
 */
export {
  topologyArmActorSchema,
  topologyArmAuthorityRecordSchema,
  type TopologyArmAuthorityRecord,
} from './monitoringAuthorityRecord';
import { topologyArmAuthorityRecordSchema, type TopologyArmAuthorityRecord } from './monitoringAuthorityRecord';

export type TopologyArmAuthorityDenial =
  | 'authority_unavailable'
  | 'permission_changed'
  | 'site_access_revoked'
  | 'diagnostics_disabled'
  | 'interface_health_disabled'
  | 'scope_changed';

/** Arming is a human act with a satisfied second factor; an AI, API key or MCP principal never arms. */
export function requireHumanArmingSession(ctx: Pick<TopologyRequestContext, 'auth'>): void {
  if (!isInteractiveUserSession(ctx.auth) || ctx.auth.principal?.kind === 'ai_agent') {
    throw new TopologyOperationError('interactive_session_required', 403, 'Arming requires an interactive user session');
  }
  if (!hasSatisfiedMfa(ctx.auth)) throw new TopologyOperationError('mfa_required', 403);
}

export async function freezeTopologyArmAuthority(
  ctx: TopologyRequestContext,
  deps: { permissionVersion?: (userId: string) => Promise<string | null> } = {},
): Promise<TopologyArmAuthorityRecord> {
  requireHumanArmingSession(ctx);
  const frozen = await freezeApplicationAuthority(ctx.auth, deps.permissionVersion);
  return topologyArmAuthorityRecordSchema.parse({
    version: 1,
    actor: {
      user: {
        id: frozen.actor.user.id,
        email: frozen.actor.user.email,
        name: frozen.actor.user.name,
        isPlatformAdmin: frozen.actor.user.isPlatformAdmin,
      },
      principal: { kind: 'user_session' },
      scope: frozen.actor.scope,
      orgId: frozen.actor.orgId,
      partnerId: frozen.actor.partnerId,
      accessibleOrgIds: [ctx.scope.orgId],
      ...(frozen.actor.allowedSiteIds !== undefined ? { allowedSiteIds: [ctx.scope.siteId] } : {}),
      ...(frozen.actor.partnerOrgAccess !== undefined ? { partnerOrgAccess: frozen.actor.partnerOrgAccess } : {}),
      authEpoch: frozen.actor.authEpoch,
      mfaEpoch: frozen.actor.mfaEpoch,
      mfa: frozen.actor.mfa,
    },
    permissionVersion: frozen.permissionVersion,
  });
}

export type TopologyArmAuthorityResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: TopologyArmAuthorityDenial };

export type TopologyArmAuthorityDeps = {
  currentAuthority?: typeof currentApplicationAuthority;
  withContext?: typeof withAuthDbAccessContext;
};

/**
 * Re-derive a stored arm's actor LIVE and run `fn` inside that actor's own RLS
 * context: current user status and auth/MFA epochs, permissions re-read
 * bypassing the cache, the exact site under `configure` and `execute`, and the
 * required feature flags. The permission version is not compared for equality
 * (see `freezeApplicationAuthority`); the live permission set decides.
 */
export async function withTopologyArmAuthority<T>(
  record: unknown,
  scope: TopologyScope,
  requiredFlags: ReadonlyArray<'diagnostics' | 'interfaceHealth'>,
  fn: (ctx: TopologyRequestContext) => Promise<T>,
  deps: TopologyArmAuthorityDeps = {},
): Promise<TopologyArmAuthorityResult<T>> {
  const parsed = topologyArmAuthorityRecordSchema.safeParse(record);
  if (!parsed.success) return { ok: false, reason: 'authority_unavailable' };
  const actor = parsed.data.actor;
  if (actor.accessibleOrgIds[0] !== scope.orgId || (actor.allowedSiteIds && actor.allowedSiteIds[0] !== scope.siteId)) {
    return { ok: false, reason: 'scope_changed' };
  }
  let live: Awaited<ReturnType<typeof currentApplicationAuthority>>;
  try {
    live = await (deps.currentAuthority ?? currentApplicationAuthority)(actor);
  } catch (error) {
    if (error instanceof TopologyOperationError) {
      return { ok: false, reason: error.status === 503 ? 'authority_unavailable' : 'permission_changed' };
    }
    throw error;
  }
  const inContext = deps.withContext ?? withAuthDbAccessContext;
  return inContext(live.auth, async () => {
    let ctx: TopologyRequestContext;
    try {
      ctx = await requireTopologySiteAccess(live.auth, live.permissions, scope.siteId, 'configure');
      await requireTopologySiteAccess(live.auth, live.permissions, scope.siteId, 'execute');
    } catch (error) {
      if (error instanceof TopologyError) return { ok: false as const, reason: 'site_access_revoked' as const };
      throw error;
    }
    if (ctx.scope.orgId !== scope.orgId) return { ok: false as const, reason: 'scope_changed' as const };
    const flags = await loadTopologyFlags(ctx);
    if (!flags.materialization) return { ok: false as const, reason: 'diagnostics_disabled' as const };
    if (requiredFlags.includes('diagnostics') && !flags.diagnostics) return { ok: false as const, reason: 'diagnostics_disabled' as const };
    if (requiredFlags.includes('interfaceHealth') && !flags.interfaceHealth) return { ok: false as const, reason: 'interface_health_disabled' as const };
    return { ok: true as const, value: await fn(ctx) };
  });
}

/**
 * Deterministic digest of a policy's EXECUTABLE effect (M3-D7). Moving scheduler
 * timestamps, template provenance and the alert runtime state are excluded, so
 * a settings write that leaves the effect unchanged keeps the arm; anything
 * that would make a run do something else changes the digest.
 */
export function topologyPolicyEffectDigest(input: {
  scope: TopologyScope;
  policyId: string;
  definition: TopologyPolicyDefinition;
  targets: ReadonlyArray<{ id: string; revision: string; purpose: string; position: number }>;
  contexts: ReadonlyArray<TopologyPolicyRoutingContext>;
  authority: Pick<TopologyArmAuthorityRecord, 'permissionVersion'> & { userId: string; authEpoch: number; mfaEpoch: number } | null;
}): string {
  const d = input.definition;
  const effect = {
    scope: input.scope,
    policyId: input.policyId,
    recipeId: d.recipeId,
    recipeVersion: d.recipeVersion,
    subject: d.subject,
    families: [...d.families].sort(),
    origin: d.origin,
    intervalSeconds: d.intervalSeconds,
    jitterPercent: d.jitterPercent,
    alertSettings: { alertsEnabled: d.alertsEnabled, failureThreshold: d.failureThreshold, recoveryThreshold: d.recoveryThreshold },
    targets: [...input.targets].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    contexts: [...input.contexts].sort((a, b) => a.contextKey.localeCompare(b.contextKey) || a.family.localeCompare(b.family)),
    authority: input.authority,
  };
  return createHash('sha256').update(canonicalizeArguments(effect)).digest('hex');
}

/** The policy's MATERIAL configuration only (no contexts, no authority): used by the diff-aware compiler. */
export function topologyPolicyMaterialDigest(input: {
  definition: TopologyPolicyDefinition;
  targets: ReadonlyArray<{ id: string; revision: string; purpose: string; position: number }>;
}): string {
  const { enabled: _intent, ...definition } = input.definition;
  return createHash('sha256').update(canonicalizeArguments({
    definition,
    targets: [...input.targets].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
  })).digest('hex');
}
