// Bare-metal recovery W04a: session-authed create/list/get recovery routes,
// and the public token-less exchange (code -> recovery token + bootstrap)
// and public token-authed phase-progress routes. See spec
// docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1 and plan docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md.
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  bareMetalRecoveries,
  devices,
  recoveryTokens,
  type BareMetalRecoveryStatus,
} from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeAuditEvent } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import { resolveScopedOrgId } from './helpers';
import { authorizeRouteResilienceResources } from './resilienceAuthorization';
import {
  canTransition,
  generateRecoveryNonce,
  hashRecoveryCode,
  hashRecoveryNonce,
  isOverdue,
  normalizeRecoveryCode,
} from '../../services/bareMetalRecoveryCodes';
import {
  BareMetalRecoveryError,
  cancelBareMetalRecovery,
  createBareMetalRecovery,
  reissueRecoveryCode,
} from '../../services/bareMetalRecoveryService';
import {
  asRecord,
  buildAuthenticatedBootstrapPayload,
  generateRecoveryToken,
  hashRecoveryToken,
  isValidRecoveryTokenFormat,
  resolveSnapshotProviderConfig,
} from '../../services/recoveryBootstrap';
import { negotiateRecoveryCapabilities } from '../../services/recoveryCapabilities';
import { readSnapshotFileIndexState } from '../../services/backupSnapshotFileIndex';
import { enqueueSnapshotFileIndexHydration } from '../../jobs/backupSnapshotFileIndexWorker';
import { normalizeStorageIdentity } from '../../jobs/backupRetention';
import { enforcePublicRateLimit, enforceTokenRateLimit, runInRecoveryOrgContext } from './bmr';
import {
  bmrExchangeSchema,
  bmrProgressSchema,
  bmrRecoveryCancelSchema,
  bmrRecoveryCreateSchema,
  bmrRecoveryListSchema,
} from './schemas';

const idParamSchema = z.object({ id: z.string().guid() });

function recoveryErrorResponse(c: { json: (body: unknown, status: 404 | 409) => Response }, err: BareMetalRecoveryError): Response {
  return c.json({ error: err.code, ...(err.details ?? {}) }, err.status);
}

// Bare-metal recovery W04a review fix: thrown from inside the exchange
// transaction when the conditional one-time-claim UPDATE matches 0 rows
// (another concurrent request already claimed the code, or it expired
// between the initial lookup and this transaction) — distinguishes "lost
// the race, roll back cleanly" from a genuine unexpected error.
class CodeAlreadyClaimedError extends Error {
  constructor() {
    super('bare-metal recovery code already claimed');
    this.name = 'CodeAlreadyClaimedError';
  }
}

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
    executingDeviceId: row.executingDeviceId ?? null,
    drExecutionId: row.drExecutionId ?? null,
    drGroupId: row.drGroupId ?? null,
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

    // W05a: the body lives in bareMetalRecoveryService so DR and Restore-as-VM
    // create recoveries without HTTP; the service audits `bmr.recovery.create`.
    try {
      const { row, code } = await createBareMetalRecovery({
        orgId,
        snapshotId: payload.snapshotId,
        identity: payload.identity,
        createdBy: auth.user?.id ?? null,
        source: 'route',
      });
      const indexState = row.snapshotId ? await readSnapshotFileIndexState(row.snapshotId) : null;
      return c.json({ ...toRecoverySummary(row), code, fileIndex: { status: indexState?.status ?? 'none' } }, 201);
    } catch (err) {
      if (err instanceof BareMetalRecoveryError) {
        if (err.code === 'snapshot_not_found') return c.json({ error: 'Snapshot not found' }, 404);
        return recoveryErrorResponse(c, err);
      }
      throw err;
    }
  }
);

// ── Session-authed: cancel / reissue-code (W05a) ────────────────────

async function loadAuthorizedRecovery(
  c: Parameters<typeof authorizeRouteResilienceResources>[0],
  orgId: string,
  id: string,
  operation: 'revoke' | 'token',
): Promise<{ ok: true; row: BareMetalRecoveryRow } | { ok: false; response: Response }> {
  const [row] = await db
    .select()
    .from(bareMetalRecoveries)
    .where(and(eq(bareMetalRecoveries.id, id), eq(bareMetalRecoveries.orgId, orgId)))
    .limit(1);
  if (!row) {
    return { ok: false, response: c.json({ error: 'Recovery not found' }, 404) };
  }
  // Site lineage runs through the device being recovered, exactly as the
  // by-ID token routes authorize through their token's device.
  const authorization = await authorizeRouteResilienceResources(
    c,
    orgId,
    [{ kind: 'device', id: row.deviceId, role: 'target' }],
    operation,
  );
  if (!authorization.ok) return { ok: false, response: authorization.response };
  return { ok: true, row };
}

