// Bare-metal recovery W04a: session-authed create/list/get recovery routes,
// and the public token-less exchange (code -> recovery token + bootstrap)
// and public token-authed phase-progress routes. See spec
// docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1 and plan docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md.
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { db } from '../../db';
import {
  BARE_METAL_RECOVERY_TERMINAL,
  bareMetalRecoveries,
  backupSnapshots,
  devices,
  recoveryTokens,
  type BareMetalRecoveryStatus,
} from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { authorizeRouteResilienceResources } from './resilienceAuthorization';
import {
  canTransition,
  formatRecoveryCode,
  generateRecoveryCode,
  generateRecoveryNonce,
  hashRecoveryCode,
  hashRecoveryNonce,
  isOverdue,
  normalizeRecoveryCode,
  RECOVERY_CODE_TTL_MS,
} from '../../services/bareMetalRecoveryCodes';
import {
  buildAuthenticatedBootstrapPayload,
  generateRecoveryToken,
  hashRecoveryToken,
  isValidRecoveryTokenFormat,
  resolveSnapshotProviderConfig,
} from '../../services/recoveryBootstrap';
import { enforcePublicRateLimit, enforceTokenRateLimit, runInRecoveryOrgContext } from './bmr';
import {
  bmrExchangeSchema,
  bmrProgressSchema,
  bmrRecoveryCreateSchema,
  bmrRecoveryListSchema,
} from './schemas';

const idParamSchema = z.object({ id: z.string().guid() });

export const bmrRecoveryRoutes = new Hono();
export const bmrRecoveryPublicRoutes = new Hono();

type BareMetalRecoveryRow = typeof bareMetalRecoveries.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function toRecoverySummary(row: BareMetalRecoveryRow) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    snapshotId: row.snapshotId,
    recoveryTokenId: row.recoveryTokenId,
    identity: row.identity,
    status: row.status,
    overdue: isOverdue(row.status, row.rebootedAt),
    codeExpiresAt: row.codeExpiresAt.toISOString(),
    codeUsedAt: iso(row.codeUsedAt),
    target: row.target ?? null,
    plan: row.plan ?? null,
    result: row.result ?? null,
    failureReason: row.failureReason ?? null,
    warnings: row.warnings ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    mediaBootedAt: iso(row.mediaBootedAt),
    plannedAt: iso(row.plannedAt),
    restoringAt: iso(row.restoringAt),
    validatedAt: iso(row.validatedAt),
    rebootedAt: iso(row.rebootedAt),
    checkedInAt: iso(row.checkedInAt),
    completedAt: iso(row.completedAt),
  };
}

// ── Session-authed: create / list / get ─────────────────────────────

bmrRecoveryRoutes.post(
  '/bmr/recoveries',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', bmrRecoveryCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(
      c,
      orgId,
      [{ kind: 'snapshot', id: payload.snapshotId, role: 'source' }],
      'token'
    );
    if (!authorization.ok) return authorization.response;

    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, payload.snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);
    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }
    if (snapshot.bareMetalRestorable !== true) {
      return c.json(
        {
          error: 'snapshot_not_bare_metal_restorable',
          reasons: snapshot.bareMetalReasons ?? ['snapshot was not assessed for bare-metal restore'],
        },
        409
      );
    }

    const [inProgress] = await db
      .select({ id: bareMetalRecoveries.id, status: bareMetalRecoveries.status })
      .from(bareMetalRecoveries)
      .where(
        and(
          eq(bareMetalRecoveries.deviceId, snapshot.deviceId),
          eq(bareMetalRecoveries.orgId, orgId),
          notInArray(bareMetalRecoveries.status, [...BARE_METAL_RECOVERY_TERMINAL])
        )
      )
      .limit(1);
    if (inProgress) {
      return c.json({ error: 'recovery_in_progress', recoveryId: inProgress.id, status: inProgress.status }, 409);
    }

    const code = generateRecoveryCode();
    const [row] = await db
      .insert(bareMetalRecoveries)
      .values({
        orgId,
        deviceId: snapshot.deviceId,
        snapshotId: snapshot.id,
        identity: payload.identity,
        codeHash: hashRecoveryCode(code),
        codeExpiresAt: new Date(Date.now() + RECOVERY_CODE_TTL_MS),
        // Placeholder until exchange, which generates and discloses the real
        // nonce exactly once — the column is NOT NULL so create needs some
        // hash here, but nothing in the system knows this placeholder's
        // preimage, so it authenticates nothing on its own.
        nonceHash: hashRecoveryNonce(generateRecoveryNonce()),
        status: 'created',
        createdBy: auth.user?.id ?? null,
      })
      .returning();
    if (!row) {
      return c.json({ error: 'Failed to create recovery' }, 500);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.recovery.create',
      resourceType: 'bare_metal_recovery',
      resourceId: row.id,
      details: { snapshotId: snapshot.id, deviceId: snapshot.deviceId, identity: payload.identity },
    });

    return c.json({ ...toRecoverySummary(row), code: formatRecoveryCode(code) }, 201);
  }
);

