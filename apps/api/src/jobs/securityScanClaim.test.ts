import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_SCAN_SETTINGS_DEFAULTS } from '@breeze/shared';
import { hasChain, tableOf, whereParams, whereText, type RecordedOp } from '../testUtils/recordingDb';

/**
 * claimAndDispatchScan (#6263 W05-3): the locked claim every scan origin goes
 * through. The DB is a recording fake (testUtils/recordingDb.ts); the command
 * seam, the policy resolver and the ref resolvers are mocked.
 */

const h = vi.hoisted(() => ({
  inContext: false,
  events: [] as string[],
  world: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  deliver: vi.fn(),
  policy: vi.fn(),
  authority: vi.fn(),
  plan: vi.fn(),
  pinned: vi.fn(),
  aiPolicy: vi.fn(),
  audit: vi.fn(),
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb } = await import('../testUtils/recordingDb');
  h.recording = createRecordingDb((op) => {
    h.events.push(`db:${op.kind}`);
    return respond(op);
  });
  return {
    db: h.recording.db,
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      h.inContext = true;
      h.events.push('context:open');
      try {
        return await fn();
      } finally {
        h.inContext = false;
        h.events.push('context:close');
      }
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../services/dispatchDeviceCommand', () => ({
  dispatchDeviceCommand: (...a: unknown[]) => {
    h.events.push(h.inContext ? 'dispatch:in-context' : 'dispatch:outside');
    return h.dispatch(...a);
  },
}));
vi.mock('../services/featureConfigResolver', () => ({ resolveSecurityScanPolicyForDevice: (...a: unknown[]) => h.policy(...a) }));
vi.mock('../services/securityScanQuarantineAuthority', () => ({
  resolveSecurityScanQuarantineAuthority: (...a: unknown[]) => h.authority(...a),
}));
vi.mock('../services/yaraScanRefs', () => ({
  planYaraScan: (...a: unknown[]) => h.plan(...a),
  resolvePinnedYaraRefs: (...a: unknown[]) => h.pinned(...a),
}));
vi.mock('../services/aiRemoteToolsPolicy', () => ({ checkAiRemoteToolsPolicy: (...a: unknown[]) => h.aiPolicy(...a) }));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: (...a: unknown[]) => h.audit(...a) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { claimAndDispatchScan } from './securityScanClaim';

const SCAN = '11111111-1111-4111-8111-111111111111';
const SWEEP = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const OTHER_ORG = '55555555-5555-4555-8555-555555555555';
const PARTNER = '66666666-6666-4666-8666-666666666666';
const SET = '77777777-7777-4777-8777-777777777777';
const PIN = { id: SET, version: 3, sha256: 'a'.repeat(64) };
const REF = { ...PIN, url: `/api/v1/agents/agent-1/yara/rule-sets/${SET}/3` };

function scanRow(over: Record<string, unknown> = {}) {
  return {
    id: SCAN,
    orgId: ORG,
    deviceId: DEVICE,
    scanType: 'quick',
    status: 'queued',
    sweepId: null,
    deviceOrgId: ORG,
    deviceAgentVersion: '0.124.0',
    partnerId: PARTNER,
    ...over,
  };
}
function sweepRow(over: Record<string, unknown> = {}) {
  return {
    id: SWEEP,
    orgId: ORG,
    state: 'active',
    expiresAt: new Date(Date.now() + 6 * 3_600_000),
    ruleSetPins: [PIN],
    scanType: 'quick',
    paths: null,
    origin: 'web',
    aiOrigin: null,
    ...over,
  };
}
const counts = (over: Record<string, number> = {}) => ({
  org_running: 0, partner_running: 0, device_running: 0, device_pending: 0, ...over,
});

