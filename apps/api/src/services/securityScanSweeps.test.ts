import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
import {
  createRecordingDb,
  hasChain,
  render,
  tableOf,
  whereParams,
  whereText,
  type RecordedOp,
} from '../testUtils/recordingDb';

/**
 * Sweep service (#6263 W05-4, W05-6). The DB is a recording fake: every query
 * is answered by `respond` and asserted on its rendered SQL. Target resolution
 * is mocked (it has its own suite); this suite pins what the service does with
 * a resolved target set.
 */

const h = vi.hoisted(() => ({
  inContext: false,
  respond: (_op: unknown): unknown => [],
  resolveSweepTargets: vi.fn(),
  permsFor: vi.fn(),
  enqueueSweepPump: vi.fn(),
  rateLimiter: vi.fn(),
  createAuditLogAsync: vi.fn(),
  cancelDeviceCommands: vi.fn(),
  events: [] as string[],
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb: create } = await import('../testUtils/recordingDb');
  h.recording = create((op) => {
    h.events.push(`db:${op.kind}`);
    return h.respond(op);
  });
  return {
    db: h.recording.db,
    getCurrentDbAccessContext: () => (h.inContext ? { scope: 'partner' } : undefined),
  };
});
vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: async (_auth: unknown, fn: () => Promise<unknown>) => {
    h.inContext = true;
    h.events.push('context:open');
    try {
      return await fn();
    } finally {
      h.inContext = false;
      h.events.push('context:close');
    }
  },
  isInteractiveUserSession: (auth: { principal: { kind: string } }) => auth.principal.kind === 'user_session',
}));
vi.mock('./securityScanSweepTargets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./securityScanSweepTargets')>();
  return {
    ...actual,
    resolveSweepTargets: (...a: unknown[]) => h.resolveSweepTargets(...a),
    createOrgPermissionResolver: () => (orgId: string) => h.permsFor(orgId),
  };
});
vi.mock('../jobs/securityScanJobs', () => ({
  enqueueSweepPump: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'pump:in-context' : 'pump');
    return h.enqueueSweepPump(...a);
  },
}));
vi.mock('./rate-limit', () => ({
  rateLimiter: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'ratelimit:in-context' : 'ratelimit');
    return h.rateLimiter(...a);
  },
}));
vi.mock('./redis', () => ({ getRedis: () => ({ fake: 'redis' }) }));
vi.mock('./auditService', () => ({
  createAuditLogAsync: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'audit:in-context' : 'audit');
    return h.createAuditLogAsync(...a);
  },
}));
vi.mock('./commandCancelPropagation', () => ({ cancelDeviceCommands: (...a: unknown[]) => h.cancelDeviceCommands(...a) }));

import type { AuthContext } from '../middleware/auth';
import {
  cancelSweep,
  cancelSweepGroup,
  createSweep,
  getSweep,
  listSweeps,
  previewSweep,
  sweepDedupeKey,
} from './securityScanSweeps';

const PARTNER = 'p0000000-0000-4000-8000-000000000001';
const ORG_A = 'a0000000-0000-4000-8000-000000000001';
const ORG_B = 'b0000000-0000-4000-8000-000000000001';
const SITE_A1 = 'a1000000-0000-4000-8000-000000000001';
const USER = 'u0000000-0000-4000-8000-000000000001';
const OTHER_USER = 'u0000000-0000-4000-8000-000000000002';
const API_KEY = 'k0000000-0000-4000-8000-000000000001';
const SET = '5e000000-0000-4000-8000-000000000001';
const PIN = { id: SET, version: 4, sha256: 'c'.repeat(64) };
const DIGEST = 'f'.repeat(64);
const SWEEP_ID = '5a000000-0000-4000-8000-0000000000aa';
const GROUP_ID = '6a000000-0000-4000-8000-0000000000aa';

