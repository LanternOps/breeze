import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  topologyConfigurationSchema,
  type TopologyConfigurationPayload,
  type ResolvedTopologySettings,
  type TopologyTemplateSiteOutcome,
} from '@breeze/shared';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import { db, withDbTransaction } from '../../db';
import {
  organizations,
  topologySiteState,
  topologySiteTemplateBindings,
  topologyConfigTemplateVersions,
  topologyConfigTemplates,
  topologyProbeTargets,
  topologyMonitoringPolicies,
  topologyPolicyTargets,
  topologyChangeOutbox,
  auditLogs,
} from '../../db/schema';
import { hasSatisfiedMfa } from '../../middleware/auth';
import {
  requireTopologySiteAccess,
  type TopologyRequestContext,
} from './access';
import { scopedWrite, expectedRevisionSchema } from './writes';
import {
  resolveTopologySettings,
  TOPOLOGY_DEFAULT_CONFIGURATION,
} from './settingsResolver';
import type { TopologySettingsLayers } from './configurationTypes';
import { TopologyOperationError } from './operationErrors';
import { topologyPolicyMaterialDigest } from './monitoringDigests';
import { disarmPolicyRow } from './monitoringPolicyState';

type Binding = typeof topologySiteTemplateBindings.$inferSelect;
export type TopologyConfigurationSnapshot = {
  binding: Binding | null;
  layers: TopologySettingsLayers;
  resolved: ResolvedTopologySettings;
  settingsRevision: string;
  templateRevisions: Record<string, string>;
};
/** RLS plus explicit owner checks protect both request and background callers. */
export async function loadTopologyConfiguration(
  ctx: TopologyRequestContext,
  selection?: {
    partnerVersionId: string | null;
    orgVersionId: string | null;
    overrides?: TopologyConfigurationPayload;
  },
): Promise<TopologyConfigurationSnapshot> {
  const current = await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'read',
  );
  if (current.scope.orgId !== ctx.scope.orgId)
    throw new TopologyOperationError('topology_site_not_found', 404);
  const [binding] = await db
    .select()
    .from(topologySiteTemplateBindings)
    .where(scopedWrite(ctx.scope, topologySiteTemplateBindings))
    .limit(1);
  const [state] = await db
    .select({ revision: topologySiteState.settingsRevision })
    .from(topologySiteState)
    .where(scopedWrite(ctx.scope, topologySiteState))
    .limit(1);
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, ctx.scope.orgId))
    .limit(1);
  if (!org) throw new TopologyOperationError('topology_site_not_found', 404);
  const layers: TopologySettingsLayers = {
    defaultsVersion: binding?.defaultsVersion ?? 1,
    schemaVersion: 1,
    resolverVersion: binding?.resolverVersion ?? 1,
    defaults: TOPOLOGY_DEFAULT_CONFIGURATION,
    site: selection?.overrides ??
      binding?.overrides ?? { targets: {}, policies: {} },
  };
  const selected = selection ?? {
    partnerVersionId: binding?.partnerVersionId ?? null,
    orgVersionId: binding?.orgVersionId ?? null,
  };
  const templateRevisions: Record<string, string> = {};
  for (const layer of ['partner', 'organization'] as const) {
    const versionId =
      layer === 'partner' ? selected.partnerVersionId : selected.orgVersionId;
    if (!versionId) continue;
    const versionQuery = db
      .select({
        version: topologyConfigTemplateVersions,
        template: topologyConfigTemplates,
      })
      .from(topologyConfigTemplateVersions)
      .innerJoin(
        topologyConfigTemplates,
        eq(
          topologyConfigTemplateVersions.templateId,
          topologyConfigTemplates.id,
        ),
      )
      .where(eq(topologyConfigTemplateVersions.id, z.uuid().parse(versionId)))
      .limit(1);
    const [row] = await (selection ? versionQuery.for('share') : versionQuery);
    if (
      !row ||
      row.version.state !== 'published' ||
      (layer === 'partner'
        ? row.version.partnerId !== org.partnerId || row.version.orgId !== null
        : row.version.orgId !== ctx.scope.orgId ||
          row.version.partnerId !== null)
    )
      throw new TopologyOperationError('template_version_unavailable', 404);
    // Archived versions remain pinned; only new adoption is forbidden. Revoked
    // content remains visible for provenance but can never authorize execution.
    if (selection && row.template.lifecycle !== 'active')
      throw new TopologyOperationError('template_unavailable', 409);
    if (
      row.version.schemaVersion !== layers.schemaVersion ||
      row.version.defaultsVersion !== layers.defaultsVersion ||
      row.version.resolverVersion !== layers.resolverVersion
    )
      throw new TopologyOperationError('configuration_version_mismatch', 409);
    layers[layer] = { versionId, payload: row.version.payload };
    templateRevisions[versionId] =
      `${row.template.revision}:${row.version.revision}:${row.template.lifecycle}`;
  }
  return {
    binding: binding ?? null,
    layers,
    resolved: resolveTopologySettings(layers),
    settingsRevision: (state?.revision ?? 0n).toString(),
    templateRevisions,
  };
}

