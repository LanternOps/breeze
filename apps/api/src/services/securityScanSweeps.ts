/**
 * IOC sweeps (#6263 W05-4, W05-6): preview, create, cancel and read.
 *
 * A request becomes one `security_scan_sweeps` row per org it reaches (rows
 * share `groupId`) plus one `queued` `security_scans` row per target device.
 * No BullMQ job is created per scan: the database is the queue, and the
 * single-flight `pump-sweeps` job admits queued sweep scans into the claim
 * path as capacity allows (jobs/securityScanSweepPump.ts).
 *
 * `createSweep` and the cancels open their OWN caller-scoped transaction
 * (`withAuthDbAccessContext`) and must be called with no ambient DB context:
 * the per-user create limiter is a Redis round-trip that must not pin a pooled
 * connection idle-in-transaction (#1105), the per-org advisory locks must be
 * released before the pump job is enqueued, and audit rows are written only
 * after the commit. Their HTTP routes are self-managed-context routes
 * (middleware/selfManagedDbContextRoutes.ts). Preview and the reads run in the
 * caller's ambient context.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import type {
  AiOriginRef,
  SecuritySweepCreateRequest,
  SecuritySweepOrigin,
  SecuritySweepRequest,
  SecuritySweepScanType,
  SecuritySweepState,
  SweepProgress,
  SweepSummary,
  YaraRuleSetPin,
} from '@breeze/shared';
import { db } from '../db';
import {
  deviceCommands,
  devices,
  organizations,
  securityScans,
  securityScanSweeps,
  users,
  yaraRuleSets,
} from '../db/schema';
import { isInteractiveUserSession, withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { enqueueSweepPump } from '../jobs/securityScanJobs';
import { canonicalizeArguments, computeArgumentDigest } from './actionIntents/canonicalize';
import { createAuditLogAsync, type CreateAuditLogParams, type InitiatedByType } from './auditService';
import { cancelDeviceCommands } from './commandCancelPropagation';
import { hasPermission, type UserPermissions } from './permissions';
import { rateLimiter } from './rate-limit';
import { getRedis } from './redis';
import { sweepMaxActivePerOrg, sweepMfaDeviceThreshold, sweepTtlHoursDefault } from './securityScanSweepConfig';
import {
  createOrgPermissionResolver,
  emptySkipCounts,
  resolveSweepTargets,
  type SweepSkipCounts,
  type SweepTargetErrorCode,
  type SweepTargetsFailure,
  type SweepTargetsResolved,
} from './securityScanSweepTargets';
import { normalizeSiteAllowlist } from './siteAllowlist';

const SWEEP_CREATE_LIMIT_PER_HOUR = 10;
const SCAN_INSERT_CHUNK = 1000;
/** Origins a human drives directly; AI and MCP sweeps are governed by intent approval instead. */
const HUMAN_ORIGINS: ReadonlySet<SecuritySweepOrigin> = new Set(['web', 'api']);

export interface SweepPreview {
  targeted: number;
  byOrg: Array<{ orgId: string; orgName: string; targeted: number }>;
  skipped: SweepSkipCounts;
  ruleSets: Array<{ id: string; name: string; version: number }>;
  previewDigest: string;
}

export interface SweepCreateContext {
  origin: SecuritySweepOrigin;
  aiOrigin?: AiOriginRef;
  intentId?: string | null;
  /** `hasSatisfiedMfa(auth)` as the route computes it. */
  mfaSatisfied: boolean;
  onlyOrgId?: string;
  /** From a prior preview (the AI path); more targets than this is a scope change. */
  expectedDeviceCount?: number;
  requestMeta?: { ipAddress?: string; userAgent?: string };
}

export type SweepCreateErrorCode =
  | 'SWEEP_SCOPE_CHANGED'
  | 'SWEEP_ALREADY_RUNNING'
  | 'TOO_MANY_ACTIVE_SWEEPS'
  | 'MFA_REQUIRED'
  | 'RATE_LIMITED'
  | SweepTargetErrorCode;