const devId = (n: number) => `d${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
const ids = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => devId(i + 1 + offset));

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: USER, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_A, ORG_B],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...over,
  } as AuthContext;
}
const apiKeyAuth = () => auth({ principal: { kind: 'api_key', apiKeyId: API_KEY } });

const zeroSkips = () => ({ agent_too_old: 0, busy_same_sweep: 0, rule_set_not_eligible: 0 });
function resolved(byOrg: Record<string, string[]>, over: Record<string, unknown> = {}) {
  const map = new Map(Object.entries(byOrg));
  return {
    ok: true,
    byOrg: map,
    orgNames: new Map([[ORG_A, 'Org A'], [ORG_B, 'Org B']]),
    targeted: [...map.values()].reduce((n, l) => n + l.length, 0),
    skipped: { ...zeroSkips(), agent_too_old: 1 },
    skippedByOrg: new Map([[ORG_A, { ...zeroSkips(), agent_too_old: 1 }]]),
    pins: [PIN],
    ruleSetNames: new Map([[SET, 'Hunt pack']]),
    paths: undefined,
    previewDigest: DIGEST,
    ...over,
  };
}

const request = { ruleSetIds: [SET], scope: { kind: 'all' as const }, scanType: 'quick' as const };
const create = { ...request, previewDigest: DIGEST };
const webCtx = { origin: 'web' as const, mfaSatisfied: true };

const executeOps = () => h.recording!.ops.filter((o) => o.kind === 'execute');
const inserts = (table: string) => h.recording!.ops.filter((o) => o.kind === 'insert' && tableOf(o) === table);
const insertValues = (op: RecordedOp) => op.chain.find(([m]) => m === 'values')![1][0] as Array<Record<string, unknown>>;
const writeOps = () => h.recording!.ops.filter((o) => o.kind === 'insert' || o.kind === 'update' || o.kind === 'delete');

type CreateWorld = { active?: Array<{ orgId: string; count: number }>; busy?: Array<Record<string, unknown>> };
function respondForCreate(world: CreateWorld = {}) {
  let n = 0;
  h.respond = (op) => {
    const table = tableOf(op as RecordedOp);
    const o = op as RecordedOp;
    if (o.kind === 'select' && table === 'security_scan_sweeps') return world.active ?? [];
    if (o.kind === 'select' && table === 'security_scans') return world.busy ?? [];
    if (o.kind === 'insert' && table === 'security_scan_sweeps') {
      return insertValues(o).map((row) => ({ ...row, id: `5a000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, createdAt: new Date('2026-10-25T10:00:00Z') }));
    }
    return [];
  };
}

beforeEach(() => {
  h.inContext = false;
  h.events.length = 0;
  h.recording!.ops.length = 0;
  h.respond = () => [];
  h.resolveSweepTargets.mockReset();
  h.permsFor.mockReset();
  h.permsFor.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'execute' }, { resource: 'devices', action: 'read' }], scope: 'partner' });
  h.enqueueSweepPump.mockReset();
  h.enqueueSweepPump.mockResolvedValue(undefined);
  h.rateLimiter.mockReset();
  h.rateLimiter.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date() });
  h.createAuditLogAsync.mockReset();
  h.createAuditLogAsync.mockResolvedValue(undefined);
  h.cancelDeviceCommands.mockReset();
  h.cancelDeviceCommands.mockResolvedValue([]);
});

describe('previewSweep', () => {
  it('preview writes nothing', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(2), [ORG_B]: ids(1, 10) }));
    const result = await previewSweep(auth(), request);
    expect(result).toEqual({
      ok: true,
      preview: {
        targeted: 3,
        byOrg: [
          { orgId: ORG_A, orgName: 'Org A', targeted: 2 },
          { orgId: ORG_B, orgName: 'Org B', targeted: 1 },
        ],
        skipped: { ...zeroSkips(), agent_too_old: 1 },
        ruleSets: [{ id: SET, name: 'Hunt pack', version: 4 }],
        previewDigest: DIGEST,
      },
    });
    expect(writeOps()).toEqual([]);
    expect(h.enqueueSweepPump).not.toHaveBeenCalled();
  });

  it('passes resolver failures through', async () => {
    h.resolveSweepTargets.mockResolvedValue({ ok: false, status: 404, code: 'RULE_SET_NOT_FOUND', detail: { ruleSetIds: [SET] } });
    expect(await previewSweep(auth(), request)).toEqual({ ok: false, status: 404, code: 'RULE_SET_NOT_FOUND', detail: { ruleSetIds: [SET] } });
  });
});