function respond(op: RecordedOp): unknown {
  const w = h.world;
  const table = tableOf(op);
  if (op.kind === 'execute') {
    const text = whereText(op);
    if (text.includes('pg_advisory_xact_lock')) return [];
    return [w.counts ?? counts()];
  }
  if (op.kind === 'select' && table === 'security_scans' && !hasChain(op, 'for')) return w.scan === undefined ? [scanRow()] : w.scan;
  if (op.kind === 'select' && table === 'security_scans' && hasChain(op, 'for')) {
    return w.locked ?? [{ status: 'queued', orgId: ORG, sweepId: (w.scanSweepId as string | null) ?? null, deviceOrgId: ORG }];
  }
  if (op.kind === 'select' && table === 'security_scan_sweeps') return w.sweep === undefined ? [sweepRow()] : w.sweep;
  if (op.kind === 'update' && table === 'security_scans' && hasChain(op, 'returning')) return w.claimed ?? [{ id: SCAN }];
  return [];
}

const ops = () => h.recording!.ops;
const scanUpdates = () => ops().filter((o) => o.kind === 'update' && tableOf(o) === 'security_scans');
const setOf = (op: RecordedOp) => op.chain.find(([m]) => m === 'set')![1][0] as Record<string, unknown>;

const policy = (settings: Partial<typeof SECURITY_SCAN_SETTINGS_DEFAULTS> = {}) => ({
  settings: {
    ...SECURITY_SCAN_SETTINGS_DEFAULTS,
    exclusions: ['C:\\Backups'],
    maxFileSizeMb: 64,
    scanTimeoutMinutes: 30,
    autoQuarantine: false,
    ...settings,
  },
  featureLinkId: 'link-1',
});

function sweepWorld(sweep: Record<string, unknown> = {}) {
  h.world = { scan: [scanRow({ sweepId: SWEEP })], scanSweepId: SWEEP, sweep: [sweepRow(sweep)] };
}

const manual = { type: 'dispatch-scan' as const, scanId: SCAN, origin: 'manual' as const };
const fromSweep = { type: 'dispatch-scan' as const, scanId: SCAN, origin: 'sweep' as const, sweepId: SWEEP };

beforeEach(() => {
  h.inContext = false;
  h.events.length = 0;
  h.recording!.ops.length = 0;
  h.world = {};
  h.deliver.mockReset().mockImplementation(async () => {
    h.events.push(h.inContext ? 'deliver:in-context' : 'deliver:outside');
    return { ok: true, delivery: 'delivered' };
  });
  h.dispatch.mockReset().mockResolvedValue({
    ok: true, command: { id: 'cmd-x', status: 'pending' }, delivery: 'queued_live', deliverBy: null, deliver: h.deliver,
  });
  h.policy.mockReset().mockResolvedValue(policy());
  h.authority.mockReset().mockResolvedValue({ allowed: true });
  h.plan.mockReset().mockResolvedValue({ ruleSets: [REF], engine: 'yara', ruleSetErrors: null });
  h.pinned.mockReset().mockResolvedValue({ ok: true, refs: [REF] });
  h.aiPolicy.mockReset().mockResolvedValue({ allowed: true });
  h.audit.mockReset();
});

