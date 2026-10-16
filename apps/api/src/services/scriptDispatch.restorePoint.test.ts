import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL, Param } from 'drizzle-orm';

// Devices parked in a holding org, by id. The helper's query is proven against
// Postgres in parkedCommandDelivery.integration.test.ts.
const parkedDeviceIds = vi.hoisted(() => new Set<string>());
vi.mock('./unassignedPool/deliveryEligibility', async () => ({
  ...(await vi.importActual<typeof import('./unassignedPool/deliveryEligibility')>(
    './unassignedPool/deliveryEligibility',
  )),
  isParkedDevice: vi.fn(async (_reader: unknown, deviceId: string) => parkedDeviceIds.has(deviceId)),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
// #5128: scriptDispatch.ts now imports `CommandTypes` from './commandQueue'
// (a re-export of the leaf module './commandTypes') to look up the script
// type's default offline policy. Pull the REAL table in via a nested import
// (rather than hand-rolling `{ SCRIPT: 'script' }`) so it cannot drift from
// the registry `commandOfflinePolicy.ts` builds against.
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue({ status: 'not_claimable', id: 'cmd-1' }),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
// #3409 PR4c-2: the secret-delivery gates are unit-tested against their own
// drizzle mocks in scriptSecretDelivery.test.ts. Here they are mocked so this
// file tests the WIRING — that dispatch calls them at the right two points,
// only for a secret-bearing script, and honours their verdicts.
vi.mock('./scriptSecretDelivery', () => ({
  // The real constant's text is asserted in scriptSecretDelivery.test.ts; the
  // dispatch refusal only has to carry it through verbatim, so a stand-in
  // string is enough here and keeps this file free of the real module.
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
// #4919 — dispatch now owns the maintenance-window gate. Mocked permissive
// here so this file's subject stays the dispatch mechanics; the gate itself
// is covered by scriptMaintenanceGate.test.ts and its wiring by
// scriptDispatch.maintenanceWindow.test.ts.
vi.mock('./scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: vi.fn().mockResolvedValue({ suppressed: false }),
}));


vi.mock('./restorePointRequest', () => ({
  buildRestorePointRequest: vi.fn(),
  discardRestorePointRequest: vi.fn(),
  restorePointPayloadField: (block: unknown) => (block ? { restorePoint: block } : {}),
}));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { encryptSensitivePayloadFields } from './sensitiveCommandPayload';
import { dispatchScriptToDevice } from './scriptDispatch';
import { buildRestorePointRequest, discardRestorePointRequest } from './restorePointRequest';

const savedScript = (o = {}) => ({
  id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false, name: 'Cleanup',
  osTypes: ['windows'], language: 'powershell', content: 'Write-Host hi',
  timeoutSeconds: 60, runAs: 'system', deletedAt: null, ...o,
}) as any;

const device = (o = {}) => ({
  id: 'device-1', orgId: 'org-a', osType: 'windows', status: 'online', agentId: null,
  hostname: 'host-1', siteId: 'site-1', customFields: {}, ...o,
}) as any;

const BLOCK = {
  v: 1 as const,
  requestId: '44444444-4444-4444-8444-444444444444',
  enabled: true,
  label: 'Breeze: run script Cleanup',
  resolvedAt: '2026-10-12T00:00:00.000Z',
  policyRevision: 'rev-1',
  validUntil: '2026-10-13T00:00:00.000Z',
};

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

function mockDiscardDelete() {
  vi.mocked(db.delete).mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'exec-1' }]) }),
  } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as any);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as any);
  vi.mocked(buildRestorePointRequest).mockResolvedValue(null);
});

describe('script restore-point stamping (#4756)', () => {
  it('resolves with the script trigger, the reserved command id and the execution id', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    const r = await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(true);
    expect(buildRestorePointRequest).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'device-1',
      orgId: 'org-a',
      osType: 'windows',
      trigger: 'script',
      label: 'run script Cleanup',
      scriptExecutionId: 'exec-1',
    }));
    const call = vi.mocked(buildRestorePointRequest).mock.calls[0]![0];
    const queueOpts = vi.mocked(queueCommand).mock.calls[0]![4] as { commandId: string };
    expect(call.deviceCommandId).toBe(queueOpts.commandId);
  });

  it('stamps the block before encryption, so it reaches the queued payload', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    const encrypted = vi.mocked(encryptSensitivePayloadFields).mock.calls[0]![1] as Record<string, unknown>;
    expect(encrypted.restorePoint).toEqual(BLOCK);
    const queued = vi.mocked(queueCommand).mock.calls[0]![2] as Record<string, unknown>;
    expect(queued.restorePoint).toEqual(BLOCK);
  });

  it('adds no restorePoint key when the chokepoint returns null', async () => {
    await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    const queued = vi.mocked(queueCommand).mock.calls[0]![2] as Record<string, unknown>;
    expect('restorePoint' in queued).toBe(false);
  });

  it('a resolution failure discards the pending execution row and rejects', async () => {
    vi.mocked(buildRestorePointRequest).mockRejectedValueOnce(new Error('db down'));
    mockDiscardDelete();
    await expect(
      dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } }),
    ).rejects.toThrow('db down');
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(queueCommand).not.toHaveBeenCalled();
  });

  it('discards the requested ledger row when queueCommand throws', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    vi.mocked(queueCommand).mockRejectedValueOnce(new Error('insert failed'));
    mockDiscardDelete();
    await expect(
      dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } }),
    ).rejects.toThrow('insert failed');
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
  });

  it('discards the requested ledger row when queueCommand returns no row', async () => {
    vi.mocked(buildRestorePointRequest).mockResolvedValueOnce(BLOCK);
    vi.mocked(queueCommand).mockResolvedValueOnce(null as any);
    mockDiscardDelete();
    const r = await dispatchScriptToDevice({ device: device(), source: { kind: 'saved', script: savedScript() } });
    expect(r.ok).toBe(false);
    expect(discardRestorePointRequest).toHaveBeenCalledWith(BLOCK);
  });
});

describe('the real payload encryptor passes the block through untouched', () => {
  it('restorePoint survives encryptSensitivePayloadFields for a script payload', async () => {
    const actual = await vi.importActual<typeof import('./sensitiveCommandPayload')>('./sensitiveCommandPayload');
    const out = actual.encryptSensitivePayloadFields(
      'script',
      { scriptId: 's', language: 'powershell', content: 'x', parameters: {}, restorePoint: BLOCK },
      { commandId: '55555555-5555-4555-8555-555555555555', deviceId: 'device-1' },
    );
    expect(out.restorePoint).toEqual(BLOCK);
  });
});