describe('createSweep', () => {
  it('create: one sweep per org sharing groupId; one queued scan per device with sweep_id and initiated_by; 2500 devices → 3 chunked inserts', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(2500), [ORG_B]: ids(3, 5000) }));
    respondForCreate();
    const result = await createSweep(auth(), create, webCtx);
    if (!result.ok) throw new Error(result.code);

    const [sweepInsert] = inserts('security_scan_sweeps');
    const rows = insertValues(sweepInsert!);
    expect(rows.map((r) => r.orgId)).toEqual([ORG_A, ORG_B]);
    expect(new Set(rows.map((r) => r.groupId)).size).toBe(1);
    expect(result.groupId).toBe(rows[0]!.groupId);
    expect(rows[0]).toMatchObject({ targetedCount: 2500, origin: 'web', createdBy: USER, state: 'active', scanType: 'quick', paths: null });
    expect(rows[0]!.skipped).toEqual({ ...zeroSkips(), agent_too_old: 1 });
    expect(rows[1]!.skipped).toEqual(zeroSkips());

    const scanInserts = inserts('security_scans');
    expect(scanInserts.map((op) => insertValues(op).length)).toEqual([1000, 1000, 500, 3]);
    const first = insertValues(scanInserts[0]!)[0]!;
    expect(first).toMatchObject({ orgId: ORG_A, deviceId: devId(1), status: 'queued', scanType: 'quick', initiatedBy: USER, sweepId: result.sweeps[0]!.id });
    expect(first.startedAt).toBeInstanceOf(Date);
    expect(insertValues(scanInserts[3]!)[0]).toMatchObject({ orgId: ORG_B, sweepId: result.sweeps[1]!.id });

    expect(result.sweeps.map((s) => [s.orgId, s.targeted, s.progress.queued])).toEqual([[ORG_A, 2500, 2500], [ORG_B, 3, 3]]);
  });

  it('rule_set_pins and dedupe_key persisted; per-org advisory locks in sorted order', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_B]: ids(1), [ORG_A]: ids(1, 10) }));
    respondForCreate();
    const result = await createSweep(auth(), create, webCtx);
    expect(result.ok).toBe(true);
    const rows = insertValues(inserts('security_scan_sweeps')[0]!);
    const rowA = rows.find((r) => r.orgId === ORG_A)!;
    expect(rowA.ruleSetPins).toEqual([PIN]);
    expect(rowA.ruleSetIds).toEqual([SET]);
    expect(rowA.dedupeKey).toBe(
      computeArgumentDigest(canonicalizeArguments({ orgId: ORG_A, pins: [`${SET}@${PIN.sha256}`], scanType: 'quick', paths: [] })),
    );
    const locks = executeOps().map((op) => whereParams(op));
    expect(locks).toEqual([['security-sweep-org:' + ORG_A], ['security-sweep-org:' + ORG_B]]);
    expect(whereText(executeOps()[0]!)).toContain('pg_advisory_xact_lock(hashtext(');
  });

  it('one pump job enqueued after commit; the limiter runs before any DB context', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(1) }));
    respondForCreate();
    await createSweep(auth(), create, webCtx);
    expect(h.enqueueSweepPump).toHaveBeenCalledTimes(1);
    expect(h.events[0]).toBe('ratelimit');
    expect(h.events.indexOf('ratelimit')).toBeLessThan(h.events.indexOf('context:open'));
    expect(h.events).toContain('pump');
    expect(h.events).not.toContain('pump:in-context');
    expect(h.events.indexOf('pump')).toBeGreaterThan(h.events.indexOf('context:close'));
    expect(h.rateLimiter).toHaveBeenCalledWith({ fake: 'redis' }, `security-sweep-create:${USER}`, 10, 3600);
  });

  it('a pump enqueue failure does not fail a committed create', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(1) }));
    respondForCreate();
    h.enqueueSweepPump.mockRejectedValue(new Error('redis down'));
    const result = await createSweep(auth(), create, webCtx);
    expect(result.ok).toBe(true);
  });

  it('previewDigest mismatch → SWEEP_SCOPE_CHANGED with fresh preview, nothing written', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(2) }, { previewDigest: 'e'.repeat(64) }));
    respondForCreate();
    const result = await createSweep(auth(), create, webCtx);
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      code: 'SWEEP_SCOPE_CHANGED',
      detail: { preview: { targeted: 2, previewDigest: 'e'.repeat(64) } },
    });
    expect(writeOps()).toEqual([]);
    expect(executeOps()).toEqual([]);
    expect(h.enqueueSweepPump).not.toHaveBeenCalled();
    expect(h.createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('expectedDeviceCount given and exceeded → SWEEP_SCOPE_CHANGED', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(26) }));
    respondForCreate();
    const result = await createSweep(auth(), create, { origin: 'ai_chat', mfaSatisfied: false, expectedDeviceCount: 25 });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'SWEEP_SCOPE_CHANGED' });
    expect(writeOps()).toEqual([]);
  });

  it('> 50 without satisfied MFA (user session) → MFA_REQUIRED', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(51) }));
    respondForCreate();
    expect(await createSweep(auth(), create, { origin: 'web', mfaSatisfied: false })).toMatchObject({
      ok: false, status: 403, code: 'MFA_REQUIRED',
    });
    expect(writeOps()).toEqual([]);
    // 50 is at the threshold, not above it.
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(50) }));
    expect((await createSweep(auth(), create, { origin: 'web', mfaSatisfied: false })).ok).toBe(true);
  });

  it('api key > 50 → MFA_REQUIRED with ENABLE_2FA on AND off', async () => {
    // mfaSatisfied is what the route computes with hasSatisfiedMfa(auth); with
    // ENABLE_2FA off it is true for every context, so a machine principal must
    // be refused on its principal kind alone.
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(51) }));
    respondForCreate();
    for (const mfaSatisfied of [true, false]) {
      expect(await createSweep(apiKeyAuth(), create, { origin: 'api', mfaSatisfied })).toMatchObject({
        ok: false, status: 403, code: 'MFA_REQUIRED',
      });
    }
    expect(writeOps()).toEqual([]);
  });

  it('ai_chat/mcp origin skips the MFA rule', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(51) }));
    respondForCreate();
    for (const origin of ['ai_chat', 'mcp'] as const) {
      expect((await createSweep(apiKeyAuth(), create, { origin, mfaSatisfied: false })).ok).toBe(true);
    }
  });

  it('same key all busy → SWEEP_ALREADY_RUNNING with ids, nothing written', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(2) }));
    respondForCreate({
      busy: [
        { deviceId: devId(1), sweepId: SWEEP_ID, groupId: GROUP_ID },
        { deviceId: devId(2), sweepId: SWEEP_ID, groupId: GROUP_ID },
      ],
    });
    const result = await createSweep(auth(), create, webCtx);
    expect(result).toEqual({
      ok: false, status: 409, code: 'SWEEP_ALREADY_RUNNING', detail: { sweepIds: [SWEEP_ID], groupIds: [GROUP_ID] },
    });
    expect(writeOps()).toEqual([]);
    expect(h.enqueueSweepPump).not.toHaveBeenCalled();
    // The busy probe is the active, unexpired, same-key sweep of the same org,
    // with a queued/running child.
    const busyQuery = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scans')!;
    const text = whereText(busyQuery);
    expect(text).toContain(`"security_scan_sweeps"."state" = $`);
    expect(text).toContain(`"security_scan_sweeps"."expires_at" > now()`);
    expect(text).toContain(`"security_scans"."status" in ($`);
    expect(whereParams(busyQuery)).toContain(sweepDedupeKey({ orgId: ORG_A, pins: [PIN], scanType: 'quick' }));
  });

  it('half busy → created for the rest, skipped.busy_same_sweep', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(2) }));
    respondForCreate({ busy: [{ deviceId: devId(1), sweepId: SWEEP_ID, groupId: GROUP_ID }] });
    const result = await createSweep(auth(), create, webCtx);
    if (!result.ok) throw new Error(result.code);
    const [row] = insertValues(inserts('security_scan_sweeps')[0]!);
    expect(row).toMatchObject({ targetedCount: 1, skipped: { ...zeroSkips(), agent_too_old: 1, busy_same_sweep: 1 } });
    expect(insertValues(inserts('security_scans')[0]!).map((r) => r.deviceId)).toEqual([devId(2)]);
  });

  it('expired-but-still-active sweep does not count as busy; republished set (new sha) → not busy', () => {
    // The busy probe filters on expires_at > now() (asserted above). A new sha
    // is a new key, so the probe for the republished set never matches the old sweep.
    const before = sweepDedupeKey({ orgId: ORG_A, pins: [PIN], scanType: 'quick' });
    const after = sweepDedupeKey({ orgId: ORG_A, pins: [{ ...PIN, version: 5, sha256: 'd'.repeat(64) }], scanType: 'quick' });
    expect(after).not.toBe(before);
    // Version alone (same bytes) does not change the key; order of pins and paths does not either.
    const pin2 = { id: '5e000000-0000-4000-8000-000000000002', version: 1, sha256: 'a'.repeat(64) };
    expect(sweepDedupeKey({ orgId: ORG_A, pins: [PIN, pin2], scanType: 'custom', paths: ['/b', '/a'] })).toBe(
      sweepDedupeKey({ orgId: ORG_A, pins: [pin2, PIN], scanType: 'custom', paths: ['/a', '/b'] }),
    );
    expect(sweepDedupeKey({ orgId: ORG_B, pins: [PIN], scanType: 'quick' })).not.toBe(before);
  });

  it('org at 5 active → TOO_MANY_ACTIVE_SWEEPS; completed sweeps do not count', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(1), [ORG_B]: ids(1, 10) }));
    respondForCreate({ active: [{ orgId: ORG_B, count: 5 }] });
    expect(await createSweep(auth(), create, webCtx)).toEqual({
      ok: false, status: 409, code: 'TOO_MANY_ACTIVE_SWEEPS', detail: { orgIds: [ORG_B], max: 5 },
    });
    expect(writeOps()).toEqual([]);
    const capQuery = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps')!;
    const text = whereText(capQuery);
    expect(text).toContain(`"security_scan_sweeps"."state" = $`);
    expect(whereParams(capQuery)).toContain('active');
    expect(text).toContain(`"security_scan_sweeps"."expires_at" > now()`);

    respondForCreate({ active: [{ orgId: ORG_B, count: 4 }] });
    expect((await createSweep(auth(), create, webCtx)).ok).toBe(true);
  });

  it('11th create in an hour → RATE_LIMITED; the limiter is called outside any DB context', async () => {
    h.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date('2026-10-25T11:00:00Z') });
    const result = await createSweep(auth(), create, webCtx);
    expect(result).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
    expect(h.events).toEqual(['ratelimit']);
    expect(h.resolveSweepTargets).not.toHaveBeenCalled();
  });

  it('one security.scan_sweep.create per org row; api-key actor attribution; no paths/device ids', async () => {
    h.resolveSweepTargets.mockResolvedValue(
      resolved({ [ORG_A]: ids(2), [ORG_B]: ids(1, 10) }, { paths: ['/secret/path'] }),
    );
    respondForCreate();
    const result = await createSweep(
      apiKeyAuth(),
      { ...create, scanType: 'custom', paths: ['/secret/path'], ttlHours: 6 },
      { origin: 'api', mfaSatisfied: true, requestMeta: { ipAddress: '198.51.100.7', userAgent: 'curl' } },
    );
    if (!result.ok) throw new Error(result.code);
    expect(h.createAuditLogAsync).toHaveBeenCalledTimes(2);
    expect(h.events.filter((e) => e.startsWith('audit'))).toEqual(['audit', 'audit']);
    const [first] = h.createAuditLogAsync.mock.calls[0]!;
    expect(first).toMatchObject({
      orgId: ORG_A,
      action: 'security.scan_sweep.create',
      resourceType: 'security_scan_sweep',
      resourceId: result.sweeps[0]!.id,
      actorType: 'api_key',
      actorId: API_KEY,
      actorEmail: 'tech@example.com',
      initiatedBy: 'integration',
      ipAddress: '198.51.100.7',
      userAgent: 'curl',
      result: 'success',
      details: {
        groupId: result.groupId,
        pins: [PIN],
        scanType: 'custom',
        pathsCount: 1,
        scopeKind: 'all',
        targeted: 2,
        skipped: { ...zeroSkips(), agent_too_old: 1 },
        origin: 'api',
        intentId: null,
        ttlHours: 6,
      },
    });
    const serialized = JSON.stringify(h.createAuditLogAsync.mock.calls);
    expect(serialized).not.toContain('/secret/path');
    expect(serialized).not.toContain(devId(1));
  });

  it('sweep rows for an AI origin carry ai_origin and intent_id; the scan rows carry the custom paths', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(1) }, { paths: ['/a', '/b'] }));
    respondForCreate();
    const aiOrigin = { kind: 'chat', sessionId: 's-1' };
    const result = await createSweep(
      auth(),
      { ...create, scanType: 'custom', paths: ['/b', '/a'] },
      { origin: 'ai_chat', mfaSatisfied: false, aiOrigin: aiOrigin as never, intentId: '1e000000-0000-4000-8000-000000000001' },
    );
    if (!result.ok) throw new Error(result.code);
    const [row] = insertValues(inserts('security_scan_sweeps')[0]!);
    expect(row).toMatchObject({ origin: 'ai_chat', aiOrigin, intentId: '1e000000-0000-4000-8000-000000000001', paths: ['/a', '/b'] });
    expect(h.createAuditLogAsync.mock.calls[0]![0]).toMatchObject({ actorType: 'user', actorId: USER, initiatedBy: 'ai' });
  });

  it('ttlHours sets expires_at; the default is 24 h', async () => {
    h.resolveSweepTargets.mockResolvedValue(resolved({ [ORG_A]: ids(1) }));
    respondForCreate();
    const t0 = Date.now();
    await createSweep(auth(), create, webCtx);
    await createSweep(auth(), { ...create, ttlHours: 2 }, webCtx);
    const [a, b] = inserts('security_scan_sweeps').map((op) => insertValues(op)[0]!.expiresAt as Date);
    expect(a!.getTime() - t0).toBeGreaterThanOrEqual(24 * 3600_000 - 5_000);
    expect(a!.getTime() - t0).toBeLessThanOrEqual(24 * 3600_000 + 5_000);
    expect(b!.getTime() - t0).toBeLessThanOrEqual(2 * 3600_000 + 5_000);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

function sweepRow(over: Record<string, unknown> = {}) {
  return {
    id: SWEEP_ID,
    orgId: ORG_A,
    groupId: GROUP_ID,
    state: 'active',
    createdBy: USER,
    ruleSetPins: [PIN],
    scanType: 'quick',
    targetedCount: 3,
    skipped: zeroSkips(),
    origin: 'web',
    createdAt: new Date('2026-10-25T10:00:00Z'),
    expiresAt: new Date('2026-10-26T10:00:00Z'),
    completedAt: null,
    orgName: 'Org A',
    createdByName: 'Tech',
    ...over,
  };
}

type CancelWorld = { sweeps?: Array<Record<string, unknown>>; queued?: Array<{ id: string }>; pending?: Array<{ scanId: string; commandId: string }> };
function respondForCancel(world: CancelWorld = {}) {
  h.respond = (op) => {
    const o = op as RecordedOp;
    const table = tableOf(o);
    if (o.kind === 'select' && table === 'security_scan_sweeps') return world.sweeps ?? [sweepRow()];
    if (o.kind === 'update' && table === 'security_scans' && hasChain(o, 'returning')) return world.queued ?? [];
    if (o.kind === 'select' && table === 'security_scans' && !hasChain(o, 'groupBy')) return world.pending ?? [];
    return [];
  };
}

describe('cancelSweep', () => {
  it('queued → cancelled; pending-command running → command cancelled + scan cancelled; delivered running untouched; FOR UPDATE on the sweep', async () => {
    respondForCancel({
      queued: [{ id: 'scan-q1' }, { id: 'scan-q2' }],
      pending: [{ scanId: 'scan-r1', commandId: 'cmd-1' }],
    });
    h.cancelDeviceCommands.mockResolvedValue([{ id: 'cmd-1', type: 'security_scan', payload: null }]);
    const result = await cancelSweep(auth(), SWEEP_ID);
    expect(result).toMatchObject({ ok: true, cancelledQueued: 2, cancelledUndelivered: 1 });

    const lock = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps')!;
    expect(lock.chain.find(([m]) => m === 'for')![1][0]).toBe('update');

    const sweepUpdate = h.recording!.ops.find((o) => o.kind === 'update' && tableOf(o) === 'security_scan_sweeps')!;
    expect(sweepUpdate.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ state: 'cancelled', cancelledBy: USER });

    const queuedUpdate = h.recording!.ops.find((o) => o.kind === 'update' && tableOf(o) === 'security_scans' && hasChain(o, 'returning'))!;
    expect(queuedUpdate.chain.find(([m]) => m === 'set')![1][0]).toMatchObject({ status: 'cancelled' });
    expect(whereParams(queuedUpdate)).toEqual(expect.arrayContaining([SWEEP_ID, ORG_A, 'queued']));

    // The undelivered probe: running children whose command is still pending.
    const pendingProbe = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scans' && !hasChain(o, 'groupBy'))!;
    expect(whereText(pendingProbe)).toContain(`"device_commands"."status" = $`);
    expect(whereParams(pendingProbe)).toEqual(expect.arrayContaining([SWEEP_ID, ORG_A, 'running', 'pending']));

    expect(h.cancelDeviceCommands).toHaveBeenCalledTimes(1);
    const [cancelArgs] = h.cancelDeviceCommands.mock.calls[0]!;
    expect(render(cancelArgs.where).params).toEqual(expect.arrayContaining(['cmd-1', 'pending']));
    expect(cancelArgs.result).toMatchObject({ status: 'cancelled', reason: 'security_sweep_cancelled' });

    // The scans of the commands actually cancelled are terminalised in the same transaction.
    const runningCancel = h.recording!.ops.filter((o) => o.kind === 'update' && tableOf(o) === 'security_scans' && !hasChain(o, 'returning'));
    expect(runningCancel).toHaveLength(1);
    expect(whereParams(runningCancel[0]!)).toEqual(expect.arrayContaining(['cmd-1', 'running']));

    expect(h.createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(h.createAuditLogAsync.mock.calls[0]![0]).toMatchObject({
      action: 'security.scan_sweep.cancel',
      orgId: ORG_A,
      resourceId: SWEEP_ID,
      details: { groupId: GROUP_ID, cancelledQueued: 2, cancelledUndelivered: 1 },
    });
    expect(h.events.indexOf('audit')).toBeGreaterThan(h.events.indexOf('context:close'));
  });

  it('cancel twice → 200, one audit', async () => {
    respondForCancel({ sweeps: [sweepRow({ state: 'cancelled' })] });
    const result = await cancelSweep(auth(), SWEEP_ID);
    expect(result).toMatchObject({ ok: true, cancelledQueued: 0, cancelledUndelivered: 0 });
    expect(h.recording!.ops.filter((o) => o.kind === 'update')).toEqual([]);
    expect(h.createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('not visible → 404; no devices:execute in the sweep org → 403', async () => {
    respondForCancel({ sweeps: [] });
    expect(await cancelSweep(auth(), SWEEP_ID)).toEqual({ ok: false, status: 404 });
    respondForCancel();
    h.permsFor.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'read' }], scope: 'partner' });
    expect(await cancelSweep(auth(), SWEEP_ID)).toEqual({ ok: false, status: 403 });
    expect(h.recording!.ops.filter((o) => o.kind === 'update')).toEqual([]);
  });

  it('restricted user cancels only own', async () => {
    h.permsFor.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'execute' }],
      scope: 'organization',
      allowedSiteIds: [SITE_A1],
    });
    respondForCancel({ sweeps: [sweepRow({ createdBy: OTHER_USER })] });
    expect(await cancelSweep(auth(), SWEEP_ID)).toEqual({ ok: false, status: 403 });
    respondForCancel({ sweeps: [sweepRow({ createdBy: USER })] });
    expect((await cancelSweep(auth(), SWEEP_ID)).ok).toBe(true);
    // A device-pinned caller is restricted too.
    h.permsFor.mockResolvedValue({ permissions: [{ resource: 'devices', action: 'execute' }], scope: 'partner' });
    respondForCancel({ sweeps: [sweepRow({ createdBy: OTHER_USER })] });
    expect(await cancelSweep(auth({ allowedDeviceIds: [devId(1)] }), SWEEP_ID)).toEqual({ ok: false, status: 403 });
  });

  it('cancelSweepGroup cancels every visible row of the group', async () => {
    respondForCancel({
      sweeps: [sweepRow(), sweepRow({ id: '5a000000-0000-4000-8000-0000000000bb', orgId: ORG_B, orgName: 'Org B' })],
      queued: [{ id: 'q' }],
    });
    const result = await cancelSweepGroup(auth(), GROUP_ID);
    expect(result).toMatchObject({ ok: true, cancelledQueued: 2 });
    expect(h.createAuditLogAsync).toHaveBeenCalledTimes(2);
    respondForCancel({ sweeps: [] });
    expect(await cancelSweepGroup(auth(), GROUP_ID)).toEqual({ ok: false, status: 404 });
  });
});

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