export async function assertConfigurationEffects(
  ctx: TopologyRequestContext,
  before: TopologyConfigurationPayload,
  after: TopologyConfigurationPayload,
): Promise<void> {
  await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'write',
  );
  const stronger =
    canonicalizeArguments(before.targets) !==
      canonicalizeArguments(after.targets) ||
    canonicalizeArguments(before.policies) !==
      canonicalizeArguments(after.policies) ||
    before.outboundEnabled !== after.outboundEnabled;
  if (stronger) {
    await requireTopologySiteAccess(
      ctx.auth,
      ctx.permissions,
      ctx.scope.siteId,
      'configure',
    );
    await requireTopologySiteAccess(
      ctx.auth,
      ctx.permissions,
      ctx.scope.siteId,
      'execute',
    );
    if (ctx.auth.principal?.kind === 'ai_agent' || !hasSatisfiedMfa(ctx.auth))
      throw new TopologyOperationError('mfa_required', 403);
  }
  // M3: a policy's `enabled` is activation INTENT only (the stronger branch
  // above already demanded configure + execute + MFA for any policy edit).
  // Nothing here arms execution; arming is the separate human-only route.
}

/** Caller supplies configuration, never revisions/authority for compiled rows. */
export async function updateTopologySiteConfiguration(
  ctx: TopologyRequestContext,
  change: TopologyConfigurationPayload,
  expectedRevision: string,
): Promise<ResolvedTopologySettings> {
  const overrides = topologyConfigurationSchema.parse(change);
  expectedRevisionSchema.parse(expectedRevision);
  return withDbTransaction(async () => {
    await requireTopologySiteAccess(
      ctx.auth,
      ctx.permissions,
      ctx.scope.siteId,
      'write',
    );
    await db.insert(topologySiteState).values(ctx.scope).onConflictDoNothing();
    const [state] = await db
      .select()
      .from(topologySiteState)
      .where(scopedWrite(ctx.scope, topologySiteState))
      .for('update');
    if (!state || state.settingsRevision !== BigInt(expectedRevision))
      throw new TopologyOperationError('revision_conflict', 409);
    const snapshot = await loadTopologyConfiguration(ctx);
    const resolved = resolveTopologySettings({
      ...snapshot.layers,
      site: overrides,
    });
    await assertConfigurationEffects(
      ctx,
      snapshot.resolved.settings,
      resolved.settings,
    );
    await persistCompiledConfiguration(ctx, snapshot, resolved, overrides);
    return resolved;
  });
}