bmrRecoveryRoutes.get(
  '/bmr/recoveries',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', bmrRecoveryListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }
    const query = c.req.valid('query');

    const rows = await db
      .select()
      .from(bareMetalRecoveries)
      .where(
        and(
          eq(bareMetalRecoveries.orgId, orgId),
          query.deviceId ? eq(bareMetalRecoveries.deviceId, query.deviceId) : undefined
        )
      )
      .orderBy(desc(bareMetalRecoveries.createdAt))
      .limit(query.limit);

    return c.json({ data: rows.map(toRecoverySummary) });
  }
);

bmrRecoveryRoutes.get(
  '/bmr/recoveries/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }
    const { id } = c.req.valid('param');

    const [row] = await db
      .select()
      .from(bareMetalRecoveries)
      .where(and(eq(bareMetalRecoveries.id, id), eq(bareMetalRecoveries.orgId, orgId)))
      .limit(1);
    if (!row) {
      return c.json({ error: 'Recovery not found' }, 404);
    }

    return c.json(toRecoverySummary(row));
  }
);

// ── Public: exchange (code -> token + bootstrap) ────────────────────

async function buildRecoveryExchangeBootstrap(
  c: { req: { url: string } },
  tokenRow: {
    id: string;
    deviceId: string;
    snapshotId: string | null;
    restoreType: string;
    targetConfig: unknown;
    expiresAt: Date;
    authenticatedAt: Date | null;
  },
  recovery: { id: string; identity: 'original' | 'new'; deviceId: string; snapshotId: string | null; nonce: string }
) {
  const resolvedSnapshot = await resolveSnapshotProviderConfig(tokenRow.snapshotId);
  const snapshot = resolvedSnapshot?.snapshot ?? null;
  const config = resolvedSnapshot?.config ?? null;
  if (!snapshot) {
    return { error: 'recovery_snapshot_not_found' as const };
  }

  const [device] = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      architecture: devices.architecture,
      displayName: devices.displayName,
    })
    .from(devices)
    .where(eq(devices.id, tokenRow.deviceId))
    .limit(1);

  return buildAuthenticatedBootstrapPayload({
    tokenId: tokenRow.id,
    deviceId: tokenRow.deviceId,
    snapshotId: snapshot.id,
    restoreType: tokenRow.restoreType,
    targetConfig: tokenRow.targetConfig,
    authenticatedAt: tokenRow.authenticatedAt ?? new Date(),
    device: device
      ? {
          id: device.id,
          hostname: device.hostname,
          displayName: device.displayName ?? null,
          osType: device.osType,
          architecture: device.architecture,
        }
      : null,
    snapshot: {
      id: snapshot.id,
      orgId: snapshot.orgId,
      jobId: snapshot.jobId,
      deviceId: snapshot.deviceId,
      configId: snapshot.configId ?? null,
      snapshotId: snapshot.snapshotId,
      label: snapshot.label,
      location: snapshot.location,
      timestamp: snapshot.timestamp ? new Date(snapshot.timestamp).toISOString() : null,
      size: snapshot.size,
      fileCount: snapshot.fileCount,
      hardwareProfile: snapshot.hardwareProfile,
      systemStateManifest: snapshot.systemStateManifest,
      backupType: snapshot.backupType,
      isIncremental: snapshot.isIncremental,
      metadata: snapshot.metadata ?? {},
    },
    providerType: resolvedSnapshot?.providerType,
    config: config
      ? {
          id: config.id,
          orgId: config.orgId,
          name: config.name,
          type: config.type,
          provider: config.provider,
          providerConfig: config.providerConfig,
          schedule: config.schedule ?? null,
          retention: config.retention ?? null,
          isActive: config.isActive,
        }
      : null,
    requestUrl: c.req.url,
    tokenExpiresAt: tokenRow.expiresAt,
    recovery,
  });
}

