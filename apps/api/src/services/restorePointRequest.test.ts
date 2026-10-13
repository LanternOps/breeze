import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESTORE_POINT_REQUEST_BLOCK_KEYS,
  RESTORE_POINT_STATUSES,
  RESTORE_POINT_TRIGGERS,
} from '@breeze/shared';

const { resolveMock, inserted, contextCalls, dbMock, writes } = vi.hoisted(() => {
  const inserted: Array<Record<string, unknown>> = [];
  const contextCalls: string[] = [];
  const writes: Array<{ op: string; set?: unknown; where: unknown }> = [];
  const dbMock = {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: Record<string, unknown>) => {
        contextCalls.push('insert');
        inserted.push(row);
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: unknown) => ({
        where: vi.fn(async (where: unknown) => { writes.push({ op: 'update', set, where }); }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async (where: unknown) => { writes.push({ op: 'delete', where }); }),
    })),
  };
  return { resolveMock: vi.fn(), inserted, contextCalls, dbMock, writes };
});

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: (fn: () => unknown) => {
    contextCalls.push('runOutsideDbContext');
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    contextCalls.push('withSystemDbAccessContext');
    return fn();
  },
}));

const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: captureMock }));

vi.mock('./featureConfigResolver', () => ({
  resolveSystemProtectionForDevice: resolveMock,
}));

import {
  buildRestorePointRequest,
  discardRestorePointRequest,
  linkRestorePointCommand,
  type BuildRestorePointRequestInput,
} from './restorePointRequest';
import { Param, SQL } from 'drizzle-orm';
import {
  RESTORE_POINT_ATTEMPT_STATUSES,
  RESTORE_POINT_ATTEMPT_TRIGGERS,
} from '../db/schema/deviceRestorePointAttempts';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const base: BuildRestorePointRequestInput = {
  deviceId: DEVICE_ID,
  orgId: ORG_ID,
  osType: 'windows',
  trigger: 'script',
  label: 'run script Cleanup',
};

function mockResolved(
  settings: Partial<{ beforePatching: boolean; beforeScripts: boolean; beforeSoftwareInstall: boolean; labelPrefix: string }>,
  extra: Partial<{ policyRevision: string | null; isPlatformDefault: boolean; invalidStoredSettings: boolean }> = {},
) {
  resolveMock.mockResolvedValue({
    settings: {
      beforePatching: true,
      beforeScripts: false,
      beforeSoftwareInstall: false,
      labelPrefix: 'Breeze',
      ...settings,
    },
    policyRevision: '2026-10-01T00:00:00.000Z',
    isPlatformDefault: false,
    invalidStoredSettings: false,
    ...extra,
  });
}

beforeEach(() => {
  resolveMock.mockReset();
  inserted.length = 0;
  contextCalls.length = 0;
  writes.length = 0;
  captureMock.mockReset();
});

/** Bound parameter values of a drizzle condition (walks SQL/Param nodes only). */
function boundValues(node: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (n: unknown) => {
    if (n instanceof Param) { out.push((n as unknown as { value: unknown }).value); return; }
    if (n instanceof SQL) (n as unknown as { queryChunks: unknown[] }).queryChunks.forEach(visit);
  };
  visit(node);
  return out;
}