bmrRecoveryRoutes.post(
  '/bmr/recoveries/:id/cancel',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', bmrRecoveryCancelSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }
    const { id } = c.req.valid('param');
    const { reason } = c.req.valid('json');

    const loaded = await loadAuthorizedRecovery(c, orgId, id, 'revoke');
    if (!loaded.ok) return loaded.response;

    try {
      const row = await cancelBareMetalRecovery({
        recoveryId: id,
        orgId,
        userId: auth.user?.id ?? null,
        ...(reason ? { reason } : {}),
      });
      return c.json(toRecoverySummary(row));
    } catch (err) {
      if (err instanceof BareMetalRecoveryError) return recoveryErrorResponse(c, err);
      throw err;
    }
  }
);

bmrRecoveryRoutes.post(
  '/bmr/recoveries/:id/reissue-code',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }
    const { id } = c.req.valid('param');

    const loaded = await loadAuthorizedRecovery(c, orgId, id, 'token');
    if (!loaded.ok) return loaded.response;

    // Codes are never stored in plaintext anywhere; each reveal rotates the
    // hash, so a reveal loop is bounded per recovery.
    const limited = await enforceTokenRateLimit(c, 'reissue', id, 5, 3600);
    if (limited) return limited;

    try {
      const { row, code } = await reissueRecoveryCode({ recoveryId: id, orgId, userId: auth.user?.id ?? null });
      return c.json({ ...toRecoverySummary(row), code });
    } catch (err) {
      if (err instanceof BareMetalRecoveryError) return recoveryErrorResponse(c, err);
      throw err;
    }
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
  recovery: { id: string; identity: 'original' | 'new'; deviceId: string; snapshotId: string | null; nonce: string },
  negotiated?: {
    grantedCapabilities: string[];
    fileIndex: { status: 'complete'; manifestSha256: string; externalCount: number; originSnapshotIds: string[] } | null;
  },
  // W09 (#6464) Task 5: the exchange handler already resolved this once for
  // capability negotiation — pass it through so this function doesn't issue
  // a SECOND resolveSnapshotProviderConfig call for the same snapshot.
  preResolvedSnapshot?: Awaited<ReturnType<typeof resolveSnapshotProviderConfig>>
) {
  const resolvedSnapshot = preResolvedSnapshot !== undefined ? preResolvedSnapshot : await resolveSnapshotProviderConfig(tokenRow.snapshotId);
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
    grantedCapabilities: negotiated?.grantedCapabilities,
    fileIndex: negotiated?.fileIndex,
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

    // Bare-metal recovery W04a review fix: this route has no ambient DB
    // access context (it is mounted before authMiddleware and there is no
    // org to scope to until the code hash resolves one), so — exactly like
    // authenticate/complete in bmr.ts — this initial lookup must run inside
    // withSystemDbAccessContext. Without it `breeze.scope` is unset, RLS's
    // breeze_has_org_access(org_id) denies every row, and every real code
    // silently 404s as if it were invalid.
    const [rec] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(bareMetalRecoveries)
        .where(eq(bareMetalRecoveries.codeHash, codeHash))
        .limit(1)
    );

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

    const { capabilities: clientCapabilities } = c.req.valid('json');

    return runInRecoveryOrgContext(rec.orgId, async () => {
      // W09 (#6464) Task 5: capability negotiation runs BEFORE the code is
      // claimed (the db.transaction() below) — an incompatible or
      // not-yet-ready client is refused here, before codeUsedAt is written
      // and before any recoveryTokens row is minted.
      const indexState = rec.snapshotId ? await readSnapshotFileIndexState(rec.snapshotId) : null;
      const resolvedSnapshot = rec.snapshotId ? await resolveSnapshotProviderConfig(rec.snapshotId) : null;
      const resolvedIdentity = resolvedSnapshot?.providerType
        ? normalizeStorageIdentity(
            resolvedSnapshot.providerType,
            asRecord(resolvedSnapshot.config?.providerConfig ?? resolvedSnapshot.providerConfig)
          )
        : null;
      const negotiation = negotiateRecoveryCapabilities({
        clientCapabilities,
        previouslyNegotiated: null, // exchange always mints a FRESH token — nothing to downgrade from
        referencedFiles: indexState?.referencedFiles ?? null,
        storageIdentity: resolvedSnapshot?.snapshot.storageIdentity ?? null,
        resolvedProviderIdentity: resolvedIdentity,
        fileIndex: {
          status: indexState?.status ?? 'none',
          manifestSha256: indexState?.manifestSha256 ?? null,
          externalCount: indexState?.externalCount ?? null,
          originSnapshotIds: indexState?.originSnapshotIds ?? [],
          error: indexState?.error ?? null,
          retryable: indexState?.retryable ?? false,
        },
      });
      if (negotiation.enqueueHydration && rec.snapshotId) {
        await enqueueSnapshotFileIndexHydration(rec.snapshotId, 'exchange');
      }
      if (!negotiation.ok) {
        writeAuditEvent(c, {
          orgId: rec.orgId,
          action: 'bmr.recovery.exchange',
          resourceType: 'bare_metal_recovery',
          resourceId: rec.id,
          result: 'failure',
          details: { reason: negotiation.error },
        });
        return c.json(
          {
            error: negotiation.error,
            message: negotiation.message,
            ...(negotiation.retryAfterSeconds !== undefined ? { retryAfterSeconds: negotiation.retryAfterSeconds } : {}),
            ...(negotiation.details ? { details: negotiation.details } : {}),
          },
          409
        );
      }

      const plainToken = generateRecoveryToken();
      const tokenHash = hashRecoveryToken(plainToken);
      const nonce = generateRecoveryNonce();

      // Bare-metal recovery W04a review fix: the plain SELECT above is a
      // read from BEFORE this transaction opened — two concurrent requests
      // for the same code both pass it. The one-time guarantee comes from
      // this conditional UPDATE instead: it only claims the row while it is
      // still exactly {status:'created', codeUsedAt:null, unexpired}, and
      // Postgres serializes concurrent UPDATEs to the same row, so at most
      // one request's WHERE clause can still match. The token is minted
      // FIRST, in the same transaction, so a lost claim (0 rows) can throw
      // to roll the whole transaction back — no orphan recoveryTokens row
      // survives a race loser.
      let tokenRow: typeof recoveryTokens.$inferSelect | undefined;
      let claimed = true;
      try {
        await db.transaction(async (tx) => {
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
              ...(negotiation.granted.length > 0 ? { negotiatedCapabilities: negotiation.granted } : {}),
            })
            .returning();
          if (!t) {
            throw new Error('Failed to mint recovery token during exchange');
          }
          tokenRow = t;

          const [claimedRow] = await tx
            .update(bareMetalRecoveries)
            .set({
              codeUsedAt: now,
              nonceHash: hashRecoveryNonce(nonce),
              recoveryTokenId: t.id,
              status: 'media_booted',
              mediaBootedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(bareMetalRecoveries.id, rec.id),
              isNull(bareMetalRecoveries.codeUsedAt),
              eq(bareMetalRecoveries.status, 'created'),
              gt(bareMetalRecoveries.codeExpiresAt, now),
            ))
            .returning();

          if (!claimedRow) {
            claimed = false;
            throw new CodeAlreadyClaimedError();
          }
        });
      } catch (err) {
        if (err instanceof CodeAlreadyClaimedError || !claimed) {
          writeAuditEvent(c, {
            orgId: rec.orgId,
            action: 'bmr.recovery.exchange',
            resourceType: 'bare_metal_recovery',
            resourceId: rec.id,
            result: 'failure',
            details: { reason: 'already_claimed' },
          });
          return c.json({ error: 'code_invalid' }, 404);
        }
        throw err;
      }

      const bootstrap = await buildRecoveryExchangeBootstrap(
        c,
        tokenRow!,
        {
          id: rec.id,
          identity: rec.identity as 'original' | 'new',
          deviceId: rec.deviceId,
          snapshotId: rec.snapshotId,
          nonce,
        },
        { grantedCapabilities: negotiation.granted, fileIndex: negotiation.fileIndex },
        resolvedSnapshot
      );
      if ('error' in bootstrap) {
        return c.json(bootstrap, 409);
      }

      writeAuditEvent(c, {
        orgId: rec.orgId,
        action: 'bmr.recovery.exchange',
        resourceType: 'bare_metal_recovery',
        resourceId: rec.id,
        result: 'success',
        details: { tokenId: tokenRow!.id, identity: rec.identity },
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

    // Bare-metal recovery W04a review fix: same reasoning as the exchange
    // route above — no ambient DB access context exists yet (the org is not
    // known until this token hash resolves one), so this lookup must run in
    // system scope or RLS denies every row.
    const [t] = await withSystemDbAccessContext(() =>
      db
        .select({ id: recoveryTokens.id, orgId: recoveryTokens.orgId, status: recoveryTokens.status, expiresAt: recoveryTokens.expiresAt })
        .from(recoveryTokens)
        .where(eq(recoveryTokens.tokenHash, tokenHash))
        .limit(1)
    );
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
