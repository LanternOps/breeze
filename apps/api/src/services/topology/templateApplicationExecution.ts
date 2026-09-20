import { and, eq, sql } from 'drizzle-orm';
import type { TopologyTemplateSiteOutcome } from '@breeze/shared';
import {
  db,
  runOutsideDbContext,
  withSystemDbAccessContext,
  withDbTransaction,
} from '../../db';
import { topologyChangeOutbox, auditLogs } from '../../db/schema';
import { withAuthDbAccessContext } from '../../middleware/auth';
import { getPermissionAuthorityVersion } from '../permissions';
import { TopologyError, requireTopologySiteAccess } from './access';
import { TopologyOperationError } from './operationErrors';
import { applyTopologyTemplateSite } from './siteConfiguration';
import { currentApplicationAuthority } from './templateApplicationAuthority';
import {
  applicationRecord,
  applicationEffectDigest,
  type ApplicationRow,
} from './templateApplicationStore';
import {
  INTENT_EVENT,
  type TemplateApplicationRecord,
} from './templateApplicationTypes';

function isPending(record: TemplateApplicationRecord) {
  return (
    record.outcome?.state === 'queued' || record.outcome?.state === 'running'
  );
}
async function outcome(
  row: ApplicationRow,
  record: TemplateApplicationRecord,
  result: TopologyTemplateSiteOutcome,
) {
  await db
    .update(topologyChangeOutbox)
    .set({
      payload: { ...record, outcome: result } as unknown as Record<
        string,
        unknown
      >,
      updatedAt: new Date(),
      nextAttemptAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(topologyChangeOutbox.id, row.id),
        eq(topologyChangeOutbox.eventKind, INTENT_EVENT),
      ),
    );
  await db.insert(auditLogs).values({
    actorType: 'user',
    orgId: row.orgId,
    actorId: record.requesterId,
    actorEmail: record.actor.user.email,
    action: `topology.template.application_${result.state}`,
    resourceType: 'topology_template_application',
    resourceId: record.operationId!,
    result: result.state === 'applied' ? 'success' : 'failure',
    details: {
      siteId: row.siteId,
      code: result.code,
      settingsRevision: result.settingsRevision,
    },
  });
}
async function recordConflict(row: ApplicationRow, code: string) {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        withDbTransaction(async () => {
          const [locked] = await db
            .select()
            .from(topologyChangeOutbox)
            .where(
              and(
                eq(topologyChangeOutbox.id, row.id),
                eq(topologyChangeOutbox.eventKind, INTENT_EVENT),
              ),
            )
            .for('update');
          if (!locked) return;
          const record = applicationRecord(locked);
          if (!isPending(record)) return;
          await outcome(locked, record, {
            siteId: locked.siteId,
            state: 'conflict',
            code,
            settingsRevision: null,
          });
        }),
      'topology template application conflict',
    ),
  );
}
/** One site transaction includes compiler changes and its terminal journal outcome. */
export async function executeTopologyTemplateApplicationSite(
  row: ApplicationRow,
): Promise<void> {
  const record = applicationRecord(row);
  if (!isPending(record)) return;
  try {
    if (
      record.originalOrgId !== row.orgId ||
      record.effect?.siteId !== row.siteId ||
      record.effectDigest !== applicationEffectDigest(record) ||
      !record.operationId
    )
      throw new TopologyOperationError('preview_invalidated', 409);
    const live = await currentApplicationAuthority(record.actor);
    await runOutsideDbContext(() =>
      withAuthDbAccessContext(live.auth, () =>
        withDbTransaction(async () => {
          const [locked] = await db
            .select()
            .from(topologyChangeOutbox)
            .where(
              and(
                eq(topologyChangeOutbox.id, row.id),
                eq(topologyChangeOutbox.orgId, record.originalOrgId),
                eq(topologyChangeOutbox.eventKind, INTENT_EVENT),
              ),
            )
            .for('update');
          if (!locked)
            throw new TopologyOperationError('permission_changed', 403);
          const current = applicationRecord(locked);
          if (!isPending(current)) return;
          if (current.effectDigest !== applicationEffectDigest(current))
            throw new TopologyOperationError('preview_invalidated', 409);
          const ctx = await requireTopologySiteAccess(
            live.auth,
            live.permissions,
            row.siteId,
            'read',
          );
          if (ctx.scope.orgId !== record.originalOrgId)
            throw new TopologyOperationError('preview_invalidated', 409);
          const result = await applyTopologyTemplateSite(ctx, {
            ...current.effect!,
            operationId: current.operationId!,
          });
          // A grant invalidation during the compiler transaction must roll back the
          // binding too, not just change the outcome after committing it.
          if (
            (await getPermissionAuthorityVersion(record.requesterId)) !==
            live.version
          )
            throw new TopologyOperationError(
              'topology_authority_unavailable',
              503,
            );
          await outcome(locked, current, result);
        }),
      ),
    );
  } catch (error) {
    if (
      error instanceof TopologyError ||
      (error instanceof TopologyOperationError && error.status !== 503)
    ) {
      const code =
        error instanceof TopologyError || error.status === 403
          ? 'permission_changed'
          : error.code;
      await recordConflict(row, code);
      return;
    }
    // Infrastructure failures remain pending. The durable journal, not an
    // in-memory timer/BullMQ acknowledgement, is the recovery authority.
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(
        () =>
          db
            .update(topologyChangeOutbox)
            .set({
              attemptCount: sql`${topologyChangeOutbox.attemptCount}+1`,
              lastAttemptAt: new Date(),
              nextAttemptAt: new Date(Date.now() + 5_000),
              lastError: 'application_retry_pending',
            })
            .where(eq(topologyChangeOutbox.id, row.id)),
        'topology template application retry',
      ),
    );
    throw error;
  }
}
export async function drainTopologyTemplateApplications(
  limit = 20,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error('Invalid template application batch');
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        db
          .select()
          .from(topologyChangeOutbox)
          .where(
            and(
              eq(topologyChangeOutbox.eventKind, INTENT_EVENT),
              sql`${topologyChangeOutbox.payload}->'outcome'->>'state' IN ('queued','running')`,
              sql`(${topologyChangeOutbox.nextAttemptAt} IS NULL OR ${topologyChangeOutbox.nextAttemptAt} <= now())`,
            ),
          )
          .orderBy(topologyChangeOutbox.createdAt, topologyChangeOutbox.id)
          .limit(limit),
      'topology template application pending discovery',
    ),
  );
  for (const row of rows) await executeTopologyTemplateApplicationSite(row);
  return rows.length;
}