describe('buildRestorePointRequest', () => {
  it('returns null for a non-Windows device without resolving the policy', async () => {
    mockResolved({ beforeScripts: true });
    expect(await buildRestorePointRequest({ ...base, osType: 'macos' })).toBeNull();
    expect(await buildRestorePointRequest({ ...base, osType: null })).toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('matches Windows case-insensitively', async () => {
    mockResolved({ beforeScripts: true });
    expect(await buildRestorePointRequest({ ...base, osType: 'Windows' })).not.toBeNull();
  });

  // Decision 1: no policy anywhere => payload byte-identical to today.
  it.each(['patch', 'script', 'software_install'] as const)(
    'returns null and writes no row when no policy exists (platform default), trigger=%s',
    async (trigger) => {
      mockResolved(
        { beforePatching: true, beforeScripts: true, beforeSoftwareInstall: true },
        { isPlatformDefault: true, policyRevision: null },
      );
      expect(await buildRestorePointRequest({ ...base, trigger })).toBeNull();
      expect(inserted).toHaveLength(0);
    },
  );

  // Decision 3: malformed stored settings => platform-default behaviour.
  it('returns null and writes no row when the winning policy has invalid stored settings', async () => {
    mockResolved({ beforePatching: true }, { invalidStoredSettings: true });
    expect(await buildRestorePointRequest({ ...base, trigger: 'patch' })).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('returns null for script / software_install when the explicit toggle is off', async () => {
    mockResolved({ beforeScripts: false, beforeSoftwareInstall: false, beforePatching: true });
    expect(await buildRestorePointRequest({ ...base, trigger: 'script' })).toBeNull();
    expect(await buildRestorePointRequest({ ...base, trigger: 'software_install' })).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  // Decision 2: a missing block on install_patches means ENABLED to the agent,
  // so an explicit off must be stamped as enabled:false.
  it('stamps enabled:false for patch when the explicit policy turns beforePatching off, with no ledger row', async () => {
    mockResolved({ beforePatching: false });
    const block = await buildRestorePointRequest({ ...base, trigger: 'patch', label: 'install 3 updates' });
    expect(block).toMatchObject({ v: 1, enabled: false, label: 'Breeze: install 3 updates' });
    expect(inserted).toHaveLength(0);
  });

  it('maps each trigger to its own toggle', async () => {
    mockResolved({ beforePatching: true, beforeScripts: false, beforeSoftwareInstall: true });
    expect((await buildRestorePointRequest({ ...base, trigger: 'patch' }))?.enabled).toBe(true);
    expect(await buildRestorePointRequest({ ...base, trigger: 'script' })).toBeNull();
    expect((await buildRestorePointRequest({ ...base, trigger: 'software_install' }))?.enabled).toBe(true);
  });

  it('stamps a v1 block with exactly the wire keys, a fresh requestId, and a 24h validUntil', async () => {
    mockResolved({ beforeScripts: true, labelPrefix: 'Acme' }, { policyRevision: 'rev-7' });
    const block = await buildRestorePointRequest(base);
    expect(block).not.toBeNull();
    expect(Object.keys(block!).sort()).toEqual([...RESTORE_POINT_REQUEST_BLOCK_KEYS].sort());
    expect(block).toMatchObject({ v: 1, enabled: true, label: 'Acme: run script Cleanup', policyRevision: 'rev-7' });
    expect(block!.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ttl = new Date(block!.validUntil).getTime() - new Date(block!.resolvedAt).getTime();
    expect(ttl).toBe(24 * 60 * 60 * 1000);
    const second = await buildRestorePointRequest(base);
    expect(second!.requestId).not.toBe(block!.requestId);
  });

  it('sends policyRevision as an empty string, never null', async () => {
    mockResolved({ beforeScripts: true }, { policyRevision: null });
    const block = await buildRestorePointRequest(base);
    expect(block!.policyRevision).toBe('');
    expect(inserted[0]!.policyRevision).toBeNull();
  });

  it('truncates the label to 180 characters', async () => {
    mockResolved({ beforeScripts: true });
    const block = await buildRestorePointRequest({ ...base, label: 'x'.repeat(400) });
    expect(block!.label).toHaveLength(180);
  });

  it('inserts the requested ledger row with the same requestId and linkage ids', async () => {
    mockResolved({ beforeScripts: true });
    const block = await buildRestorePointRequest({
      ...base,
      scriptExecutionId: 'exec-1',
      deviceCommandId: 'cmd-1',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      requestId: block!.requestId,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      deviceCommandId: 'cmd-1',
      trigger: 'script',
      status: 'requested',
      scriptExecutionId: 'exec-1',
      softwareDeploymentId: null,
      patchJobId: null,
    });
  });

  it('resolves and inserts inside a fresh system context (escaping any caller context)', async () => {
    mockResolved({ beforeScripts: true });
    await buildRestorePointRequest(base);
    expect(contextCalls).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext', 'insert']);
  });

  it('propagates a resolver error instead of degrading to no-checkpoint', async () => {
    resolveMock.mockRejectedValue(new Error('connection terminated'));
    await expect(buildRestorePointRequest(base)).rejects.toThrow(/connection terminated/);
    expect(inserted).toHaveLength(0);
  });

  it('shared trigger/status lists match the ledger schema', () => {
    expect([...RESTORE_POINT_TRIGGERS]).toEqual([...RESTORE_POINT_ATTEMPT_TRIGGERS]);
    expect([...RESTORE_POINT_STATUSES]).toEqual([...RESTORE_POINT_ATTEMPT_STATUSES]);
  });
});

describe('ledger helpers', () => {
  const BLOCK = {
    v: 1 as const, requestId: '77777777-7777-4777-8777-777777777777', enabled: true, label: 'x',
    resolvedAt: '2026-10-12T00:00:00.000Z', policyRevision: '', validUntil: '2026-10-13T00:00:00.000Z',
  };

  it('a failed ledger insert fails the build (never returns an unrecorded block)', async () => {
    mockResolved({ beforeScripts: true });
    dbMock.insert.mockImplementationOnce(() => ({ values: vi.fn(async () => { throw new Error('insert failed'); }) }) as any);
    await expect(buildRestorePointRequest(base)).rejects.toThrow('insert failed');
  });

  it('discard deletes only a still-requested row for this requestId', async () => {
    await discardRestorePointRequest(BLOCK);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.op).toBe('delete');
    expect(boundValues(writes[0]!.where)).toEqual([BLOCK.requestId, 'requested']);
  });

  it('discard and link are no-ops for null and enabled:false blocks', async () => {
    await discardRestorePointRequest(null);
    await discardRestorePointRequest({ ...BLOCK, enabled: false });
    await linkRestorePointCommand(null, 'cmd');
    await linkRestorePointCommand({ ...BLOCK, enabled: false }, 'cmd');
    expect(writes).toHaveLength(0);
  });

  it('discard swallows and reports its own failure (never masks the caller error)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.delete.mockImplementationOnce(() => ({ where: vi.fn(async () => { throw new Error('db down'); }) }) as any);
    await expect(discardRestorePointRequest(BLOCK)).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('link sets deviceCommandId by requestId, and swallows + reports a failure', async () => {
    await linkRestorePointCommand(BLOCK, 'cmd-9');
    expect(writes[0]).toMatchObject({ op: 'update', set: { deviceCommandId: 'cmd-9' } });
    expect(boundValues(writes[0]!.where)).toEqual([BLOCK.requestId]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    dbMock.update.mockImplementationOnce(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => { throw new Error('db down'); }) })) }) as any);
    await expect(linkRestorePointCommand(BLOCK, 'cmd-9')).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});