bmrRecoveryPublicRoutes.post(
  '/bmr/recover/exchange',
  zValidator('json', bmrExchangeSchema),
  async (c) => {
    const limited = await enforcePublicRateLimit(c, 'exchange', 10);
    if (limited) return limited;

    const normalized = normalizeRecoveryCode(c.req.valid('json').code);
    if (!normalized) {
      return c.json({ error: 'code_invalid' }, 400);
    }
    const codeHash = hashRecoveryCode(normalized);

    const codeLimited = await enforceTokenRateLimit(c, 'exchange', codeHash, 5, 3600);
    if (codeLimited) return codeLimited;

    const [rec] = await db
      .select()
      .from(bareMetalRecoveries)
      .where(eq(bareMetalRecoveries.codeHash, codeHash))
      .limit(1);

    const now = new Date();
    if (!rec || rec.codeUsedAt || rec.codeExpiresAt.getTime() < now.getTime() || rec.status !== 'created') {
      writeAuditEvent(c, {
        orgId: rec?.orgId ?? null,
        action: 'bmr.recovery.exchange',
        resourceType: 'bare_metal_recovery',
        resourceId: rec?.id ?? null,
        result: 'failure',
        details: { reason: !rec ? 'unknown' : rec.codeUsedAt ? 'used' : rec.status !== 'created' ? 'wrong_status' : 'expired' },
      });
      return c.json({ error: 'code_invalid' }, 404);
    }

    return runInRecoveryOrgContext(rec.orgId, async () => {
      const plainToken = generateRecoveryToken();
      const tokenHash = hashRecoveryToken(plainToken);
      const nonce = generateRecoveryNonce();

      const tokenRow = await db.transaction(async (tx) => {
        const [t] = await tx
          .insert(recoveryTokens)
          .values({
            orgId: rec.orgId,
            deviceId: rec.deviceId,
            snapshotId: rec.snapshotId,
            tokenHash,
            restoreType: 'bare_metal',
            targetConfig: { bareMetalRecoveryId: rec.id },
            status: 'authenticated',
            authenticatedAt: now,
            createdBy: rec.createdBy,
            expiresAt: new Date(now.getTime() + 24 * 3600 * 1000),
          })
          .returning();
        if (!t) {
          throw new Error('Failed to mint recovery token during exchange');
        }
        await tx
          .update(bareMetalRecoveries)
          .set({
            codeUsedAt: now,
            nonceHash: hashRecoveryNonce(nonce),
            recoveryTokenId: t.id,
            status: 'media_booted',
            mediaBootedAt: now,
            updatedAt: now,
          })
          .where(eq(bareMetalRecoveries.id, rec.id));
        return t;
      });

      const bootstrap = await buildRecoveryExchangeBootstrap(c, tokenRow, {
        id: rec.id,
        identity: rec.identity as 'original' | 'new',
        deviceId: rec.deviceId,
        snapshotId: rec.snapshotId,
        nonce,
      });
      if ('error' in bootstrap) {
        return c.json(bootstrap, 409);
      }

      writeAuditEvent(c, {
        orgId: rec.orgId,
        action: 'bmr.recovery.exchange',
        resourceType: 'bare_metal_recovery',
        resourceId: rec.id,
        result: 'success',
        details: { tokenId: tokenRow.id, identity: rec.identity },
      });

      return c.json({ token: plainToken, bootstrap });
    });
  }
);

