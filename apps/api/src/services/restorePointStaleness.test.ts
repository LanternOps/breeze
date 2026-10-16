import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const updates: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }> = [];
  const deletes: unknown[] = [];
  const inserted: Array<Record<string, unknown>> = [];
  let updateReturning: unknown[] = [{ id: 'row' }];
  let deviceRows: unknown[] = [{ orgId: 'org-1', osType: 'windows' }];
  const db = {
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          updates.push({ table, set, where });
          return { returning: vi.fn(async () => updateReturning) };
        }),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { deletes.push(w); }) })),
    insert: vi.fn(() => ({ values: vi.fn(async (row: Record<string, unknown>) => { inserted.push(row); }) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => deviceRows) })) })) })),
  };
  return {
    db,
    updates,
    deletes,
    inserted,
    resolve: vi.fn(),
    setUpdateReturning: (rows: unknown[]) => { updateReturning = rows; },
    setDeviceRows: (rows: unknown[]) => { deviceRows = rows; },
  };
});

vi.mock('../db', () => ({
  db: h.db,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./featureConfigResolver', () => ({ resolveSystemProtectionForDevice: h.resolve }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import {
  RESTORE_POINT_SUPERSEDED_MESSAGE,
  isRestorePointBlockStale,
  isStaleRestorePointPayload,
  refreshRestorePointForDelivery,
  supersedeStaleRestorePoint,
} from './restorePointRequest';
import { deviceCommands } from '../db/schema';
import { deviceRestorePointAttempts } from '../db/schema/deviceRestorePointAttempts';

const NOW = new Date('2026-10-12T12:00:00.000Z');

/** Literal SQL text + bound values of a drizzle sql`` (its chunk graph is circular). */
function sqlText(node: unknown): string {
  const out: string[] = [];
  const visit = (n: unknown) => {
    if (n == null) return;
    if (typeof n === 'string') { out.push(n); return; }
    if (typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.queryChunks)) { o.queryChunks.forEach(visit); return; }
    if (Array.isArray(o.value)) { (o.value as unknown[]).forEach((v) => typeof v === 'string' && out.push(v)); return; }
    if ('value' in o && 'encoder' in o) { out.push(String(o.value)); return; }
    if (typeof o.name === 'string') out.push(`<col:${o.name}>`);
  };
  visit(node);
  return out.join('');
}

function block(o: Record<string, unknown> = {}) {
  return {
    v: 1,
    requestId: '66666666-6666-4666-8666-666666666666',
    enabled: true,
    label: 'Acme: run script Cleanup',
    resolvedAt: '2026-10-10T12:00:00.000Z',
    policyRevision: 'rev-1',
    validUntil: '2026-10-11T12:00:00.000Z',
    ...o,
  };
}

const ctx = { commandId: 'cmd-1', deviceId: 'device-1', type: 'script', claimedAt: new Date('2026-10-12T11:59:00.000Z') };

function policyOn() {
  h.resolve.mockResolvedValue({
    settings: { beforePatching: true, beforeScripts: true, beforeSoftwareInstall: true, labelPrefix: 'Acme' },
    policyRevision: 'rev-2',
    isPlatformDefault: false,
    invalidStoredSettings: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.deletes.length = 0;
  h.inserted.length = 0;
  h.setUpdateReturning([{ id: 'row' }]);
  h.setDeviceRows([{ orgId: 'org-1', osType: 'windows' }]);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isRestorePointBlockStale', () => {
  it('is not stale before validUntil', () => {
    expect(isRestorePointBlockStale(block({ validUntil: '2026-10-13T00:00:00Z' }), new Date('2026-10-12T23:59:00Z'))).toBe(false);
  });
  it('is stale after validUntil', () => {
    expect(isRestorePointBlockStale(block({ validUntil: '2026-10-13T00:00:00Z' }), new Date('2026-10-13T00:01:00Z'))).toBe(true);
  });
  it('treats a malformed or missing validUntil as stale', () => {
    expect(isRestorePointBlockStale(block({ validUntil: 'not-a-date' }), NOW)).toBe(true);
    expect(isRestorePointBlockStale(block({ validUntil: undefined }), NOW)).toBe(true);
  });
});

describe('isStaleRestorePointPayload', () => {
  it('is false for a payload with no restorePoint key (every pre-feature command)', () => {
    expect(isStaleRestorePointPayload({ scriptId: 's' }, NOW)).toBe(false);
    expect(isStaleRestorePointPayload(null, NOW)).toBe(false);
  });
  it('is false for a block the agent would not read (wrong v / not an object)', () => {
    expect(isStaleRestorePointPayload({ restorePoint: block({ v: 2 }) }, NOW)).toBe(false);
    expect(isStaleRestorePointPayload({ restorePoint: 'x' }, NOW)).toBe(false);
  });
  it('is false for a fresh block and true for an expired one', () => {
    expect(isStaleRestorePointPayload({ restorePoint: block({ validUntil: '2026-10-13T00:00:00Z' }) }, NOW)).toBe(false);
    expect(isStaleRestorePointPayload({ restorePoint: block() }, NOW)).toBe(true);
  });
});

describe('supersedeStaleRestorePoint', () => {
  it('terminalises only a still-requested row as failed with the superseded message', async () => {
    await supersedeStaleRestorePoint('req-1');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.table).toBe(deviceRestorePointAttempts);
    expect(h.updates[0]!.set).toMatchObject({ status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE });
    expect(RESTORE_POINT_SUPERSEDED_MESSAGE).toBe('superseded before delivery: the policy snapshot expired');
  });
});

describe('refreshRestorePointForDelivery', () => {
  it('returns the payload untouched, with no DB work, when the block is fresh (transport redelivery)', async () => {
    const payload = { scriptId: 's', restorePoint: block({ validUntil: '2026-10-13T00:00:00Z' }) };
    const out = await refreshRestorePointForDelivery(payload, ctx);
    expect(out).toBe(payload);
    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it('is a no-op for a payload with no restorePoint key', async () => {
    const payload = { scriptId: 's' };
    expect(await refreshRestorePointForDelivery(payload, ctx)).toBe(payload);
    expect(h.db.update).not.toHaveBeenCalled();
  });

  it('supersedes the expired request, re-stamps a fresh block bound to this command, and persists only that key', async () => {
    policyOn();
    const stale = block();
    const payload = { scriptId: 's', executionId: 'exec-9', downloadUrl: 'minted-not-persisted', restorePoint: stale };
    const out = await refreshRestorePointForDelivery(payload, ctx);

    // old row superseded
    const supersede = h.updates.find((u) => u.table === deviceRestorePointAttempts);
    expect(supersede?.set).toMatchObject({ status: 'failed', message: RESTORE_POINT_SUPERSEDED_MESSAGE });

    // new block + new requested row, linked to this command and the execution
    const fresh = (out as any).restorePoint;
    expect(fresh.requestId).not.toBe(stale.requestId);
    expect(fresh.policyRevision).toBe('rev-2');
    expect(fresh.label).toBe(stale.label);
    expect(new Date(fresh.validUntil).getTime()).toBeGreaterThan(NOW.getTime());
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      requestId: fresh.requestId,
      deviceCommandId: 'cmd-1',
      trigger: 'script',
      scriptExecutionId: 'exec-9',
      status: 'requested',
    });

    // persisted onto the command row with a single-key jsonb update
    const persist = h.updates.find((u) => u.table === deviceCommands);
    expect(persist).toBeDefined();
    expect(Object.keys(persist!.set)).toEqual(['payload']);
    const text = sqlText(persist!.set.payload);
    expect(text).toContain('jsonb_set');
    expect(text).toContain(fresh.requestId);
    expect(text).not.toContain('minted-not-persisted');

    // every other payload key passes through unchanged
    expect(out).toMatchObject({ scriptId: 's', executionId: 'exec-9', downloadUrl: 'minted-not-persisted' });
  });

  it('maps command types to triggers and carries the linkage ids', async () => {
    policyOn();
    await refreshRestorePointForDelivery(
      { patchJobId: 'job-3', restorePoint: block() },
      { ...ctx, type: 'install_patches' },
    );
    expect(h.inserted[0]).toMatchObject({ trigger: 'patch', patchJobId: 'job-3' });
    h.inserted.length = 0;
    await refreshRestorePointForDelivery(
      { deploymentId: 'dep-4', restorePoint: block() },
      { ...ctx, type: 'software_install' },
    );
    expect(h.inserted[0]).toMatchObject({ trigger: 'software_install', softwareDeploymentId: 'dep-4' });
  });

  it('removes the key (legacy defaults) when the policy no longer applies', async () => {
    h.resolve.mockResolvedValue({
      settings: { beforePatching: true, beforeScripts: false, beforeSoftwareInstall: false, labelPrefix: 'Breeze' },
      policyRevision: null,
      isPlatformDefault: true,
      invalidStoredSettings: false,
    });
    const out = await refreshRestorePointForDelivery({ scriptId: 's', restorePoint: block() }, ctx);
    expect('restorePoint' in out).toBe(false);
    expect(h.inserted).toHaveLength(0);
    const persist = h.updates.find((u) => u.table === deviceCommands);
    expect(sqlText(persist!.set.payload)).toContain("- 'restorePoint'");
  });

  it('throws (so delivery releases the row) and discards the new request when the claim no longer matches', async () => {
    policyOn();
    h.setUpdateReturning([]);
    await expect(refreshRestorePointForDelivery({ scriptId: 's', restorePoint: block() }, ctx)).rejects.toThrow(/claim/i);
    expect(h.deletes).toHaveLength(1);
  });

  it('propagates a resolution failure instead of delivering the stale snapshot', async () => {
    h.resolve.mockRejectedValue(new Error('db down'));
    await expect(refreshRestorePointForDelivery({ scriptId: 's', restorePoint: block() }, ctx)).rejects.toThrow('db down');
    expect(h.db.update).toHaveBeenCalledTimes(1); // only the supersede
  });

  it('refuses to refresh an unknown command type rather than guessing a trigger', async () => {
    const payload = { restorePoint: block() };
    expect(await refreshRestorePointForDelivery(payload, { ...ctx, type: 'reboot' })).toBe(payload);
    expect(h.db.update).not.toHaveBeenCalled();
  });
});