/** One compiler is shared by direct overrides and approved template adoption. */
async function persistCompiledConfiguration(
  ctx: TopologyRequestContext,
  snapshot: TopologyConfigurationSnapshot,
  resolved: ResolvedTopologySettings,
  overrides: TopologyConfigurationPayload,
  operationId?: string,
): Promise<void> {
  const now = new Date();
  const [prior] = await db
    .select({ effectiveSettings: topologySiteState.effectiveSettings })
    .from(topologySiteState)
    .where(scopedWrite(ctx.scope, topologySiteState))
    .limit(1);
  const priorConfiguration = (prior?.effectiveSettings as { configuration?: { outboundEnabled?: unknown } } | null)?.configuration;
  const outboundWithdrawn = priorConfiguration?.outboundEnabled === true && resolved.settings.outboundEnabled !== true;
  /** Targets whose executable definition changed or disappeared (M3-D7 fence set). */
  const changedTargetIds: string[] = [];
  const versions = {
    partnerVersionId: snapshot.layers.partner?.versionId ?? null,
    orgVersionId: snapshot.layers.organization?.versionId ?? null,
    configurationDigest: resolved.digest,
  };
  const [binding] = await db
    .insert(topologySiteTemplateBindings)
    .values({
      ...ctx.scope,
      partnerVersionId: versions.partnerVersionId,
      orgVersionId: versions.orgVersionId,
      overrides,
      revision: 1n,
      effectiveDigest: resolved.digest,
      status: 'bound',
      ...(operationId ? { applyOperationId: operationId } : {}),
      updatedBy: ctx.auth.user.id,
    })
    .onConflictDoUpdate({
      target: [
        topologySiteTemplateBindings.orgId,
        topologySiteTemplateBindings.siteId,
      ],
      set: {
        partnerVersionId: versions.partnerVersionId,
        orgVersionId: versions.orgVersionId,
        overrides,
        revision: sql`${topologySiteTemplateBindings.revision}+1`,
        effectiveDigest: resolved.digest,
        status: 'bound',
        ...(operationId ? { applyOperationId: operationId } : {}),
        updatedBy: ctx.auth.user.id,
        updatedAt: now,
      },
    })
    .returning();
  const targets = await db
    .select()
    .from(topologyProbeTargets)
    .where(scopedWrite(ctx.scope, topologyProbeTargets));
  const byKey = new Map(targets.map((row) => [row.key, row]));
  const compiledTargets = new Map<string, { id: string; revision: bigint }>();
  for (const [key, definition] of Object.entries(resolved.settings.targets)) {
    if (definition.kind === 'tombstone') continue;
    const old = byKey.get(key);
    const changed =
      !old ||
      canonicalizeArguments(old.definition) !==
        canonicalizeArguments(definition) ||
      old.deletedAt !== null;
    const [row] = await db
      .insert(topologyProbeTargets)
      .values({
        ...ctx.scope,
        ...versions,
        key,
        label: definition.label,
        kind: definition.kind,
        definition,
        enabled: definition.enabled,
        createdBy: ctx.auth.user.id,
        updatedBy: ctx.auth.user.id,
      })
      .onConflictDoUpdate({
        target: [
          topologyProbeTargets.orgId,
          topologyProbeTargets.siteId,
          topologyProbeTargets.key,
        ],
        set: {
          ...versions,
          label: definition.label,
          kind: definition.kind,
          definition,
          enabled: definition.enabled,
          revision: changed
            ? sql`${topologyProbeTargets.revision}+1`
            : topologyProbeTargets.revision,
          deletedAt: null,
          updatedBy: ctx.auth.user.id,
          updatedAt: now,
        },
      })
      .returning();
    compiledTargets.set(key, { id: row!.id, revision: row!.revision });
    if (old && changed) changedTargetIds.push(row!.id);
  }
  const removedTargets = targets.filter(
    (row) => !compiledTargets.has(row.key) && row.deletedAt === null,
  );
  changedTargetIds.push(...removedTargets.map((row) => row.id));
  if (removedTargets.length)
    await db
      .update(topologyProbeTargets)
      .set({
        enabled: false,
        deletedAt: now,
        revision: sql`${topologyProbeTargets.revision}+1`,
        updatedAt: now,
      })
      .where(
        inArray(
          topologyProbeTargets.id,
          removedTargets.map((row) => row.id),
        ),
      );
  const policies = await db
    .select()
    .from(topologyMonitoringPolicies)
    .where(scopedWrite(ctx.scope, topologyMonitoringPolicies));
  const byPolicyKey = new Map(policies.map((row) => [row.key, row]));
  const existingPins = await db
    .select()
    .from(topologyPolicyTargets)
    .where(scopedWrite(ctx.scope, topologyPolicyTargets));
  const pinsFor = (policyId: string) =>
    existingPins
      .filter((pin) => pin.policyId === policyId)
      .map((pin) => ({ id: pin.targetId, revision: pin.targetRevision.toString(), purpose: pin.purpose, position: pin.position }));
  const livePolicies = new Set<string>();
  const disarmedPolicyIds: string[] = [];
  for (const [key, definition] of Object.entries(resolved.settings.policies)) {
    if (definition.kind === 'tombstone') continue;
    livePolicies.add(key);
    const pins = definition.targetKeys.map((targetKey, position) => {
      const target = compiledTargets.get(targetKey);
      if (!target) throw new TopologyOperationError('target_not_configured', 409);
      return { id: target.id, revision: target.revision.toString(), purpose: 'configured_target', position };
    });
    const old = byPolicyKey.get(key);
    const unchanged =
      !!old &&
      old.deletedAt === null &&
      topologyPolicyMaterialDigest({ definition: old.definition, targets: pinsFor(old.id) }) ===
        topologyPolicyMaterialDigest({ definition, targets: pins });
    // M3-D7: an unchanged executable effect keeps its arm, authority and
    // revision; only provenance and the activation intent follow the write.
    if (old && unchanged) {
      if (old.enabled && !definition.enabled) {
        await disarmPolicyRow(ctx.scope, old, 'activation_withdrawn', { ...versions, activationIntent: false });
        disarmedPolicyIds.push(old.id);
      } else {
        await db
          .update(topologyMonitoringPolicies)
          .set({
            ...versions,
            activationIntent: definition.enabled,
            ...(old.enabled ? {} : { blockedReason: definition.enabled ? (old.blockedReason ?? 'not_armed') : null }),
            updatedAt: now,
          })
          .where(eq(topologyMonitoringPolicies.id, old.id));
      }
      continue;
    }
    let policyId: string;
    if (old) {
      policyId = old.id;
      const material = {
        ...versions,
        definition,
        activationIntent: definition.enabled,
        deletedAt: null,
      };
      if (old.enabled) {
        await disarmPolicyRow(ctx.scope, old, 'rearm_required', material);
        disarmedPolicyIds.push(old.id);
      } else {
        await db
          .update(topologyMonitoringPolicies)
          .set({
            ...material,
            blockedReason: definition.enabled ? 'not_armed' : null,
            authorityGeneration: sql`${topologyMonitoringPolicies.authorityGeneration}+1`,
            revision: sql`${topologyMonitoringPolicies.revision}+1`,
            updatedAt: now,
          })
          .where(eq(topologyMonitoringPolicies.id, old.id));
      }
    } else {
      const [inserted] = await db
        .insert(topologyMonitoringPolicies)
        .values({
          ...ctx.scope,
          ...versions,
          key,
          definition,
          enabled: false,
          activationIntent: definition.enabled,
          blockedReason: definition.enabled ? 'not_armed' : null,
          requesterId: ctx.auth.user.id,
        })
        .returning();
      policyId = inserted!.id;
    }
    await db
      .delete(topologyPolicyTargets)
      .where(
        and(
          scopedWrite(ctx.scope, topologyPolicyTargets),
          eq(topologyPolicyTargets.policyId, policyId),
        ),
      );
    for (const pin of pins) {
      await db.insert(topologyPolicyTargets).values({
        ...ctx.scope,
        policyId,
        targetId: pin.id,
        targetRevision: BigInt(pin.revision),
        purpose: pin.purpose,
        position: pin.position,
      });
    }
  }
  const removedPolicies = policies.filter(
    (row) => !livePolicies.has(row.key) && row.deletedAt === null,
  );
  for (const row of removedPolicies) {
    await disarmPolicyRow(ctx.scope, row, 'policy_removed', { deletedAt: now });
    disarmedPolicyIds.push(row.id);
  }
  if (removedPolicies.length)
    await db.delete(topologyPolicyTargets).where(
      and(
        scopedWrite(ctx.scope, topologyPolicyTargets),
        inArray(
          topologyPolicyTargets.policyId,
          removedPolicies.map((row) => row.id),
        ),
      ),
    );
  // M3-D7: a queued plan cannot inherit changed destination/configuration
  // authority — but only the plans that DEPEND on what changed are fenced
  // (their pinned targets, outbound probing, a disarmed policy); every other
  // queued run keeps its slot.
  const affected = queuedRunsAffectedByConfiguration({ changedTargetIds, outboundWithdrawn, disarmedPolicyIds });
  if (affected) {
    await db.execute(
      sql`UPDATE device_commands SET status='cancelled',completed_at=now() WHERE status IN ('pending','queued','sent') AND id IN(SELECT r.command_id FROM topology_diagnostic_runs r WHERE r.org_id=${ctx.scope.orgId}::uuid AND r.site_id=${ctx.scope.siteId}::uuid AND r.state='queued' AND (${affected}))`,
    );
    await db.execute(
      sql`UPDATE topology_diagnostic_runs r SET state='cancelled',finished_at=now(),failure_reason='configuration_changed' WHERE r.org_id=${ctx.scope.orgId}::uuid AND r.site_id=${ctx.scope.siteId}::uuid AND r.state='queued' AND (${affected})`,
    );
  }
  const [state] = await db
    .update(topologySiteState)
    .set({
      settingsRevision: sql`${topologySiteState.settingsRevision}+1`,
      dirtyRevision: sql`${topologySiteState.dirtyRevision}+1`,
      settingsDigest: resolved.digest,
      effectiveSettings: sql`${topologySiteState.effectiveSettings} || ${JSON.stringify({ configuration: resolved.settings })}::jsonb`,
      updatedAt: now,
    })
    .where(scopedWrite(ctx.scope, topologySiteState))
    .returning();
  await db.insert(topologyChangeOutbox).values({
    ...ctx.scope,
    eventKind: 'configuration.change',
    aggregateId: binding!.id,
    sourceRevision: state!.dirtyRevision,
    idempotencyKey: `configuration:${binding!.id}:${binding!.revision}`,
    payload: {
      version: 1,
      settingsRevision: state!.settingsRevision.toString(),
      configurationDigest: resolved.digest,
    },
  });
  await db.insert(auditLogs).values({
    orgId: ctx.scope.orgId,
    actorType: 'user',
    actorId: ctx.auth.user.id,
    actorEmail: ctx.auth.user.email,
    action: 'topology.configuration.updated',
    resourceType: 'topology_site',
    resourceId: ctx.scope.siteId,
    result: 'success',
    details: {
      bindingRevision: binding!.revision.toString(),
      settingsRevision: state!.settingsRevision.toString(),
      configurationDigest: resolved.digest,
    },
  });
}