function respondForReads(world: { sweeps: Array<Record<string, unknown>>; progress?: Array<Record<string, unknown>>; total?: number }) {
  h.respond = (op) => {
    const o = op as RecordedOp;
    const table = tableOf(o);
    if (o.kind === 'select' && table === 'security_scan_sweeps' && Object.keys((o.args[0] ?? {}) as object).includes('count')) {
      return [{ count: world.total ?? world.sweeps.length }];
    }
    if (o.kind === 'select' && table === 'security_scan_sweeps') return world.sweeps;
    if (o.kind === 'select' && table === 'security_scans') return world.progress ?? [];
    return [];
  };
}

describe('reads', () => {
  it('progress: degraded counts legacy engine / rule_set_errors among completed', async () => {
    respondForReads({
      sweeps: [sweepRow()],
      progress: [{ sweepId: SWEEP_ID, queued: 1, running: 2, completed: 5, timedOut: 1, failed: 1, cancelled: 0, expired: 1, degraded: 2, threatsFound: 7, total: 11 }],
    });
    const summary = await getSweep(auth(), SWEEP_ID);
    expect(summary).toMatchObject({
      id: SWEEP_ID,
      orgName: 'Org A',
      targeted: 3,
      ruleSets: [{ id: SET, name: null, version: 4 }],
      createdBy: { id: USER, name: 'Tech' },
      progress: { queued: 1, running: 2, completed: 5, timedOut: 1, failed: 1, cancelled: 0, expired: 1, degraded: 2, threatsFound: 7 },
    });
    const progressQuery = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scans')!;
    const fields = render(
      (progressQuery.args[0] as Record<string, unknown>).degraded as never,
    ).sql.toLowerCase();
    expect(fields).toContain(`in ('completed', 'timed_out')`);
    expect(fields).toContain(`coalesce("security_scans"."engine", 'legacy') <> 'yara'`);
    expect(fields).toContain('jsonb_array_length("security_scans"."rule_set_errors")');
    // Only an array is measured: jsonb_array_length raises on any other jsonb.
    expect(fields).toContain(`jsonb_typeof("security_scans"."rule_set_errors") = 'array'`);
    // Children are counted only where the sweep and the scan agree on the org.
    const joins = progressQuery.chain.filter(([m]) => m === 'innerJoin').map(([, a]) => render(a[1] as never).sql);
    expect(joins.some((on) => on.includes('"security_scan_sweeps"."org_id" = "security_scans"."org_id"'))).toBe(true);
  });

  it("restricted caller's aggregates cover only reachable devices", async () => {
    h.permsFor.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      scope: 'organization',
      allowedSiteIds: [SITE_A1],
    });
    respondForReads({
      sweeps: [sweepRow()],
      progress: [{ sweepId: SWEEP_ID, queued: 1, running: 0, completed: 0, timedOut: 0, failed: 0, cancelled: 0, expired: 0, degraded: 0, threatsFound: 0, total: 1 }],
    });
    const summary = await getSweep(auth({ allowedDeviceIds: [devId(1)] }), SWEEP_ID);
    // targeted is the reachable child count, not the stored org-wide count.
    expect(summary?.targeted).toBe(1);
    const progressQuery = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scans')!;
    const text = whereText(progressQuery);
    expect(text).toContain('"devices"."site_id" in (');
    expect(text).toContain('"security_scans"."device_id" in (');
    expect(whereParams(progressQuery)).toEqual(expect.arrayContaining([SITE_A1, devId(1)]));
  });

  it('a sweep in an org where the caller lacks devices:read is not returned', async () => {
    h.permsFor.mockResolvedValue({ permissions: [], scope: 'organization' });
    respondForReads({ sweeps: [sweepRow()] });
    expect(await getSweep(auth(), SWEEP_ID)).toBeNull();
  });

  it('listSweeps filters by state and org, newest first, paged', async () => {
    respondForReads({ sweeps: [sweepRow()], total: 41 });
    const result = await listSweeps(auth(), { state: 'active', orgId: ORG_A, page: 2, limit: 20 });
    expect(result).toMatchObject({ total: 41, page: 2, limit: 20 });
    expect(result.data).toHaveLength(1);
    const listQuery = h.recording!.ops.find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps' && hasChain(o, 'offset'))!;
    expect(whereParams(listQuery)).toEqual(expect.arrayContaining(['active', ORG_A]));
    expect(listQuery.chain.find(([m]) => m === 'offset')![1][0]).toBe(20);
    expect(listQuery.chain.find(([m]) => m === 'limit')![1][0]).toBe(20);
  });
});
