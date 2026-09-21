import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import {
  topologyTemplatePreviewRequestSchema,
  type TopologyTemplatePreview,
  type TopologyTemplateApplication,
  type TopologyTemplatePreviewRequest,
  type TopologyTemplateSiteOutcome,
  type TopologyConfigurationPayload,
} from '@breeze/shared';
import {
  canonicalizeArguments,
  computeArgumentDigest,
} from '@breeze/shared/canonicalize';
import {
  db,
  withDbTransaction,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';
import { topologyChangeOutbox, auditLogs } from '../../db/schema';
import { type AuthContext } from '../../middleware/auth';
import {
  getPermissionAuthorityVersion,
  type UserPermissions,
} from '../permissions';
import {
  requireTopologySiteAccess,
  TopologyError,
  type TopologyRequestContext,
} from './access';
import { TopologyOperationError } from './operationErrors';
import {
  loadTopologyConfiguration,
  assertConfigurationEffects,
} from './siteConfiguration';
import {
  currentApplicationAuthority,
  freezeApplicationActor,
} from './templateApplicationAuthority';
import {
  applicationHash,
  applicationEffectDigest,
  applicationId,
  applicationRecord,
  applicationRows,
  insertApplicationRow,
} from './templateApplicationStore';
import {
  INTENT_EVENT,
  PREVIEW_EVENT,
  PREVIEW_TTL_MS,
  type TemplateApplicationRecord,
} from './templateApplicationTypes';

export function capabilityUnavailable(capability: string): never {
  throw new TopologyOperationError(
    'capability_unavailable',
    409,
    `${capability} is not available`,
  );
}
export async function assertEffectCapabilities(
  ctx: TopologyRequestContext,
  before: TopologyConfigurationPayload,
  after: TopologyConfigurationPayload,
  enableRecurring: boolean,
) {
  if (enableRecurring) capabilityUnavailable('recurringMonitoring');
  await assertConfigurationEffects(ctx, before, after);
}
const digest = (value: unknown) =>
  computeArgumentDigest(canonicalizeArguments({ value }));
const failureCode = (error: unknown) =>
  error instanceof TopologyOperationError || error instanceof TopologyError
    ? error.code
    : null;
function effects(
  before: TopologyConfigurationPayload,
  after: TopologyConfigurationPayload,
): TopologyTemplatePreview['sites'][number]['effects'] {
  const output: TopologyTemplatePreview['sites'][number]['effects'] = [];
  for (const field of [
    'passive',
    'outboundEnabled',
    'targets',
    'policies',
  ] as const) {
    if (digest(before[field] ?? null) !== digest(after[field] ?? null))
      output.push({
        field,
        action: 'replace',
        capability:
          field === 'passive' ? 'passiveSettings' : 'monitoringTargets',
        reason: null,
      });
  }
  return output;
}
export async function previewTopologyTemplateApplication(
  auth: AuthContext,
  permissions: UserPermissions,
  input: TopologyTemplatePreviewRequest,
): Promise<TopologyTemplatePreview> {
  const request = topologyTemplatePreviewRequestSchema.parse(input),
    actor = freezeApplicationActor(auth);
  const live = await currentApplicationAuthority(actor);
  const token = randomBytes(32).toString('base64url'),
    tokenDigest = applicationHash(token),
    previewId = applicationId(actor.user.id, tokenDigest);
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const output: TopologyTemplatePreview = { token, expiresAt, sites: [] };
  // One request transaction records an all-or-nothing preview; no runtime rows
  // or binding revisions are changed by this POST.
  await withDbTransaction(async () => {
    for (const selected of request.sites) {
      await requireTopologySiteAccess(
        auth,
        permissions,
        selected.siteId,
        'read',
      );
      const ctx = await requireTopologySiteAccess(
        live.auth,
        live.permissions,
        selected.siteId,
        'read',
      );
      const preview: TopologyTemplatePreview['sites'][number] = {
        siteId: selected.siteId,
        expectedBindingRevision: selected.expectedBindingRevision,
        effects: [],
        errors: [],
      };
      let effect: TemplateApplicationRecord['effect'] = null;
      try {
        const before = await loadTopologyConfiguration(ctx);
        if (
          (before.binding?.revision.toString() ?? '0') !==
          selected.expectedBindingRevision
        )
          throw new TopologyOperationError('revision_conflict', 409);
        const next = await loadTopologyConfiguration(ctx, {
          partnerVersionId: request.partnerVersionId,
          orgVersionId: request.orgVersionId,
          overrides: selected.overrides,
        });
        await assertEffectCapabilities(
          ctx,
          before.resolved.settings,
          next.resolved.settings,
          selected.enableRecurring,
        );
        preview.effects = effects(
          before.resolved.settings,
          next.resolved.settings,
        );
        effect = {
          siteId: selected.siteId,
          expectedBindingRevision: selected.expectedBindingRevision,
          expectedSettingsRevision: before.settingsRevision,
          partnerVersionId: request.partnerVersionId,
          orgVersionId: request.orgVersionId,
          overrides: selected.overrides ??
            before.binding?.overrides ?? { targets: {}, policies: {} },
          resolvedDigest: next.resolved.digest,
          templateRevisions: next.templateRevisions,
          enableRecurring: selected.enableRecurring,
          operationId: previewId,
        };
      } catch (error) {
        const code = failureCode(error);
        if (!code) throw error;
        preview.errors.push({ code, field: null });
      }
      const record: TemplateApplicationRecord = {
        version: 1,
        requesterId: actor.user.id,
        originalOrgId: ctx.scope.orgId,
        actor,
        previewId,
        tokenDigest,
        permissionVersion: live.version,
        expiresAt,
        effectDigest: digest({
          effect,
          actor,
          permissionVersion: live.version,
          expiresAt,
        }),
        effect,
        preview,
      };
      await insertApplicationRow(
        ctx.scope.orgId,
        selected.siteId,
        previewId,
        PREVIEW_EVENT,
        `template-preview:${previewId}`,
        record,
      );
      output.sites.push(preview);
    }
    if ((await getPermissionAuthorityVersion(actor.user.id)) !== live.version)
      throw new TopologyOperationError('topology_authority_unavailable', 503);
  });
  return output;
}
export async function applyTopologyTemplatePreview(
  auth: AuthContext,
  permissions: UserPermissions,
  token: string,
  idempotencyKey: string,
): Promise<TopologyTemplateApplication> {
  z.string().min(1).max(255).parse(idempotencyKey);
  z.string().min(1).max(4096).parse(token);
  const actor = freezeApplicationActor(auth),
    tokenDigest = applicationHash(token),
    id = applicationId(actor.user.id, idempotencyKey);
  const existing = await applicationRows(id, actor.user.id, INTENT_EVENT);
  if (existing.length) {
    if (
      existing.some((row) => applicationRecord(row).tokenDigest !== tokenDigest)
    )
      throw new TopologyOperationError('idempotency_conflict', 409);
    return getTopologyTemplateApplication(auth, permissions, id);
  }
  const previewId = applicationId(actor.user.id, tokenDigest),
    rows = await applicationRows(previewId, actor.user.id, PREVIEW_EVENT);
  if (!rows.length || rows.length > 500)
    throw new TopologyOperationError('preview_not_found', 404);
  const live = await currentApplicationAuthority(actor);
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      () =>
        withDbTransaction(async () => {
          await db.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${id},0))`,
          );
          const duplicate = await db
            .select()
            .from(topologyChangeOutbox)
            .where(
              and(
                eq(topologyChangeOutbox.aggregateId, id),
                eq(topologyChangeOutbox.eventKind, INTENT_EVENT),
              ),
            )
            .limit(1);
          if (duplicate.length) {
            if (applicationRecord(duplicate[0]!).tokenDigest !== tokenDigest)
              throw new TopologyOperationError('idempotency_conflict', 409);
            return;
          }
          for (const row of rows) {
            const record = applicationRecord(row);
            if (record.expiresAt <= new Date().toISOString())
              throw new TopologyOperationError('preview_expired', 409);
            if (
              record.originalOrgId !== row.orgId ||
              record.tokenDigest !== tokenDigest ||
              record.effectDigest !==
                digest({
                  effect: record.effect,
                  actor: record.actor,
                  permissionVersion: record.permissionVersion,
                  expiresAt: record.expiresAt,
                })
            )
              throw new TopologyOperationError('preview_invalidated', 409);
            let code = record.preview.errors[0]?.code ?? null;
            if (!code && record.effect) {
              try {
                await requireTopologySiteAccess(
                  auth,
                  permissions,
                  row.siteId,
                  'read',
                );
                const ctx = await requireTopologySiteAccess(
                  live.auth,
                  live.permissions,
                  row.siteId,
                  'read',
                );
                if (ctx.scope.orgId !== record.originalOrgId)
                  throw new TopologyOperationError('preview_invalidated', 409);
                const before = await loadTopologyConfiguration(ctx);
                const next = await loadTopologyConfiguration(ctx, {
                  partnerVersionId: record.effect.partnerVersionId,
                  orgVersionId: record.effect.orgVersionId,
                  overrides: record.effect.overrides,
                });
                await assertEffectCapabilities(
                  ctx,
                  before.resolved.settings,
                  next.resolved.settings,
                  record.effect.enableRecurring,
                );
              } catch (error) {
                const failure = failureCode(error);
                if (
                  !failure ||
                  (error instanceof TopologyOperationError &&
                    error.status === 503)
                )
                  throw error;
                code =
                  error instanceof TopologyError
                    ? 'permission_changed'
                    : failure;
              }
            }
            const outcome: TopologyTemplateSiteOutcome = {
              siteId: row.siteId,
              state: code ? 'conflict' : 'queued',
              code,
              settingsRevision: null,
            };
            await insertApplicationRow(
              row.orgId,
              row.siteId,
              id,
              INTENT_EVENT,
              `template-apply:${id}`,
              {
                ...record,
                actor,
                permissionVersion: live.version,
                effectDigest: applicationEffectDigest({
                  ...record,
                  actor,
                  permissionVersion: live.version,
                }),
                operationId: id,
                idempotencyDigest: applicationHash(idempotencyKey),
                outcome,
              },
            );
            await db.insert(auditLogs).values({
              actorType: 'user',
              orgId: row.orgId,
              actorId: actor.user.id,
              actorEmail: actor.user.email,
              action: 'topology.template.application_accepted',
              resourceType: 'topology_template_application',
              resourceId: id,
              result: 'success',
              details: { siteId: row.siteId, previewId },
            });
            // A site refused at admission is never seen by the worker, so this
            // is the only place its conflict can reach the audit trail.
            if (code)
              await db.insert(auditLogs).values({
                actorType: 'user',
                orgId: row.orgId,
                actorId: actor.user.id,
                actorEmail: actor.user.email,
                action: 'topology.template.application_conflict',
                resourceType: 'topology_template_application',
                resourceId: id,
                result: 'failure',
                details: { siteId: row.siteId, previewId, code },
              });
          }
        }),
      'topology template application admission',
    ),
  );
  return getTopologyTemplateApplication(auth, permissions, id);
}
export function summarizeTemplateApplication(
  id: string,
  sites: TopologyTemplateSiteOutcome[],
): TopologyTemplateApplication {
  const pending = sites.some(
      (site) => site.state === 'queued' || site.state === 'running',
    ),
    applied = sites.filter((site) => site.state === 'applied').length;
  return {
    id,
    state: pending
      ? 'running'
      : sites.length > 0 && applied === sites.length
        ? 'completed'
        : applied > 0
          ? 'partial'
          : 'failed',
    sites,
  };
}
export async function getTopologyTemplateApplication(
  auth: AuthContext,
  permissions: UserPermissions,
  id: string,
): Promise<TopologyTemplateApplication> {
  z.uuid().parse(id);
  const live = await currentApplicationAuthority(freezeApplicationActor(auth));
  const rows = await applicationRows(id, auth.user.id, INTENT_EVENT),
    outcomes: TopologyTemplateSiteOutcome[] = [];
  for (const row of rows) {
    try {
      await requireTopologySiteAccess(auth, permissions, row.siteId, 'read');
      const current = await requireTopologySiteAccess(
        live.auth,
        live.permissions,
        row.siteId,
        'read',
      );
      const record = applicationRecord(row);
      if (
        current.scope.orgId !== record.originalOrgId ||
        row.orgId !== record.originalOrgId
      )
        continue;
      if (record.outcome) outcomes.push(record.outcome);
    } catch (error) {
      if (error instanceof TopologyError) continue;
      throw error;
    }
  }
  if ((await getPermissionAuthorityVersion(auth.user.id)) !== live.version)
    throw new TopologyOperationError('topology_authority_unavailable', 503);
  if (!outcomes.length)
    throw new TopologyOperationError('application_not_found', 404);
  return summarizeTemplateApplication(id, outcomes);
}
