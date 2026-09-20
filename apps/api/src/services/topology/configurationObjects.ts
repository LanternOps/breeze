import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  topologyStableKeySchema,
  topologyTargetDefinitionSchema,
  topologyPolicyDefinitionSchema,
  type TopologyConfigurationPayload,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { hasSatisfiedMfa } from '../../middleware/auth';
import {
  topologySiteState,
  topologyProbeTargets,
  topologyMonitoringPolicies,
} from '../../db/schema';
import {
  requireTopologySiteAccess,
  type TopologyRequestContext,
} from './access';
import {
  loadTopologyConfiguration,
  updateTopologySiteConfiguration,
} from './siteConfiguration';
import { expectedRevisionSchema, scopedWrite } from './writes';
import { TopologyOperationError } from './operationErrors';
export const topologyTargetWriteSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    key: topologyStableKeySchema,
    definition: topologyTargetDefinitionSchema,
  })
  .strict();
export const topologyPolicyWriteSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    key: topologyStableKeySchema,
    definition: topologyPolicyDefinitionSchema,
  })
  .strict();
export const topologyConfigurationDeleteSchema = z
  .object({ expectedRevision: expectedRevisionSchema })
  .strict();
export const topologyConfigurationPageSchema = z
  .object({
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
type Kind = 'targets' | 'policies';
const tables = {
  targets: topologyProbeTargets,
  policies: topologyMonitoringPolicies,
};
function dto(
  row:
    | typeof topologyProbeTargets.$inferSelect
    | typeof topologyMonitoringPolicies.$inferSelect,
) {
  return {
    ...row,
    revision: row.revision.toString(),
    ...('authorityGeneration' in row
      ? { authorityGeneration: row.authorityGeneration.toString() }
      : {}),
  };
}
export async function listTopologyConfigurationObjects(
  ctx: TopologyRequestContext,
  kind: Kind,
  page: z.infer<typeof topologyConfigurationPageSchema>,
) {
  await requireTopologySiteAccess(
    ctx.auth,
    ctx.permissions,
    ctx.scope.siteId,
    'read',
  );
  const table = tables[kind];
  const rows = await db
    .select()
    .from(table)
    .where(
      and(
        scopedWrite(ctx.scope, table),
        isNull(table.deletedAt),
        page.cursor ? gt(table.id, page.cursor) : undefined,
      ),
    )
    .orderBy(table.id)
    .limit(page.limit + 1);
  return {
    items: rows.slice(0, page.limit).map(dto),
    nextCursor: rows.length > page.limit ? rows[page.limit - 1]!.id : null,
  };
}
async function mutate(
  ctx: TopologyRequestContext,
  kind: Kind,
  input: { expectedRevision: string; key?: string; definition?: unknown },
  id?: string,
  remove = false,
) {
  return withDbTransaction(async () => {
    if (ctx.auth.principal?.kind === 'ai_agent' || !hasSatisfiedMfa(ctx.auth))
      throw new TopologyOperationError('mfa_required', 403);
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
    await db.insert(topologySiteState).values(ctx.scope).onConflictDoNothing();
    await db
      .select({ revision: topologySiteState.settingsRevision })
      .from(topologySiteState)
      .where(scopedWrite(ctx.scope, topologySiteState))
      .for('update');
    const table = tables[kind];
    let key = input.key;
    if (id) {
      const [row] = await db
        .select()
        .from(table)
        .where(
          and(
            scopedWrite(ctx.scope, table),
            eq(table.id, z.uuid().parse(id)),
            isNull(table.deletedAt),
          ),
        )
        .limit(1);
      if (!row)
        throw new TopologyOperationError('configuration_object_not_found', 404);
      if (key && key !== row.key)
        throw new TopologyOperationError('configuration_key_immutable', 409);
      key = row.key;
    }
    if (!key) throw new TopologyOperationError('invalid_request', 400);
    const snapshot = await loadTopologyConfiguration(ctx);
    if (
      remove &&
      kind === 'targets' &&
      Object.values(snapshot.resolved.settings.policies).some(
        (policy) =>
          policy.kind === 'policy' && policy.targetKeys.includes(key!),
      )
    )
      throw new TopologyOperationError('target_in_use', 409);
    const overrides: TopologyConfigurationPayload = structuredClone(
      snapshot.layers.site ?? { targets: {}, policies: {} },
    );
    Object.assign(overrides[kind], {
      [key]: remove ? { kind: 'tombstone' } : input.definition,
    });
    await updateTopologySiteConfiguration(
      ctx,
      overrides,
      input.expectedRevision,
    );
    const [row] = await db
      .select()
      .from(table)
      .where(and(scopedWrite(ctx.scope, table), eq(table.key, key)))
      .limit(1);
    return remove ? { success: true } : dto(row!);
  });
}
export function upsertTopologyProbeTarget(
  ctx: TopologyRequestContext,
  input: z.input<typeof topologyTargetWriteSchema>,
  id?: string,
) {
  return mutate(ctx, 'targets', topologyTargetWriteSchema.parse(input), id);
}
export function upsertTopologyMonitoringPolicy(
  ctx: TopologyRequestContext,
  input: z.input<typeof topologyPolicyWriteSchema>,
  id?: string,
) {
  return mutate(ctx, 'policies', topologyPolicyWriteSchema.parse(input), id);
}
export function deleteTopologyConfigurationObject(
  ctx: TopologyRequestContext,
  kind: Kind,
  id: string,
  input: z.input<typeof topologyConfigurationDeleteSchema>,
) {
  return mutate(
    ctx,
    kind,
    topologyConfigurationDeleteSchema.parse(input),
    id,
    true,
  );
}