describe('claimAndDispatchScan — the locked claim', () => {
  it('partner advisory lock taken before counts', async () => {
    await claimAndDispatchScan(manual);
    const executes = ops().filter((o) => o.kind === 'execute');
    expect(executes).toHaveLength(2);
    expect(whereText(executes[0]!)).toContain('pg_advisory_xact_lock(hashtext(');
    expect(whereParams(executes[0]!)).toEqual([`security-scan-partner:${PARTNER}`]);
    // The scan row is re-read FOR UPDATE under the lock, before the counts.
    const lockIdx = ops().indexOf(executes[0]!);
    const reread = ops().findIndex((o) => o.kind === 'select' && tableOf(o) === 'security_scans' && hasChain(o, 'for'));
    expect(reread).toBeGreaterThan(lockIdx);
    expect(ops().indexOf(executes[1]!)).toBeGreaterThan(reread);
    // All of it inside the claim's own transaction.
    expect(h.events[0]).toBe('context:open');
  });

  it.each([
    ['org cap', { org_running: 40 }],
    ['partner cap', { partner_running: 200 }],
    ['device cap', { device_running: 1 }],
    ['device queue busy', { device_pending: 1 }],
  ])('%s → throttled, nothing claimed, no command', async (reason, over) => {
    h.world = { counts: counts(over) };
    const result = await claimAndDispatchScan(manual);
    expect(result).toEqual({ outcome: 'throttled', commandId: null, throttleReason: expect.stringContaining(reason) });
    expect(scanUpdates()).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('one below every cap dispatches', async () => {
    h.world = { counts: counts({ org_running: 39, partner_running: 199 }) };
    expect((await claimAndDispatchScan(manual)).outcome).toBe('dispatched');
  });

  it('command inserted via dispatchDeviceCommand in the claim tx with deferDelivery and a reserved id stored in command_id; deliver() called after commit', async () => {
    const result = await claimAndDispatchScan(manual);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const [input] = h.dispatch.mock.calls[0]!;
    expect(input).toMatchObject({ deviceId: DEVICE, type: 'security_scan', deferDelivery: true, expectedOrgId: ORG });
    expect(input.commandId).toMatch(/^[0-9a-f-]{36}$/);
    const claim = scanUpdates().find((o) => hasChain(o, 'returning'))!;
    expect(setOf(claim).commandId).toBe(input.commandId);
    expect(result).toEqual({ outcome: 'dispatched', commandId: input.commandId });
    expect(h.events).toContain('dispatch:in-context');
    expect(h.events).toContain('deliver:outside');
    expect(h.events.indexOf('deliver:outside')).toBeGreaterThan(h.events.lastIndexOf('context:close'));
  });

  it('deliver() skipped when absent (offline device)', async () => {
    h.dispatch.mockResolvedValue({ ok: true, command: { id: 'cmd-x' }, delivery: 'queued_offline', deliverBy: null });
    expect((await claimAndDispatchScan(manual)).outcome).toBe('dispatched');
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('a deliver() that throws never fails the committed claim', async () => {
    h.deliver.mockRejectedValue(new Error('socket gone'));
    expect((await claimAndDispatchScan(manual)).outcome).toBe('dispatched');
  });

  it('claim resets started_at to the claim time and CASes on queued', async () => {
    const before = Date.now();
    await claimAndDispatchScan(manual);
    const claim = scanUpdates().find((o) => hasChain(o, 'returning'))!;
    const set = setOf(claim);
    expect(set.status).toBe('running');
    expect((set.startedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(whereParams(claim)).toEqual(expect.arrayContaining([SCAN, 'queued']));
  });

  it('per-device command audit row written once on the claim path (by the seam, not the claim)', async () => {
    await claimAndDispatchScan(manual);
    // dispatchDeviceCommand -> queueCommand writes the AUDITED_COMMANDS row
    // for security_scan; the claim adds no second write.
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('dispatched_rule_sets stamped for sweep, scheduled and manual-queued scans', async () => {
    for (const data of [
      manual,
      { type: 'dispatch-scan' as const, scanId: SCAN, origin: 'policy_scheduler' as const, configPolicyId: SET, occurrenceIso: 'x' },
    ]) {
      h.recording!.ops.length = 0;
      await claimAndDispatchScan(data);
      expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).dispatchedRuleSets).toEqual([PIN]);
    }
    h.recording!.ops.length = 0;
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).dispatchedRuleSets).toEqual([PIN]);
    // A legacy scan sent no refs and records none.
    h.recording!.ops.length = 0;
    h.world = {};
    h.plan.mockResolvedValue({ ruleSets: [], engine: 'legacy', ruleSetErrors: null });
    await claimAndDispatchScan(manual);
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).dispatchedRuleSets).toBeNull();
  });

  it('does nothing when the scan row has vanished, or is no longer queued under the lock', async () => {
    h.world = { scan: [] };
    expect(await claimAndDispatchScan(manual)).toEqual({ outcome: 'skipped', commandId: null });
    h.world = { locked: [{ status: 'running', orgId: ORG, sweepId: null, deviceOrgId: ORG }] };
    expect(await claimAndDispatchScan(manual)).toEqual({ outcome: 'skipped', commandId: null });
    h.world = { claimed: [] };
    expect(await claimAndDispatchScan(manual)).toEqual({ outcome: 'skipped', commandId: null });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a non-sweep scan whose device moved org is failed, never dispatched', async () => {
    h.world = { locked: [{ status: 'queued', orgId: ORG, sweepId: null, deviceOrgId: OTHER_ORG }] };
    expect((await claimAndDispatchScan(manual)).outcome).toBe('failed');
    expect(setOf(scanUpdates()[0]!)).toMatchObject({ status: 'failed' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a refused dispatch fails the claimed scan', async () => {
    h.dispatch.mockResolvedValue({ ok: false, code: 'device_decommissioned', error: 'x' });
    expect((await claimAndDispatchScan(manual)).outcome).toBe('failed');
    expect(setOf(scanUpdates().at(-1)!)).toMatchObject({ status: 'failed' });
    expect(h.deliver).not.toHaveBeenCalled();
  });

  it('non-sweep: policy auto-quarantine without authority is dispatched detect-only and recorded', async () => {
    h.policy.mockResolvedValue(policy({ autoQuarantine: true }));
    h.authority.mockResolvedValue({ allowed: false, reason: 'authority_revoked' });
    await claimAndDispatchScan(manual);
    expect(h.dispatch.mock.calls[0]![0].payload).toMatchObject({ autoQuarantine: false, triggerDefender: true });
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).autoQuarantineSuppressedReason).toBe('authority_revoked');
  });
});

describe('claimAndDispatchScan — W01–W03 behaviour kept (ported from securityScanJobs.test.ts)', () => {
  const OTHER_SET = 'bbbbbbbb-0000-4000-8000-00000000000b';

  it("sends the policy's rule sets as W02 ruleSets refs and records engine yara + per-set errors", async () => {
    h.policy.mockResolvedValue(policy({ ruleSetIds: [SET, OTHER_SET] }));
    h.plan.mockResolvedValue({ ruleSets: [REF], engine: 'yara', ruleSetErrors: [{ id: OTHER_SET, code: 'disabled' }] });
    await claimAndDispatchScan(manual);
    expect(h.plan).toHaveBeenCalledWith({ deviceId: DEVICE, agentVersion: '0.124.0', ruleSetIds: [SET, OTHER_SET] });
    const payload = h.dispatch.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(payload.ruleSets).toEqual([REF]);
    expect(payload).not.toHaveProperty('ruleSetIds');
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!)).toMatchObject({
      status: 'running', engine: 'yara', ruleSetErrors: [{ id: OTHER_SET, code: 'disabled' }],
    });
  });

  it('an agent too old for YARA gets no ruleSets and the row records legacy + agent_too_old', async () => {
    const tooOld = [{ id: '*', code: 'agent_too_old', detail: 'agent 0.1.0 is older than 0.124.0' }];
    h.plan.mockResolvedValue({ ruleSets: [], engine: 'legacy', ruleSetErrors: tooOld });
    await claimAndDispatchScan(manual);
    expect(h.dispatch.mock.calls[0]![0].payload).not.toHaveProperty('ruleSets');
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!)).toMatchObject({ engine: 'legacy', ruleSetErrors: tooOld });
  });

  it("passes the device's agent version (null included) straight to the planner, which fails closed on it", async () => {
    h.world = { scan: [scanRow({ deviceAgentVersion: null })] };
    await claimAndDispatchScan(manual);
    expect(h.plan).toHaveBeenCalledWith(expect.objectContaining({ agentVersion: null }));
  });

  it('a device with no governing policy plans with no rule sets and sends no settings keys', async () => {
    h.policy.mockResolvedValue(null);
    h.plan.mockResolvedValue({ ruleSets: [], engine: 'legacy', ruleSetErrors: null });
    await claimAndDispatchScan(manual);
    expect(h.plan).toHaveBeenCalledWith(expect.objectContaining({ ruleSetIds: [] }));
    expect(h.dispatch.mock.calls[0]![0].payload).toEqual({ scanRecordId: SCAN, scanType: 'quick', triggerDefender: true });
  });

  it('keeps auto-quarantine when the stored authority resolves', async () => {
    h.policy.mockResolvedValue(policy({ autoQuarantine: true }));
    await claimAndDispatchScan(manual);
    expect(h.authority).toHaveBeenCalledWith('link-1', DEVICE);
    expect(h.dispatch.mock.calls[0]![0].payload).toMatchObject({ autoQuarantine: true });
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).autoQuarantineSuppressedReason).toBeNull();
  });

  it('does not consult the authority for a scan without auto-quarantine', async () => {
    await claimAndDispatchScan(manual);
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.dispatch.mock.calls[0]![0].payload).toMatchObject({ autoQuarantine: false });
  });

  it('queues a security_scan command carrying the resolved settings', async () => {
    h.world = { scan: [scanRow({ scanType: 'full' })] };
    await claimAndDispatchScan(manual);
    expect(h.dispatch.mock.calls[0]![0].payload).toMatchObject({
      scanRecordId: SCAN, scanType: 'full', exclusions: ['C:\\Backups'], maxFileSizeMb: 64, timeoutMinutes: 30, autoQuarantine: false,
    });
  });
});