/** SQL predicate over `topology_diagnostic_runs r` for queued runs a configuration write invalidates; null when nothing is affected. */
export function queuedRunsAffectedByConfiguration(input: {
  changedTargetIds: readonly string[];
  outboundWithdrawn: boolean;
  disarmedPolicyIds: readonly string[];
}) {
  const clauses = [];
  const configuredTargets = sql`jsonb_array_elements(coalesce(r.plan->'destinations','[]'::jsonb)) d WHERE d->'target'->>'kind' = 'configured_target'`;
  if (input.changedTargetIds.length)
    clauses.push(sql`EXISTS (SELECT 1 FROM ${configuredTargets} AND d->'target'->>'targetId' IN (${sql.join(input.changedTargetIds.map((id) => sql`${id}`), sql`,`)}))`);
  if (input.outboundWithdrawn) clauses.push(sql`EXISTS (SELECT 1 FROM ${configuredTargets})`);
  if (input.disarmedPolicyIds.length)
    clauses.push(sql`r.policy_id IN (${sql.join(input.disarmedPolicyIds.map((id) => sql`${id}::uuid`), sql`,`)})`);
  return clauses.length ? sql.join(clauses, sql` OR `) : null;
}

export type ApprovedTopologySiteEffect = {
  siteId: string;
  expectedBindingRevision: string;
  expectedSettingsRevision: string;
  partnerVersionId: string | null;
  orgVersionId: string | null;
  overrides: TopologyConfigurationPayload;
  resolvedDigest: string;
  templateRevisions: Record<string, string>;
  enableRecurring: boolean;
  operationId: string;
};
/** Preview is not authority: worker supplies freshly reconstructed user context. */
export async function applyTopologyTemplateSite(
  ctx: TopologyRequestContext,
  effect: ApprovedTopologySiteEffect,
): Promise<TopologyTemplateSiteOutcome> {
  if (ctx.scope.siteId !== z.uuid().parse(effect.siteId))
    throw new TopologyOperationError('topology_site_not_found', 404);
  if (effect.enableRecurring)
    throw new TopologyOperationError('capability_unavailable', 409);
  expectedRevisionSchema.parse(effect.expectedBindingRevision);
  expectedRevisionSchema.parse(effect.expectedSettingsRevision);
  z.uuid().parse(effect.operationId);
  return withDbTransaction(async () => {
    await requireTopologySiteAccess(
      ctx.auth,
      ctx.permissions,
      ctx.scope.siteId,
      'write',
    );
    await db.insert(topologySiteState).values(ctx.scope).onConflictDoNothing();
    const [state] = await db
      .select()
      .from(topologySiteState)
      .where(scopedWrite(ctx.scope, topologySiteState))
      .for('update');
    const current = await loadTopologyConfiguration(ctx);
    // A successful per-site operation is idempotent even after later edits.
    // Durable operation outcomes are checked by the caller before this fallback.
    if (current.binding?.applyOperationId === effect.operationId)
      return {
        siteId: ctx.scope.siteId,
        state: 'applied',
        code: null,
        settingsRevision: current.settingsRevision,
      };
    if (
      !state ||
      state.settingsRevision.toString() !== effect.expectedSettingsRevision ||
      (current.binding?.revision ?? 0n).toString() !==
        effect.expectedBindingRevision
    )
      throw new TopologyOperationError('revision_conflict', 409);
    const next = await loadTopologyConfiguration(ctx, {
      partnerVersionId: effect.partnerVersionId,
      orgVersionId: effect.orgVersionId,
      overrides: topologyConfigurationSchema.parse(effect.overrides),
    });
    if (
      canonicalizeArguments(next.templateRevisions) !==
        canonicalizeArguments(effect.templateRevisions) ||
      next.resolved.digest !== effect.resolvedDigest
    )
      throw new TopologyOperationError('template_revision_changed', 409);
    await assertConfigurationEffects(
      ctx,
      current.resolved.settings,
      next.resolved.settings,
    );
    await persistCompiledConfiguration(
      ctx,
      next,
      next.resolved,
      effect.overrides,
      effect.operationId,
    );
    return {
      siteId: ctx.scope.siteId,
      state: 'applied',
      code: null,
      settingsRevision: (state.settingsRevision + 1n).toString(),
    };
  });
}