export type SweepFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 429;
  code: SweepCreateErrorCode;
  detail?: Record<string, unknown>;
};

export type CreateSweepResult = { ok: true; groupId: string; sweeps: SweepSummary[] } | SweepFailure;

export type CancelSweepResult =
  | { ok: true; sweeps: SweepSummary[]; cancelledQueued: number; cancelledUndelivered: number }
  | { ok: false; status: 403 | 404 };

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Dedupe key of a sweep in one org (W05-4): the org, the pinned set bytes
 * (`id@sha256`), the scan type and the paths. The canonicalizer keeps array
 * order, so the arrays are sorted here. A republished set has a new sha and so
 * a new key: a re-sweep with the current rules is never "already running".
 */
export function sweepDedupeKey(input: {
  orgId: string;
  pins: readonly YaraRuleSetPin[];
  scanType: string;
  paths?: readonly string[];
}): string {
  return computeArgumentDigest(
    canonicalizeArguments({
      orgId: input.orgId,
      pins: input.pins.map((p) => `${p.id}@${p.sha256}`).sort(),
      scanType: input.scanType,
      paths: [...(input.paths ?? [])].sort(),
    }),
  );
}

function toPreview(targets: SweepTargetsResolved): SweepPreview {
  return {
    targeted: targets.targeted,
    byOrg: [...targets.byOrg.entries()]
      .map(([orgId, list]) => ({ orgId, orgName: targets.orgNames.get(orgId) ?? '', targeted: list.length }))
      .sort((a, b) => a.orgName.localeCompare(b.orgName) || a.orgId.localeCompare(b.orgId)),
    skipped: targets.skipped,
    ruleSets: targets.pins.map((p) => ({ id: p.id, name: targets.ruleSetNames.get(p.id) ?? '', version: p.version })),
    previewDigest: targets.previewDigest,
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewSweep(
  auth: AuthContext,
  request: SecuritySweepRequest,
  opts: { onlyOrgId?: string } = {},
): Promise<{ ok: true; preview: SweepPreview } | SweepTargetsFailure> {
  const targets = await resolveSweepTargets(auth, {
    ruleSetIds: request.ruleSetIds,
    scope: request.scope,
    scanType: request.scanType,
    paths: request.paths,
    onlyOrgId: opts.onlyOrgId,
  });
  if (!targets.ok) return targets;
  return { ok: true, preview: toPreview(targets) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function auditActor(auth: AuthContext): Pick<CreateAuditLogParams, 'actorType' | 'actorId' | 'actorEmail'> {
  if (auth.principal?.kind === 'api_key' && auth.principal.apiKeyId) {
    return { actorType: 'api_key', actorId: auth.principal.apiKeyId, actorEmail: auth.user.email };
  }
  return { actorType: 'user', actorId: auth.user.id, actorEmail: auth.user.email };
}

function initiatedByFor(origin: SecuritySweepOrigin): InitiatedByType {
  if (origin === 'ai_chat') return 'ai';
  if (origin === 'web') return 'manual';
  return 'integration';
}

type CreateOutcome =
  | { ok: true; groupId: string; sweeps: SweepSummary[]; audits: CreateAuditLogParams[] }
  | SweepFailure;

export async function createSweep(
  auth: AuthContext,
  request: SecuritySweepCreateRequest,
  ctx: SweepCreateContext,
): Promise<CreateSweepResult> {
  // Before any DB context: a Redis round-trip inside a held transaction pins a
  // pooled connection (#1105). Shared by every surface (UI, API, AI, MCP).
  const limit = await rateLimiter(getRedis(), `security-sweep-create:${auth.user.id}`, SWEEP_CREATE_LIMIT_PER_HOUR, 3600);
  if (!limit.allowed) {
    return { ok: false, status: 429, code: 'RATE_LIMITED', detail: { retryAt: limit.resetAt.toISOString() } };
  }

  const outcome = await withAuthDbAccessContext(auth, () => createInTransaction(auth, request, ctx));
  if (!outcome.ok) return outcome;

  // Committed. Audit rows and the pump nudge only ever describe real rows.
  for (const audit of outcome.audits) void createAuditLogAsync(audit);
  try {
    await enqueueSweepPump();
  } catch (error) {
    // The repeatable pump tick admits the rows anyway; the nudge only saves latency.
    console.warn('[securityScanSweeps] pump enqueue failed; the next pump tick admits the sweep', {
      groupId: outcome.groupId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { ok: true, groupId: outcome.groupId, sweeps: outcome.sweeps };
}

async function createInTransaction(
  auth: AuthContext,
  request: SecuritySweepCreateRequest,
  ctx: SweepCreateContext,
): Promise<CreateOutcome> {
  const targets = await resolveSweepTargets(auth, {
    ruleSetIds: request.ruleSetIds,
    scope: request.scope,
    scanType: request.scanType,
    paths: request.paths,
    onlyOrgId: ctx.onlyOrgId,
  });
  if (!targets.ok) return targets;

  // The confirmation must be for exactly this scope: devices enrolled, moved
  // or newly ineligible, or a set republished since the preview, all change
  // the digest.
  const scopeChanged =
    targets.previewDigest !== request.previewDigest ||
    (ctx.expectedDeviceCount !== undefined && targets.targeted > ctx.expectedDeviceCount);
  if (scopeChanged) {
    return { ok: false, status: 409, code: 'SWEEP_SCOPE_CHANGED', detail: { preview: toPreview(targets) } };
  }

  // A human sweep above the threshold needs a person in an MFA-satisfied
  // session. `hasSatisfiedMfa` is true for every context when ENABLE_2FA is
  // off, so the principal-kind check is what refuses API keys in both states.
  const threshold = sweepMfaDeviceThreshold();
  if (
    HUMAN_ORIGINS.has(ctx.origin) &&
    targets.targeted > threshold &&
    !(isInteractiveUserSession(auth) && ctx.mfaSatisfied)
  ) {
    return { ok: false, status: 403, code: 'MFA_REQUIRED', detail: { targeted: targets.targeted, threshold } };
  }

  const orgIds = [...targets.byOrg.keys()].sort();
  // Serialize creates per org, in a fixed order so two multi-org creates can
  // never deadlock. Held until this transaction ends.
  for (const orgId of orgIds) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`security-sweep-org:${orgId}`}))`);
  }

  const maxActive = sweepMaxActivePerOrg();
  const active = await db
    .select({ orgId: securityScanSweeps.orgId, count: sql<number>`count(*)::int` })
    .from(securityScanSweeps)
    .where(
      and(
        inArray(securityScanSweeps.orgId, orgIds),
        eq(securityScanSweeps.state, 'active'),
        gt(securityScanSweeps.expiresAt, sql`now()`),
      ),
    )
    .groupBy(securityScanSweeps.orgId);
  const full = active.filter((row) => Number(row.count) >= maxActive).map((row) => row.orgId).sort();
  if (full.length > 0) {
    return { ok: false, status: 409, code: 'TOO_MANY_ACTIVE_SWEEPS', detail: { orgIds: full, max: maxActive } };
  }

  const keys = new Map(
    orgIds.map((orgId) => [
      orgId,
      sweepDedupeKey({ orgId, pins: targets.pins, scanType: request.scanType, paths: targets.paths }),
    ]),
  );
  const busyRows = await db
    .select({
      deviceId: securityScans.deviceId,
      sweepId: securityScanSweeps.id,
      groupId: securityScanSweeps.groupId,
    })
    .from(securityScans)
    .innerJoin(
      securityScanSweeps,
      and(eq(securityScanSweeps.id, securityScans.sweepId), eq(securityScanSweeps.orgId, securityScans.orgId)),
    )
    .where(
      and(
        or(...orgIds.map((orgId) => and(eq(securityScanSweeps.orgId, orgId), eq(securityScanSweeps.dedupeKey, keys.get(orgId)!)))),
        eq(securityScanSweeps.state, 'active'),
        gt(securityScanSweeps.expiresAt, sql`now()`),
        inArray(securityScans.status, ['queued', 'running']),
      ),
    );
  const busyDevices = new Set(busyRows.map((row) => row.deviceId));

  const plan = orgIds.map((orgId) => {
    const all = targets.byOrg.get(orgId)!;
    const remaining = all.filter((id) => !busyDevices.has(id));
    const skipped: SweepSkipCounts = {
      ...(targets.skippedByOrg.get(orgId) ?? emptySkipCounts()),
      busy_same_sweep: all.length - remaining.length,
    };
    return { orgId, remaining, skipped };
  });
  if (plan.every((p) => p.remaining.length === 0)) {
    return {
      ok: false,
      status: 409,
      code: 'SWEEP_ALREADY_RUNNING',
      detail: {
        sweepIds: [...new Set(busyRows.map((r) => r.sweepId))].sort(),
        groupIds: [...new Set(busyRows.map((r) => r.groupId))].sort(),
      },
    };
  }

  const groupId = randomUUID();
  const now = new Date();
  const ttlHours = request.ttlHours ?? sweepTtlHoursDefault();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000);
  const toCreate = plan.filter((p) => p.remaining.length > 0);

  const inserted = await db
    .insert(securityScanSweeps)
    .values(
      toCreate.map((p) => ({
        orgId: p.orgId,
        groupId,
        dedupeKey: keys.get(p.orgId)!,
        ruleSetIds: targets.pins.map((pin) => pin.id),
        ruleSetPins: targets.pins,
        scanType: request.scanType,
        paths: targets.paths ?? null,
        scope: request.scope,
        state: 'active',
        targetedCount: p.remaining.length,
        skipped: p.skipped,
        origin: ctx.origin,
        aiOrigin: ctx.aiOrigin ?? null,
        intentId: ctx.intentId ?? null,
        createdBy: auth.user.id,
        expiresAt,
      })),
    )
    .returning({ id: securityScanSweeps.id, orgId: securityScanSweeps.orgId, createdAt: securityScanSweeps.createdAt });
  const sweepIdByOrg = new Map(inserted.map((row) => [row.orgId, row]));

  for (const p of toCreate) {
    const sweepId = sweepIdByOrg.get(p.orgId)!.id;
    for (let i = 0; i < p.remaining.length; i += SCAN_INSERT_CHUNK) {
      await db.insert(securityScans).values(
        p.remaining.slice(i, i + SCAN_INSERT_CHUNK).map((deviceId) => ({
          orgId: p.orgId,
          deviceId,
          scanType: request.scanType,
          status: 'queued',
          // Reset to the claim time when the pump dispatches it (W05-3).
          startedAt: now,
          initiatedBy: auth.user.id,
          sweepId,
        })),
      );
    }
  }

  const ruleSets = targets.pins.map((pin) => ({ id: pin.id, name: targets.ruleSetNames.get(pin.id) ?? null, version: pin.version }));
  const sweeps: SweepSummary[] = toCreate.map((p) => {
    const row = sweepIdByOrg.get(p.orgId)!;
    return {
      id: row.id,
      groupId,
      orgId: p.orgId,
      orgName: targets.orgNames.get(p.orgId) ?? null,
      ruleSets,
      scanType: request.scanType,
      state: 'active',
      targeted: p.remaining.length,
      skipped: p.skipped,
      progress: { ...emptyProgress(), queued: p.remaining.length },
      origin: ctx.origin,
      createdBy: { id: auth.user.id, name: auth.user.name ?? null },
      createdAt: (row.createdAt ?? now).toISOString(),
      expiresAt: expiresAt.toISOString(),
      completedAt: null,
    };
  });

  const actor = auditActor(auth);
  const audits: CreateAuditLogParams[] = sweeps.map((sweep) => ({
    orgId: sweep.orgId,
    ...actor,
    action: 'security.scan_sweep.create',
    resourceType: 'security_scan_sweep',
    resourceId: sweep.id,
    // Never paths, device ids or IOC values: counts and pins only.
    details: {
      groupId,
      pins: targets.pins,
      scanType: request.scanType,
      pathsCount: targets.paths?.length ?? 0,
      scopeKind: request.scope.kind,
      targeted: sweep.targeted,
      skipped: sweep.skipped,
      origin: ctx.origin,
      intentId: ctx.intentId ?? null,
      ttlHours,
    },
    ipAddress: ctx.requestMeta?.ipAddress,
    userAgent: ctx.requestMeta?.userAgent,
    result: 'success',
    initiatedBy: initiatedByFor(ctx.origin),
  }));

  return { ok: true, groupId, sweeps, audits };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/** A caller narrowed below "the whole org" may act only on sweeps it created. */
function isRestrictedIn(auth: AuthContext, perms: UserPermissions): boolean {
  return (
    normalizeSiteAllowlist(perms.allowedSiteIds) !== undefined ||
    normalizeSiteAllowlist(auth.allowedSiteIds) !== undefined ||
    auth.allowedDeviceIds !== undefined
  );
}

export function cancelSweep(
  auth: AuthContext,
  sweepId: string,
  opts: { requestMeta?: SweepCreateContext['requestMeta'] } = {},
): Promise<CancelSweepResult> {
  return cancelMatching(auth, eq(securityScanSweeps.id, sweepId), opts);
}

export function cancelSweepGroup(
  auth: AuthContext,
  groupId: string,
  opts: { requestMeta?: SweepCreateContext['requestMeta'] } = {},
): Promise<CancelSweepResult> {
  return cancelMatching(auth, eq(securityScanSweeps.groupId, groupId), opts);
}

async function cancelMatching(
  auth: AuthContext,
  match: SQL,
  opts: { requestMeta?: SweepCreateContext['requestMeta'] },
): Promise<CancelSweepResult> {
  const permsFor = createOrgPermissionResolver(auth);
  const outcome = await withAuthDbAccessContext(auth, async () => {
    const fence = auth.orgCondition(securityScanSweeps.orgId);
    // FOR UPDATE: serializes against the claim (FOR SHARE) and the pump's expiry.
    const rows = await db
      .select({
        id: securityScanSweeps.id,
        orgId: securityScanSweeps.orgId,
        groupId: securityScanSweeps.groupId,
        state: securityScanSweeps.state,
        createdBy: securityScanSweeps.createdBy,
      })
      .from(securityScanSweeps)
      .where(fence ? and(match, fence) : match)
      .orderBy(asc(securityScanSweeps.id))
      .for('update');
    if (rows.length === 0) return { ok: false as const, status: 404 as const };

    for (const row of rows) {
      const perms = await permsFor(row.orgId);
      if (!perms || !hasPermission(perms, 'devices', 'execute')) return { ok: false as const, status: 403 as const };
      if (isRestrictedIn(auth, perms) && row.createdBy !== auth.user.id) return { ok: false as const, status: 403 as const };
    }

    const now = new Date();
    let cancelledQueued = 0;
    let cancelledUndelivered = 0;
    const audits: CreateAuditLogParams[] = [];
    for (const row of rows) {
      if (row.state !== 'active') continue; // idempotent: already terminal
      await db
        .update(securityScanSweeps)
        .set({ state: 'cancelled', cancelledAt: now, cancelledBy: auth.user.id })
        .where(and(eq(securityScanSweeps.id, row.id), eq(securityScanSweeps.state, 'active')));

      const queued = await db
        .update(securityScans)
        .set({ status: 'cancelled', completedAt: now })
        .where(and(eq(securityScans.sweepId, row.id), eq(securityScans.orgId, row.orgId), eq(securityScans.status, 'queued')))
        .returning({ id: securityScans.id });

      // Claimed but undelivered: the command is still `pending`. A delivered
      // scan finishes (the agent has no cancel wire for a running scan).
      const pending = await db
        .select({ scanId: securityScans.id, commandId: deviceCommands.id })
        .from(securityScans)
        .innerJoin(deviceCommands, eq(deviceCommands.id, securityScans.commandId))
        .where(
          and(
            eq(securityScans.sweepId, row.id),
            eq(securityScans.orgId, row.orgId),
            eq(securityScans.status, 'running'),
            eq(deviceCommands.status, 'pending'),
          ),
        );
      let undelivered = 0;
      if (pending.length > 0) {
        const cancelled = await cancelDeviceCommands({
          where: and(inArray(deviceCommands.id, pending.map((p) => p.commandId)), eq(deviceCommands.status, 'pending'))!,
          result: { status: 'cancelled', reason: 'security_sweep_cancelled', cancelledBy: auth.user.id },
          completedAt: now,
        });
        undelivered = cancelled.length;
        if (cancelled.length > 0) {
          await db
            .update(securityScans)
            .set({ status: 'cancelled', completedAt: now })
            .where(and(inArray(securityScans.commandId, cancelled.map((c) => c.id)), eq(securityScans.status, 'running')));
        }
      }
      cancelledQueued += queued.length;
      cancelledUndelivered += undelivered;
      audits.push({
        orgId: row.orgId,
        ...auditActor(auth),
        action: 'security.scan_sweep.cancel',
        resourceType: 'security_scan_sweep',
        resourceId: row.id,
        details: { groupId: row.groupId, cancelledQueued: queued.length, cancelledUndelivered: undelivered },
        ipAddress: opts.requestMeta?.ipAddress,
        userAgent: opts.requestMeta?.userAgent,
        result: 'success',
        initiatedBy: auth.principal?.kind === 'api_key' ? 'integration' : 'manual',
      });
    }
    return { ok: true as const, ids: rows.map((r) => r.id), cancelledQueued, cancelledUndelivered, audits };
  });
  if (!outcome.ok) return outcome;

  for (const audit of outcome.audits) void createAuditLogAsync(audit);
  const sweeps = await withAuthDbAccessContext(auth, () =>
    loadSummaries(auth, inArray(securityScanSweeps.id, outcome.ids), { permsFor }),
  );
  return {
    ok: true,
    sweeps,
    cancelledQueued: outcome.cancelledQueued,
    cancelledUndelivered: outcome.cancelledUndelivered,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const emptyProgress = (): SweepProgress => ({
  queued: 0,
  running: 0,
  completed: 0,
  timedOut: 0,
  failed: 0,
  cancelled: 0,
  expired: 0,
  degraded: 0,
  threatsFound: 0,
});

const countStatus = (status: string) =>
  sql<number>`count(*) FILTER (WHERE ${securityScans.status} = ${status})::int`;

const progressFields = {
  sweepId: securityScans.sweepId,
  queued: countStatus('queued'),
  running: countStatus('running'),
  completed: countStatus('completed'),
  timedOut: countStatus('timed_out'),
  failed: countStatus('failed'),
  cancelled: countStatus('cancelled'),
  expired: countStatus('expired'),
  // A child that finished but not as a full YARA scan: the agent fell back to
  // the legacy matcher, or reported rule-set fetch/compile errors.
  degraded: sql<number>`count(*) FILTER (WHERE ${securityScans.status} IN ('completed', 'timed_out') AND (coalesce(${securityScans.engine}, 'legacy') <> 'yara' OR (CASE WHEN jsonb_typeof(${securityScans.ruleSetErrors}) = 'array' THEN jsonb_array_length(${securityScans.ruleSetErrors}) ELSE 0 END) > 0))::int`,
  threatsFound: sql<number>`coalesce(sum(${securityScans.threatsFound}), 0)::int`,
  total: sql<number>`count(*)::int`,
};

const summaryFields = {
  id: securityScanSweeps.id,
  orgId: securityScanSweeps.orgId,
  groupId: securityScanSweeps.groupId,
  state: securityScanSweeps.state,
  createdBy: securityScanSweeps.createdBy,
  ruleSetPins: securityScanSweeps.ruleSetPins,
  scanType: securityScanSweeps.scanType,
  targetedCount: securityScanSweeps.targetedCount,
  skipped: securityScanSweeps.skipped,
  origin: securityScanSweeps.origin,
  createdAt: securityScanSweeps.createdAt,
  expiresAt: securityScanSweeps.expiresAt,
  completedAt: securityScanSweeps.completedAt,
  orgName: organizations.name,
  createdByName: users.name,
};

type SummaryRow = {
  id: string;
  orgId: string;
  groupId: string;
  state: string;
  createdBy: string | null;
  ruleSetPins: unknown;
  scanType: string;
  targetedCount: number;
  skipped: unknown;
  origin: string;
  createdAt: Date;
  expiresAt: Date;
  completedAt: Date | null;
  orgName: string | null;
  createdByName: string | null;
};

function parsePins(raw: unknown): YaraRuleSetPin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((p) =>
    p && typeof p === 'object' && typeof (p as YaraRuleSetPin).id === 'string'
      ? [{ id: (p as YaraRuleSetPin).id, version: Number((p as YaraRuleSetPin).version), sha256: String((p as YaraRuleSetPin).sha256) }]
      : [],
  );
}

function parseSkipped(raw: unknown): SweepSummary['skipped'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: SweepSummary['skipped'] = {};
  for (const key of Object.keys(emptySkipCounts()) as Array<keyof SweepSkipCounts>) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/**
 * Summaries for the sweeps `match` selects, under the caller's RLS, filtered
 * to orgs where the caller holds devices:read, with progress aggregated over
 * the devices the caller can reach (W05-1: a site- or device-restricted
 * caller sees its slice, and its `targeted` is that slice's size).
 */
async function loadSummaries(
  auth: AuthContext,
  match: SQL | undefined,
  opts: { permsFor?: ReturnType<typeof createOrgPermissionResolver>; page?: { limit: number; offset: number } } = {},
): Promise<SweepSummary[]> {
  const permsFor = opts.permsFor ?? createOrgPermissionResolver(auth);
  const fence = auth.orgCondition(securityScanSweeps.orgId);
  const where = and(...[match, fence].filter((c): c is SQL => c !== undefined));
  const base = db
    .select(summaryFields)
    .from(securityScanSweeps)
    .innerJoin(organizations, eq(organizations.id, securityScanSweeps.orgId))
    .leftJoin(users, eq(users.id, securityScanSweeps.createdBy))
    .where(where)
    .orderBy(desc(securityScanSweeps.createdAt), asc(securityScanSweeps.id));
  const rows = (opts.page ? await base.limit(opts.page.limit).offset(opts.page.offset) : await base) as SummaryRow[];

  const readable: Array<{ row: SummaryRow; perms: UserPermissions }> = [];
  for (const row of rows) {
    const perms = await permsFor(row.orgId);
    if (perms && hasPermission(perms, 'devices', 'read')) readable.push({ row, perms });
  }
  if (readable.length === 0) return [];

  // Ceiling: per org, the caller's site allowlist; globally, its device pins.
  const orgClauses: SQL[] = [];
  const restrictedOrgs = new Set<string>();
  const seenOrgs = new Set<string>();
  for (const { row, perms } of readable) {
    if (seenOrgs.has(row.orgId)) continue;
    seenOrgs.add(row.orgId);
    const parts: SQL[] = [eq(securityScans.orgId, row.orgId)];
    for (const allow of [normalizeSiteAllowlist(perms.allowedSiteIds), normalizeSiteAllowlist(auth.allowedSiteIds)]) {
      if (allow === undefined) continue;
      parts.push(allow.length > 0 ? inArray(devices.siteId, allow) : sql`false`);
    }
    if (isRestrictedIn(auth, perms)) restrictedOrgs.add(row.orgId);
    orgClauses.push(and(...parts)!);
  }
  const ceiling: SQL[] = [or(...orgClauses)!];
  if (auth.allowedDeviceIds !== undefined) {
    ceiling.push(auth.allowedDeviceIds.length > 0 ? inArray(securityScans.deviceId, [...auth.allowedDeviceIds]) : sql`false`);
  }

  const sweepIds = readable.map(({ row }) => row.id);
  const progressRows = await db
    .select(progressFields)
    .from(securityScans)
    .innerJoin(
      securityScanSweeps,
      and(eq(securityScanSweeps.id, securityScans.sweepId), eq(securityScanSweeps.orgId, securityScans.orgId)),
    )
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .where(and(inArray(securityScans.sweepId, sweepIds), ...ceiling))
    .groupBy(securityScans.sweepId);
  const progressBySweep = new Map(progressRows.map((p) => [p.sweepId, p]));

  const pinIds = [...new Set(readable.flatMap(({ row }) => parsePins(row.ruleSetPins).map((p) => p.id)))];
  const names = pinIds.length
    ? await db.select({ id: yaraRuleSets.id, name: yaraRuleSets.name }).from(yaraRuleSets).where(inArray(yaraRuleSets.id, pinIds))
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.name]));

  return readable.map(({ row }) => {
    const p = progressBySweep.get(row.id);
    const progress: SweepProgress = p
      ? {
          queued: Number(p.queued),
          running: Number(p.running),
          completed: Number(p.completed),
          timedOut: Number(p.timedOut),
          failed: Number(p.failed),
          cancelled: Number(p.cancelled),
          expired: Number(p.expired),
          degraded: Number(p.degraded),
          threatsFound: Number(p.threatsFound),
        }
      : emptyProgress();
    return {
      id: row.id,
      groupId: row.groupId,
      orgId: row.orgId,
      orgName: row.orgName ?? null,
      ruleSets: parsePins(row.ruleSetPins).map((pin) => ({ id: pin.id, name: nameById.get(pin.id) ?? null, version: pin.version })),
      scanType: row.scanType as SecuritySweepScanType,
      state: row.state as SecuritySweepState,
      targeted: restrictedOrgs.has(row.orgId) ? Number(p?.total ?? 0) : row.targetedCount,
      skipped: parseSkipped(row.skipped),
      progress,
      origin: row.origin as SecuritySweepOrigin,
      createdBy: row.createdBy ? { id: row.createdBy, name: row.createdByName ?? null } : null,
      createdAt: iso(row.createdAt)!,
      expiresAt: iso(row.expiresAt)!,
      completedAt: iso(row.completedAt),
    };
  });
}

export async function listSweeps(
  auth: AuthContext,
  query: { state?: SecuritySweepState; orgId?: string; page: number; limit: number },
): Promise<{ data: SweepSummary[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, Math.floor(query.page));
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit)));
  const conditions: SQL[] = [];
  if (query.state) conditions.push(eq(securityScanSweeps.state, query.state));
  if (query.orgId) conditions.push(eq(securityScanSweeps.orgId, query.orgId));
  const fence = auth.orgCondition(securityScanSweeps.orgId);
  if (fence) conditions.push(fence);
  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(securityScanSweeps)
    .where(conditions.length ? and(...conditions) : undefined);
  const data = await loadSummaries(auth, conditions.length ? and(...conditions) : undefined, {
    page: { limit, offset: (page - 1) * limit },
  });
  return { data, total: Number(countRow?.count ?? 0), page, limit };
}

export async function getSweep(auth: AuthContext, sweepId: string): Promise<SweepSummary | null> {
  const [summary] = await loadSummaries(auth, eq(securityScanSweeps.id, sweepId));
  return summary ?? null;
}

export async function getSweepGroup(
  auth: AuthContext,
  groupId: string,
): Promise<{ groupId: string; sweeps: SweepSummary[]; targeted: number; progress: SweepProgress } | null> {
  const sweeps = await loadSummaries(auth, eq(securityScanSweeps.groupId, groupId));
  if (sweeps.length === 0) return null;
  const progress = emptyProgress();
  for (const sweep of sweeps) {
    for (const key of Object.keys(progress) as Array<keyof SweepProgress>) progress[key] += sweep.progress[key];
  }
  return { groupId, sweeps, targeted: sweeps.reduce((n, s) => n + s.targeted, 0), progress };
}