describe('claimAndDispatchScan — sweep branch', () => {
  it('uses pins, not the policy', async () => {
    h.policy.mockResolvedValue(policy({ ruleSetIds: ['policy-set'] }));
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    expect(h.pinned).toHaveBeenCalledWith({ deviceId: DEVICE, agentVersion: '0.124.0', pins: [PIN] });
    expect(h.plan).not.toHaveBeenCalled();
    expect(h.dispatch.mock.calls[0]![0].payload.ruleSets).toEqual([REF]);
  });

  it('autoQuarantine false and triggerDefender false even if the policy enables them; exclusions/maxFileSizeMb/timeout from the policy', async () => {
    h.policy.mockResolvedValue(policy({ autoQuarantine: true }));
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    expect(h.authority).not.toHaveBeenCalled();
    expect(h.dispatch.mock.calls[0]![0].payload).toEqual({
      scanRecordId: SCAN,
      scanType: 'quick',
      triggerDefender: false,
      exclusions: ['C:\\Backups'],
      maxFileSizeMb: 64,
      timeoutMinutes: 30,
      autoQuarantine: false,
      ruleSets: [REF],
    });
    expect(setOf(scanUpdates().find((o) => hasChain(o, 'returning'))!).autoQuarantineSuppressedReason).toBeNull();
  });

  it('with no governing policy a sweep still sends autoQuarantine false explicitly', async () => {
    h.policy.mockResolvedValue(null);
    sweepWorld({ scanType: 'custom', paths: ['/srv'] });
    h.world.scan = [scanRow({ sweepId: SWEEP, scanType: 'custom' })];
    await claimAndDispatchScan(fromSweep);
    expect(h.dispatch.mock.calls[0]![0].payload).toEqual({
      scanRecordId: SCAN, scanType: 'custom', paths: ['/srv'], triggerDefender: false, autoQuarantine: false, ruleSets: [REF],
    });
  });

  it.each([
    ['cancelled', { state: 'cancelled' }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['org mismatch', { orgId: OTHER_ORG }],
  ])('sweep %s → cancelled, no command', async (_label, over) => {
    sweepWorld(over);
    expect(await claimAndDispatchScan(fromSweep)).toEqual({ outcome: 'cancelled', commandId: null });
    expect(setOf(scanUpdates()[0]!)).toMatchObject({ status: 'cancelled' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('device org mismatch → cancelled, no command', async () => {
    sweepWorld();
    h.world.locked = [{ status: 'queued', orgId: ORG, sweepId: SWEEP, deviceOrgId: OTHER_ORG }];
    expect((await claimAndDispatchScan(fromSweep)).outcome).toBe('cancelled');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a sweep row that vanished, or a detached scan (sweep_id NULL), is cancelled', async () => {
    sweepWorld();
    h.world.sweep = [];
    expect((await claimAndDispatchScan(fromSweep)).outcome).toBe('cancelled');
    h.world = { scan: [scanRow()], scanSweepId: null };
    expect((await claimAndDispatchScan(fromSweep)).outcome).toBe('cancelled');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('the sweep row is read FOR SHARE (cancel and expiry take FOR UPDATE)', async () => {
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    const read = ops().find((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps')!;
    expect(read.chain.find(([m]) => m === 'for')![1][0]).toBe('share');
  });

  it('locks the sweep row BEFORE the scan row — the order cancel and expiry use (no 40P01)', async () => {
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    const sweepLock = ops().findIndex((o) => o.kind === 'select' && tableOf(o) === 'security_scan_sweeps' && hasChain(o, 'for'));
    const scanLock = ops().findIndex((o) => o.kind === 'select' && tableOf(o) === 'security_scans' && hasChain(o, 'for'));
    const partnerLock = ops().findIndex((o) => o.kind === 'execute');
    expect(partnerLock).toBeGreaterThan(-1);
    expect(sweepLock).toBeGreaterThan(partnerLock);
    expect(scanLock).toBeGreaterThan(sweepLock);
  });

  it('a scan whose sweep pointer changed under the lock is cancelled', async () => {
    sweepWorld();
    h.world.locked = [{ status: 'queued', orgId: ORG, sweepId: null, deviceOrgId: ORG }];
    expect((await claimAndDispatchScan(fromSweep)).outcome).toBe('cancelled');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['pin sha changed', [{ id: SET, version: 3, code: 'rule_set_changed' }]],
    ['one pin disabled', [{ id: SET, version: 3, code: 'disabled' }]],
    ['agent too old', [{ id: '*', code: 'agent_too_old', detail: 'old' }]],
  ])('%s → failed with the codes, engine legacy, no command (no partial-set scan)', async (_label, errors) => {
    sweepWorld();
    h.pinned.mockResolvedValue({ ok: false, errors });
    expect(await claimAndDispatchScan(fromSweep)).toEqual({ outcome: 'failed', commandId: null });
    expect(setOf(scanUpdates()[0]!)).toMatchObject({ status: 'failed', engine: 'legacy', ruleSetErrors: errors });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('ai origin + remote-tools policy deny → failed ai_policy_denied', async () => {
    sweepWorld({ origin: 'ai_chat', aiOrigin: { kind: 'chat', sessionId: 's-1' } });
    h.aiPolicy.mockResolvedValue({ allowed: false, reason: 'disabled', error: 'x' });
    expect((await claimAndDispatchScan(fromSweep)).outcome).toBe('failed');
    expect(h.aiPolicy).toHaveBeenCalledWith(DEVICE, 'security_scan');
    expect(setOf(scanUpdates()[0]!)).toMatchObject({ status: 'failed', ruleSetErrors: [{ id: '*', code: 'ai_policy_denied' }] });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a human sweep never consults the AI policy', async () => {
    sweepWorld();
    await claimAndDispatchScan(fromSweep);
    expect(h.aiPolicy).not.toHaveBeenCalled();
  });

  it('aiOrigin passed to the command; expectedOrgId = sweep.orgId', async () => {
    const aiOrigin = { kind: 'mcp', ledgerSessionId: 'l-1' };
    sweepWorld({ origin: 'mcp', aiOrigin });
    await claimAndDispatchScan(fromSweep);
    expect(h.dispatch.mock.calls[0]![0]).toMatchObject({ aiOrigin, expectedOrgId: ORG });
  });

  it('deliverWithinMs = max(60 s, expires − now)', async () => {
    sweepWorld({ expiresAt: new Date(Date.now() + 2 * 3_600_000) });
    await claimAndDispatchScan(fromSweep);
    const { offlinePolicy } = h.dispatch.mock.calls[0]![0];
    expect(offlinePolicy.kind).toBe('queue');
    expect(offlinePolicy.deliverWithinMs).toBeGreaterThan(2 * 3_600_000 - 10_000);
    expect(offlinePolicy.deliverWithinMs).toBeLessThanOrEqual(2 * 3_600_000);

    h.recording!.ops.length = 0;
    h.dispatch.mockClear();
    sweepWorld({ expiresAt: new Date(Date.now() + 5_000) });
    await claimAndDispatchScan(fromSweep);
    expect(h.dispatch.mock.calls[0]![0].offlinePolicy).toEqual({ kind: 'queue', deliverWithinMs: 60_000 });
  });

  it('non-sweep scans keep the registry offline policy', async () => {
    await claimAndDispatchScan(manual);
    expect(h.dispatch.mock.calls[0]![0].offlinePolicy).toBeUndefined();
  });
});