// ── Public: progress (token-authed phase reporting) ─────────────────

const PROGRESS_TIMESTAMP_FIELD: Partial<Record<BareMetalRecoveryStatus, string>> = {
  media_booted: 'mediaBootedAt',
  planned: 'plannedAt',
  restoring: 'restoringAt',
  validated: 'validatedAt',
  rebooted: 'rebootedAt',
  completed: 'completedAt',
};

bmrRecoveryPublicRoutes.post(
  '/bmr/recover/progress',
  zValidator('json', bmrProgressSchema),
  async (c) => {
    const { token, status: requestedStatus, target, plan, result, reason, warnings } = c.req.valid('json');
    if (!isValidRecoveryTokenFormat(token)) {
      return c.json({ error: 'invalid_token' }, 400);
    }
    const tokenHash = hashRecoveryToken(token);

    const limited = await enforceTokenRateLimit(c, 'progress', tokenHash, 600, 3600);
    if (limited) return limited;

    const [t] = await db
      .select({ id: recoveryTokens.id, orgId: recoveryTokens.orgId, status: recoveryTokens.status, expiresAt: recoveryTokens.expiresAt })
      .from(recoveryTokens)
      .where(eq(recoveryTokens.tokenHash, tokenHash))
      .limit(1);
    if (!t || t.status === 'revoked' || t.expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'invalid_token' }, 401);
    }

    return runInRecoveryOrgContext(t.orgId, async () => {
      const [rec] = await db
        .select()
        .from(bareMetalRecoveries)
        .where(eq(bareMetalRecoveries.recoveryTokenId, t.id))
        .limit(1);
      if (!rec) {
        return c.json({ error: 'recovery_not_found' }, 404);
      }

      const targetStatus: BareMetalRecoveryStatus =
        requestedStatus === 'validated' && rec.identity === 'new' ? 'completed' : requestedStatus;

      if (!canTransition(rec.status, targetStatus)) {
        return c.json({ error: 'invalid_transition', from: rec.status, to: targetStatus }, 409);
      }

      const now = new Date();
      const set: Record<string, unknown> = { status: targetStatus, updatedAt: now };
      if (target) set.target = target;
      if (plan !== undefined) set.plan = plan;
      if (result !== undefined) set.result = result;
      if (warnings) set.warnings = warnings;

      const timestampField = PROGRESS_TIMESTAMP_FIELD[targetStatus];
      if (timestampField) set[timestampField] = now;
      if (targetStatus === 'completed' && !rec.validatedAt) set.validatedAt = now;
      if (targetStatus === 'failed' || targetStatus === 'refused') {
        const resultRecord = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
        set.failureReason =
          reason ??
          (typeof resultRecord?.error === 'string' ? resultRecord.error : undefined) ??
          (typeof resultRecord?.refusal === 'string' ? resultRecord.refusal : undefined) ??
          `${targetStatus} without reason`;
      }

      await db.update(bareMetalRecoveries).set(set).where(eq(bareMetalRecoveries.id, rec.id));

      writeAuditEvent(c, {
        orgId: rec.orgId,
        action: 'bmr.recovery.progress',
        resourceType: 'bare_metal_recovery',
        resourceId: rec.id,
        result: 'success',
        details: { from: rec.status, to: targetStatus },
      });

      return c.json({ id: rec.id, status: targetStatus });
    });
  }
);
