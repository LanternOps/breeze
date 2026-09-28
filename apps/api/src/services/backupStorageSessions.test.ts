import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
  hasDbAccessContext: () => true,
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./backupCommandCredentials', () => ({
  PROVIDER_CONFIG_REF_FIELD: 'providerConfigRef',
  BACKUP_READ_CREDENTIAL_COMMAND_TYPES: [
    'backup_restore', 'backup_verify', 'backup_test_restore', 'mssql_restore', 'mssql_verify', 'hyperv_restore',
  ],
  materializeBackupStorageCredentials: vi.fn(),
}));
vi.mock('./backupStorageSessionStore', () => ({ drizzleBrokeredReadStore: {} }));
vi.mock('./recoveryDownloadService', () => ({ presignSnapshotObjectGet: vi.fn() }));

import {
  BROKERED_READ_COMMAND_TYPES,
  STORAGE_OBJECT_URL_TTL_SECONDS,
  STORAGE_SESSION_LEASE_MS,
  STORAGE_SESSION_MAX_BATCH,
  STORAGE_SESSION_OBJECTS_PER_MINUTE,
  STORAGE_SESSION_OBJECT_BURST,
  authenticateStorageSession,
  deliverBrokeredReadCommand,
  evaluateStorageSessionBudget,
  renewStorageSession,
  resolveStorageSessionObjects,
  storageSessionBudgets,
  type BrokeredReadDeps,
  type BrokeredReadStore,
  type StorageSessionRow,
  type StorageSnapshotRow,
} from './backupStorageSessions';
import { CommandDeliveryDeferredError, CommandDeliveryRefusedError } from './commandDeliveryRefusal';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE } from './backupReadHelperGate';

type SessionDescriptor = { sessionId: string; token: string; baseUrl: string; expiresAt: string; deadline: string };

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const EXEC_DEVICE = '33333333-3333-4333-8333-333333333333';
const SOURCE_DEVICE = '44444444-4444-4444-8444-444444444444';
const OTHER_DEVICE = '55555555-5555-4555-8555-555555555555';
const CONFIG = '66666666-6666-4666-8666-666666666666';
const SNAPSHOT_DB_ID = '77777777-7777-4777-8777-777777777777';
const COMMAND = '88888888-8888-4888-8888-888888888888';
const SNAP = 'snap-2026-09-26-a';
const IDENTITY = 's3::storage.example::bucket-a';
const NOW = new Date('2026-09-26T12:00:00.000Z');

type FakeState = {
  device: { id: string; orgId: string; backupReadProtocolVersion: number; agentServerUrl: string | null } | null;
  snapshots: StorageSnapshotRow[];
  config: { provider: string; providerConfig: Record<string, unknown> } | null;
  indexed: Map<string, string[]>;
  origins: Array<{ originSnapshotId: string; originOrgId: string; originDeviceId: string; originStorageIdentity: string }>;
  sessions: Map<string, StorageSessionRow>;
  command: { status: string; deviceId: string } | null;
  revoked: Array<{ id: string; reason: string }>;
};

function makeSnapshot(overrides: Partial<StorageSnapshotRow> = {}): StorageSnapshotRow {
  return {
    id: SNAPSHOT_DB_ID,
    orgId: ORG,
    deviceId: SOURCE_DEVICE,
    configId: CONFIG,
    snapshotId: SNAP,
    storageIdentity: IDENTITY,
    keyLayout: 'legacy_flat',
    fileIndexStatus: 'complete',
    metadata: {},
    ...overrides,
  };
}

function makeState(): FakeState {
  return {
    device: { id: EXEC_DEVICE, orgId: ORG, backupReadProtocolVersion: 1, agentServerUrl: 'https://api.breeze.example' },
    snapshots: [makeSnapshot()],
    config: {
      provider: 's3',
      providerConfig: { bucket: 'bucket-a', region: 'us-east-1', endpoint: 'https://storage.example', accessKey: 'AK', secretKey: 'synthetic-secret-value' },
    },
    indexed: new Map([[SNAPSHOT_DB_ID, [`snapshots/${SNAP}/files/a.txt`, `snapshots/${SNAP}/files/b.txt`, 'snapshots/snap-older/files/c.txt', 'snapshots/snap-foreign/files/d.txt']]]),
    origins: [
      { originSnapshotId: 'snap-older', originOrgId: ORG, originDeviceId: SOURCE_DEVICE, originStorageIdentity: IDENTITY },
      { originSnapshotId: 'snap-foreign', originOrgId: ORG, originDeviceId: OTHER_DEVICE, originStorageIdentity: IDENTITY },
    ],
    sessions: new Map(),
    command: { status: 'sent', deviceId: EXEC_DEVICE },
    revoked: [],
  };
}

function makeStore(state: FakeState): BrokeredReadStore {
  return {
    loadDevice: vi.fn(async (id: string) => (state.device && state.device.id === id ? state.device : null)),
    findSnapshots: vi.fn(async ({ orgId, externalSnapshotId, configId }) =>
      state.snapshots.filter((s) => s.orgId === orgId && s.snapshotId === externalSnapshotId && (!configId || s.configId === configId))),
    loadSnapshotById: vi.fn(async (id: string) => state.snapshots.find((s) => s.id === id) ?? null),
    resolveConfig: vi.fn(async (configId: string, orgId: string) => (configId === CONFIG && orgId === ORG ? state.config : null)),
    countIndexedFiles: vi.fn(async (id: string) => (state.indexed.get(id) ?? []).length),
    nextGeneration: vi.fn(async (commandId: string) =>
      1 + Math.max(0, ...[...state.sessions.values()].filter((s) => s.commandId === commandId).map((s) => s.generation))),
    insertSession: vi.fn(async (row: StorageSessionRow) => {
      state.sessions.set(row.id, { ...row });
    }),
    loadSession: vi.fn(async (id: string) => {
      const s = state.sessions.get(id);
      return s ? { ...s } : null;
    }),
    loadCommand: vi.fn(async () => state.command),
    revokeSession: vi.fn(async (id: string, reason: string) => {
      state.revoked.push({ id, reason });
      const s = state.sessions.get(id);
      if (s) s.revokedAt = NOW;
    }),
    filterIndexedKeys: vi.fn(async (id: string, keys: string[]) => {
      const rows = new Set(state.indexed.get(id) ?? []);
      return new Set(keys.filter((k) => rows.has(k)));
    }),
    loadVerifiedOrigins: vi.fn(async (_id: string, originIds: string[]) => state.origins.filter((o) => originIds.includes(o.originSnapshotId))),
    consumeBudget: vi.fn(async (id: string, request: { calls: number; objects: number }, now: Date) => {
      const s = state.sessions.get(id);
      if (!s || s.revokedAt) return null;
      const decision = evaluateStorageSessionBudget(s, request, now);
      if (decision.kind === 'granted') Object.assign(s, decision.next);
      return decision;
    }),
    extendLease: vi.fn(async (id: string, expiresAt: Date) => {
      const s = state.sessions.get(id);
      if (!s || s.revokedAt) return null;
      s.expiresAt = expiresAt > s.expiresAt ? expiresAt : s.expiresAt;
      return s.expiresAt;
    }),
  };
}

let tokenCounter = 0;
function makeDeps(state: FakeState, overrides: Partial<BrokeredReadDeps> = {}) {
  const store = makeStore(state);
  const deps: BrokeredReadDeps & {
    materializeLocalDestination: ReturnType<typeof vi.fn>;
    recordDispatch: ReturnType<typeof vi.fn>;
    recordMint: ReturnType<typeof vi.fn>;
    requestIndexHydration: ReturnType<typeof vi.fn>;
    presignGet: ReturnType<typeof vi.fn>;
  } = {
    store,
    now: () => NOW,
    randomToken: () => {
      tokenCounter += 1;
      return `${String(tokenCounter).padStart(4, '0')}${'A'.repeat(39)}`;
    },
    presignGet: vi.fn(async ({ key, expiresInSeconds }: { key: string; expiresInSeconds: number }) =>
      `https://storage.example/bucket-a/${encodeURIComponent(key)}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=sig`),
    requestIndexHydration: vi.fn(async () => undefined),
    publicOrigins: () => ['https://api.breeze.example'],
    materializeLocalDestination: vi.fn(async (payload: Record<string, unknown>) => {
      const { providerConfigRef: _ref, ...rest } = payload;
      return { ...rest, providerConfig: { bucket: 'bucket-a', secretKey: 'synthetic-secret-value' } };
    }),
    recordDispatch: vi.fn(),
    recordMint: vi.fn(),
    inOrgContext: async <T,>(_orgId: string, fn: () => Promise<T>) => fn(),
    lookupDeviceOrg: async () => ORG,
    ...overrides,
  } as any;
  return deps;
}

const ctx = (overrides: Record<string, unknown> = {}) => ({
  commandId: COMMAND,
  deviceId: EXEC_DEVICE,
  type: 'backup_restore',
  claimedAt: NOW,
  ...overrides,
});

const restorePayload = () => ({
  commandId: COMMAND,
  snapshotId: SNAP,
  targetPath: '/restore',
  selectedPaths: [],
  provider: 's3',
  providerConfigRef: { configId: CONFIG, orgId: ORG },
});

beforeEach(() => {
  tokenCounter = 0;
});

describe('brokered read delivery', () => {
  it.each(['backup_restore', 'mssql_restore'])(
    'refuses %s for a snapshot written in a key layout this server cannot read',
    async (type) => {
      const state = makeState();
      state.snapshots = [makeSnapshot({ keyLayout: 'device_scoped', metadata: { backupFileName: 'db.bak' } })];
      const deps = makeDeps(state);
      await expect(deliverBrokeredReadCommand(restorePayload(), ctx({ type }), deps))
        .rejects.toThrow('This backup was written in a storage format this server version cannot read. Update the server, then try again.');
      expect(deps.recordDispatch).toHaveBeenCalledWith(type, 'refused', 'key_layout_unsupported');
      expect(state.sessions.size).toBe(0);
    },
  );

  describe('storage session issuance telemetry', () => {
    it('counts a minted session once', async () => {
      const deps = makeDeps(makeState());
      await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);
      expect(deps.recordMint.mock.calls).toEqual([['snapshot_read', 'minted', 'ok']]);
    });

    it('counts a refusal with its reason and mints nothing', async () => {
      const state = makeState();
      state.device!.backupReadProtocolVersion = 0;
      const deps = makeDeps(state);
      await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
      expect(deps.recordMint.mock.calls).toEqual([['snapshot_read', 'refused', 'helper_unsupported']]);
      expect(state.sessions.size).toBe(0);
    });

    it('counts a deferral while the file index is not ready', async () => {
      const state = makeState();
      state.snapshots = [makeSnapshot({ fileIndexStatus: 'agent' })];
      const deps = makeDeps(state);
      await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(deps.recordMint.mock.calls).toEqual([['snapshot_read', 'deferred', 'index_unavailable']]);
    });

    it('defers a read of a snapshot whose brokered write is still sealing', async () => {
      const state = makeState();
      const deps = makeDeps(state);
      (deps.store as BrokeredReadStore).isSnapshotSealing = vi.fn(async (id: string) => id === SNAP);
      await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(deps.recordMint.mock.calls).toEqual([['snapshot_read', 'deferred', 'snapshot_sealing']]);
      expect(state.sessions.size).toBe(0);
    });

    it('counts a VM command delivered as queued', async () => {
      const state = makeState();
      state.device!.backupReadProtocolVersion = 0;
      const deps = makeDeps(state);
      await deliverBrokeredReadCommand({ restoreJobId: 'r1', snapshotId: SNAP, vmName: 'vm1' }, ctx({ type: 'vm_instant_boot' }), deps);
      expect(deps.recordMint.mock.calls).toEqual([['snapshot_read', 'legacy', 'helper_unsupported']]);
    });

    it('does not count a local destination, which never needs a session', async () => {
      const deps = makeDeps(makeState());
      await deliverBrokeredReadCommand({ ...restorePayload(), provider: 'local' }, ctx(), deps);
      expect(deps.recordMint).not.toHaveBeenCalled();
    });
  });

  it('covers exactly the eight restore-shaped command types', () => {
    expect([...BROKERED_READ_COMMAND_TYPES].sort()).toEqual([
      'backup_restore', 'backup_test_restore', 'backup_verify', 'hyperv_restore',
      'mssql_restore', 'mssql_verify', 'vm_instant_boot', 'vm_restore_from_backup',
    ]);
  });

  it('delivers a storage session instead of a storage destination to a capable helper', async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const out = await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);

    expect(out).not.toHaveProperty('providerConfig');
    expect(out).not.toHaveProperty('providerConfigRef');
    expect(out).not.toHaveProperty('providerConfigEnvelope');
    expect(out.provider).toBe('s3');
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
    const session = out.storageSession as Record<string, unknown>;
    expect(session).toMatchObject({
      version: 1,
      baseUrl: 'https://api.breeze.example',
      capabilities: ['resolve_batch', 'renew'],
      maxBatch: 100,
    });
    expect(Object.keys(session).sort()).toEqual(
      ['baseUrl', 'capabilities', 'deadline', 'deadlineIn', 'expiresAt', 'expiresIn', 'maxBatch', 'sessionId', 'token', 'version'],
    );
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof session.expiresIn).toBe('number');
    expect(session.expiresIn as number).toBeGreaterThanOrEqual(0);
    expect(typeof session.deadlineIn).toBe('number');
    expect(session.deadlineIn as number).toBeGreaterThanOrEqual(0);
    expect(session.expiresIn as number).toBeLessThanOrEqual(session.deadlineIn as number);
    expect(Date.parse(session.expiresAt as string)).toBeLessThanOrEqual(Date.parse(session.deadline as string));

    const stored = [...state.sessions.values()];
    expect(stored).toHaveLength(1);
    const row = stored[0]!;
    expect(row.tokenHash).toBe(createHash('sha256').update(session.token as string).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(session.token as string);
    expect(row).toMatchObject({
      id: session.sessionId,
      orgId: ORG,
      commandId: COMMAND,
      deviceId: EXEC_DEVICE,
      sourceDeviceId: SOURCE_DEVICE,
      snapshotId: SNAPSHOT_DB_ID,
      configId: CONFIG,
      storageIdentity: IDENTITY,
      scope: 'snapshot_read',
      generation: 1,
      useFileIndex: true,
    });
    expect(row.controlKeys).toEqual([
      `snapshots/${SNAP}/manifest.json`,
      `snapshots/${SNAP}/layout.json`,
      `snapshots/${SNAP}/system-state/manifest.json`,
    ]);
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'brokered', 'ok');
  });

  it('redelivery mints a new generation and leaves the earlier session valid', async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const first = await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);
    const second = await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);
    const a = first.storageSession as SessionDescriptor;
    const b = second.storageSession as SessionDescriptor;
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.token).not.toBe(b.token);
    expect(state.sessions.get(a.sessionId)!.generation).toBe(1);
    expect(state.sessions.get(b.sessionId)!.generation).toBe(2);
    expect(state.sessions.get(a.sessionId)!.revokedAt).toBeNull();
  });

  it.each([
    ['helper does not report the protocol', (s: FakeState) => { s.device!.backupReadProtocolVersion = 0; }, 'helper_unsupported'],
    ['destination changed provider after queueing', (s: FakeState) => { s.config = { provider: 'local', providerConfig: { path: '/b' } }; }, 'provider_changed'],
    ['storage endpoint is plain http', (s: FakeState) => { s.config!.providerConfig.endpoint = 'http://storage.example'; }, 'insecure_endpoint'],
    ['storage identity drifted', (s: FakeState) => { s.config!.providerConfig.bucket = 'bucket-b'; }, 'storage_identity_mismatch'],
    ['snapshot has no recorded storage identity', (s: FakeState) => { s.snapshots = [makeSnapshot({ storageIdentity: null })]; }, 'storage_identity_unrecorded'],
    ['snapshot not found', (s: FakeState) => { s.snapshots = []; }, 'snapshot_unresolved'],
    ['device reports a different server origin', (s: FakeState) => { s.device!.agentServerUrl = 'https://other-origin.example'; }, 'server_origin_mismatch'],
  ])('refuses delivery, and never resolves the storage destination, when %s', async (_name, mutate, reason) => {
    const state = makeState();
    mutate(state);
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'refused', reason);
    expect(deps.recordDispatch).not.toHaveBeenCalledWith('backup_restore', 'legacy', expect.anything());
    expect(state.sessions.size).toBe(0);
  });

  it('tells the operator to update the agent when the helper does not support storage sessions', async () => {
    const state = makeState();
    state.device!.backupReadProtocolVersion = 0;
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toThrow(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
  });

  it('delivers a local destination as before, whatever the helper supports: it carries a path, not a credential', async () => {
    const state = makeState();
    state.device!.backupReadProtocolVersion = 0;
    const deps = makeDeps(state, {
      materializeLocalDestination: vi.fn(async (payload: Record<string, unknown>) => {
        const { providerConfigRef: _ref, ...rest } = payload;
        return { ...rest, providerConfig: { path: '/backups' } };
      }),
    } as Partial<BrokeredReadDeps>);
    const out = await deliverBrokeredReadCommand({ ...restorePayload(), provider: 'local' }, ctx(), deps);
    expect(out.providerConfig).toEqual({ path: '/backups' });
    expect(deps.materializeLocalDestination).toHaveBeenCalledTimes(1);
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'local', 'no_credential');
    expect(state.sessions.size).toBe(0);
  });

  it('refuses when the server origin is plain http', async () => {
    const state = makeState();
    state.device!.agentServerUrl = null;
    const deps = makeDeps(state, { publicOrigins: () => ['http://api.breeze.example'] });
    await expect(deliverBrokeredReadCommand(restorePayload(), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'refused', 'insecure_server_origin');
  });

  it('emits a bare origin without the default port', async () => {
    const state = makeState();
    state.device!.agentServerUrl = 'https://API.breeze.example:443/some/path';
    const deps = makeDeps(state, { publicOrigins: () => ['https://api.breeze.example:443/'] });
    const out = await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);
    expect((out.storageSession as Record<string, unknown>).baseUrl).toBe('https://api.breeze.example');
  });

  it('uses the reported protocol from this delivery over the stored column', async () => {
    const state = makeState();
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand(restorePayload(), ctx({ reportedBackupReadProtocolVersion: 0 }), deps))
      .rejects.toThrow(BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE);
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'refused', 'helper_unsupported');
  });

  it.each(['backup_restore', 'vm_restore_from_backup'])(
    'requests file-index hydration and defers %s (retryable, no destination) while the index is not authoritative',
    async (type) => {
      const state = makeState();
      state.snapshots = [makeSnapshot({ fileIndexStatus: 'agent' })];
      const deps = makeDeps(state);
      const payload = type === 'backup_restore' ? restorePayload() : { restoreJobId: 'r1', snapshotId: SNAP, vmName: 'vm1' };
      await expect(deliverBrokeredReadCommand(payload, ctx({ type }), deps)).rejects.toBeInstanceOf(CommandDeliveryDeferredError);
      expect(deps.requestIndexHydration).toHaveBeenCalledWith(SNAPSHOT_DB_ID);
      expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
      expect(deps.recordDispatch).toHaveBeenCalledWith(type, 'deferred', 'index_unavailable');
      expect(state.sessions.size).toBe(0);
    },
  );

  it.each([
    ['an inline storage destination', (p: Record<string, unknown>) => {
      const { providerConfigRef: _ref, ...inline } = p;
      return { ...inline, providerConfig: { bucket: 'x' } };
    }, 'inline_destination'],
    ['no destination reference', (p: Record<string, unknown>) => {
      const { providerConfigRef: _ref, ...rest } = p;
      return rest;
    }, 'no_destination_ref'],
  ])('refuses a payload carrying %s', async (_name, shape, reason) => {
    const state = makeState();
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand(shape(restorePayload()), ctx(), deps)).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
    expect(deps.recordDispatch).toHaveBeenCalledWith('backup_restore', 'refused', reason);
    expect(state.sessions.size).toBe(0);
  });

  it('brokers MSSQL restores with the canonical snapshot and its single backup file', async () => {
    const state = makeState();
    state.snapshots = [makeSnapshot({ fileIndexStatus: 'none', metadata: { backupFileName: 'db_full.bak' } })];
    const deps = makeDeps(state);
    const out = await deliverBrokeredReadCommand(
      { instance: 'MSSQLSERVER', snapshotId: SNAP, backupFileName: 'db_full.bak', targetDatabase: 'db', provider: 's3', providerConfigRef: { configId: CONFIG, orgId: ORG } },
      ctx({ type: 'mssql_restore' }),
      deps,
    );
    expect(out.snapshotId).toBe(SNAP);
    expect(out.storageSession).toBeTruthy();
    const row = [...state.sessions.values()][0]!;
    expect(row.useFileIndex).toBe(false);
    expect(row.controlKeys).toEqual([`snapshots/${SNAP}/manifest.json`, `snapshots/${SNAP}/files/db_full.bak`]);
  });

  it.each(['../x.bak', 'a/b.bak', '', '..'])('refuses MSSQL (never defers) when the backup file name %j is not a single component', async (name) => {
    const state = makeState();
    state.snapshots = [makeSnapshot({ fileIndexStatus: 'none', metadata: { backupFileName: name } })];
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand(
      { snapshotId: SNAP, provider: 's3', providerConfigRef: { configId: CONFIG, orgId: ORG } },
      ctx({ type: 'mssql_verify' }),
      deps,
    )).rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(deps.recordDispatch).toHaveBeenCalledWith('mssql_verify', 'refused', 'invalid_backup_file');
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
  });

  it('brokers VM restore commands that carry no destination reference, and leaves them untouched otherwise', async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const vmPayload = { restoreJobId: 'r1', snapshotId: SNAP, vmName: 'vm1' };
    const out = await deliverBrokeredReadCommand(vmPayload, ctx({ type: 'vm_restore_from_backup' }), deps);
    expect(out.storageSession).toBeTruthy();
    expect(out).not.toHaveProperty('providerConfig');

    const legacyState = makeState();
    legacyState.device!.backupReadProtocolVersion = 0;
    const legacyDeps = makeDeps(legacyState);
    const untouched = await deliverBrokeredReadCommand(vmPayload, ctx({ type: 'vm_instant_boot' }), legacyDeps);
    expect(untouched).toEqual(vmPayload);
    expect(legacyDeps.materializeLocalDestination).not.toHaveBeenCalled();
  });

  it('bounds the deadline by the command execution clock and the lease by the deadline', async () => {
    const state = makeState();
    const deps = makeDeps(state);
    const out = await deliverBrokeredReadCommand(restorePayload(), ctx(), deps);
    const s = out.storageSession as SessionDescriptor;
    // backup_restore runs on the 30-minute clock.
    expect(Date.parse(s.deadline)).toBeLessThanOrEqual(NOW.getTime() + 30 * 60_000);
    expect(Date.parse(s.expiresAt)).toBeLessThanOrEqual(Date.parse(s.deadline));
  });
});

async function mintSession(state: FakeState, type = 'backup_restore', payload: Record<string, unknown> = restorePayload()) {
  const deps = makeDeps(state);
  const out = await deliverBrokeredReadCommand(payload, ctx({ type }), deps);
  const desc = out.storageSession as SessionDescriptor;
  return { deps, desc, row: state.sessions.get(desc.sessionId)! };
}

describe('storage session authentication', () => {
  const agent = { deviceId: EXEC_DEVICE, orgId: ORG };

  it('accepts the executing device with the session token', async () => {
    const state = makeState();
    const { deps, desc } = await mintSession(state);
    const result = await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['missing token', (d: SessionDescriptor) => ({ sessionId: d.sessionId, token: undefined, agent }), 401],
    ['wrong token', (d: SessionDescriptor) => ({ sessionId: d.sessionId, token: 'B'.repeat(43), agent }), 401],
    ['unknown session', () => ({ sessionId: '99999999-9999-4999-8999-999999999999', token: 'B'.repeat(43), agent }), 404],
    ['malformed session id', (d: SessionDescriptor) => ({ sessionId: 'not-a-uuid', token: d.token, agent }), 404],
    ['another device of the same org', (d: SessionDescriptor) => ({ sessionId: d.sessionId, token: d.token, agent: { deviceId: OTHER_DEVICE, orgId: ORG } }), 403],
    ['a device of another org', (d: SessionDescriptor) => ({ sessionId: d.sessionId, token: d.token, agent: { deviceId: EXEC_DEVICE, orgId: OTHER_ORG } }), 403],
  ])('refuses %s', async (_name, input, status) => {
    const state = makeState();
    const { deps, desc } = await mintSession(state);
    const result = await authenticateStorageSession(input(desc) as any, deps);
    expect(result).toMatchObject({ ok: false, status });
  });

  it('refuses a revoked session', async () => {
    const state = makeState();
    const { deps, desc, row } = await mintSession(state);
    row.revokedAt = NOW;
    expect(await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps)).toMatchObject({ ok: false, status: 410 });
  });

  it('refuses an expired lease and a passed deadline', async () => {
    const state = makeState();
    const { deps, desc, row } = await mintSession(state);
    const late = makeDeps(state, { now: () => new Date(row.expiresAt.getTime() + 1) });
    expect(await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, late)).toMatchObject({ ok: false, status: 410 });
    row.expiresAt = new Date(NOW.getTime() + 3600_000);
    row.deadline = new Date(NOW.getTime() - 1);
    expect(await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps)).toMatchObject({ ok: false, status: 410 });
  });

  it.each(['completed', 'failed', 'timeout', 'cancelled'])('revokes the session once the command is %s', async (status) => {
    const state = makeState();
    const { deps, desc } = await mintSession(state);
    state.command = { status, deviceId: EXEC_DEVICE };
    expect(await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps)).toMatchObject({ ok: false, status: 410 });
    expect(state.revoked).toEqual([{ id: desc.sessionId, reason: `command_${status}` }]);
  });

  it('revokes the session when the command row is gone or retargeted', async () => {
    const state = makeState();
    const { deps, desc } = await mintSession(state);
    state.command = { status: 'sent', deviceId: OTHER_DEVICE };
    expect(await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps)).toMatchObject({ ok: false, status: 410 });
    state.command = null;
    const again = await mintSession(state);
    expect(await authenticateStorageSession({ sessionId: again.desc.sessionId, token: again.desc.token, agent }, again.deps)).toMatchObject({ ok: false, status: 410 });
  });
});

describe('storage session object resolution', () => {
  it('grants exactly the authorized keys and answers every requested key once', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    const keys = [
      `snapshots/${SNAP}/manifest.json`,
      `snapshots/${SNAP}/files/a.txt`,
      `snapshots/${SNAP}/files/a.txt`, // duplicate: answered once
      'snapshots/snap-older/files/c.txt', // external, verified origin
      'snapshots/snap-foreign/files/d.txt', // external, origin of another device
      `snapshots/${SNAP}/files/not-indexed.txt`,
      `snapshots/${SNAP}/files/`, // prefix, never a grant
      `snapshots/${SNAP}/files/A.TXT`, // case differs: verbatim comparison
      `/snapshots/${SNAP}/files/a.txt`, // leading slash: verbatim comparison
      '',
      `snapshots/${SNAP}/files/../files/a.txt`,
    ];
    const result = await resolveStorageSessionObjects(row, keys, deps);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const granted = result.body.objects.map((o) => o.key);
    expect(granted).toEqual([`snapshots/${SNAP}/manifest.json`, `snapshots/${SNAP}/files/a.txt`, 'snapshots/snap-older/files/c.txt']);
    expect(result.body.denied).toEqual([
      'snapshots/snap-foreign/files/d.txt',
      `snapshots/${SNAP}/files/not-indexed.txt`,
      `snapshots/${SNAP}/files/`,
      `snapshots/${SNAP}/files/A.TXT`,
      `/snapshots/${SNAP}/files/a.txt`,
      '',
      `snapshots/${SNAP}/files/../files/a.txt`,
    ]);
    const answered = [...granted, ...result.body.denied].sort();
    expect(answered).toEqual([...new Set(keys)].sort());
    for (const o of result.body.objects) {
      expect(o.method).toBe('GET');
      expect(o.url.startsWith('https://')).toBe(true);
      expect(o.headers).toEqual({});
      const lower = Object.keys(o.headers).map((h) => h.toLowerCase());
      expect(lower).not.toContain('authorization');
      expect(lower).not.toContain('x-breeze-storage-session');
      expect(Date.parse(o.expiresAt) - NOW.getTime()).toBeLessThanOrEqual(STORAGE_OBJECT_URL_TTL_SECONDS * 1000);
      expect(o.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Remaining lifetime on the server clock, for a helper whose clock is skewed.
      expect(o.expiresIn).toBe(deps.presignGet.mock.calls[0]![0].expiresInSeconds);
    }
    expect(deps.presignGet).toHaveBeenCalledTimes(3);
    for (const call of deps.presignGet.mock.calls) {
      expect(call[0].expiresInSeconds).toBeLessThanOrEqual(STORAGE_OBJECT_URL_TTL_SECONDS);
      expect(call[0].providerConfig.bucket).toBe('bucket-a');
    }
  });

  it('denies external keys when the external origin is recorded under a different storage identity', async () => {
    const state = makeState();
    state.origins[0]!.originStorageIdentity = 's3::storage.example::bucket-z';
    const { deps, row } = await mintSession(state);
    const result = await resolveStorageSessionObjects(row, ['snapshots/snap-older/files/c.txt'], deps);
    expect(result).toMatchObject({ status: 200, body: { objects: [], denied: ['snapshots/snap-older/files/c.txt'] } });
  });

  it('denies file keys once the snapshot index is no longer authoritative', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    state.snapshots = [makeSnapshot({ fileIndexStatus: 'failed' })];
    const result = await resolveStorageSessionObjects(row, [`snapshots/${SNAP}/files/a.txt`, `snapshots/${SNAP}/manifest.json`], deps);
    expect(result).toMatchObject({ status: 200 });
    if (result.status === 200) {
      expect(result.body.denied).toEqual([`snapshots/${SNAP}/files/a.txt`]);
    }
  });

  it('revokes the session when the destination no longer matches the pinned storage identity', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    state.config!.providerConfig.bucket = 'bucket-b';
    const result = await resolveStorageSessionObjects(row, [`snapshots/${SNAP}/manifest.json`], deps);
    expect(result).toMatchObject({ status: 410 });
    expect(state.revoked[0]?.reason).toBe('storage_changed');
  });

  it('sizes the ceiling from the authorized keys and the session lifetime', () => {
    const day = storageSessionBudgets(1000, 24 * 3600, 100);
    // Every key resolved several times over, plus a full batch of look-ahead
    // re-resolution at least twice per usable URL lifetime for the whole session.
    expect(day.maxResolvedObjects).toBeGreaterThanOrEqual(1000 * 6 + 100 * Math.ceil((24 * 3600) / 270) * 2);
    expect(day.maxCalls).toBeGreaterThan(day.maxResolvedObjects);
    expect(storageSessionBudgets(1000, 30 * 60, 100).maxResolvedObjects).toBeLessThan(day.maxResolvedObjects);
    expect(STORAGE_SESSION_OBJECT_BURST).toBeGreaterThanOrEqual(STORAGE_SESSION_MAX_BATCH);
  });

  it('answers a throttled call with the exact wait and consumes nothing', () => {
    const state = {
      callCount: 5,
      resolvedObjectCount: 900,
      maxCalls: 10_000,
      maxResolvedObjects: 10_000,
      rateCallsAvailable: 50,
      rateObjectsAvailable: 40,
      rateRefilledAt: NOW,
    };
    // 100 objects needed, 40 held, refilling at STORAGE_SESSION_OBJECTS_PER_MINUTE / 60 per second.
    const decision = evaluateStorageSessionBudget(state, { calls: 1, objects: 100 }, NOW);
    const expected = Math.ceil(60 / (STORAGE_SESSION_OBJECTS_PER_MINUTE / 60));
    expect(decision).toEqual({ kind: 'throttled', retryAfterSeconds: expected });
    expect(state.rateObjectsAvailable).toBe(40);
    const later = evaluateStorageSessionBudget(state, { calls: 1, objects: 100 }, new Date(NOW.getTime() + expected * 1000));
    expect(later.kind).toBe('granted');
  });

  it('never issues a URL that outlives the session deadline', async () => {
    const state = makeState();
    const { row } = await mintSession(state);
    const nearDeadline = makeDeps(state, { now: () => new Date(row.deadline.getTime() - 20_000) });
    row.expiresAt = row.deadline;
    const result = await resolveStorageSessionObjects(row, [`snapshots/${SNAP}/manifest.json`], nearDeadline);
    expect(result.status).toBe(200);
    expect(nearDeadline.presignGet.mock.calls[0]![0].expiresInSeconds).toBeLessThanOrEqual(20);
  });
});

describe('storage session renewal', () => {
  it('extends the lease but never past the deadline', async () => {
    const state = makeState();
    const { row } = await mintSession(state);
    const nearDeadline = new Date(row.deadline.getTime() - 60_000);
    const deps = makeDeps(state, { now: () => nearDeadline });
    const result = await renewStorageSession(row, deps);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(Date.parse(result.body.expiresAt)).toBeLessThanOrEqual(row.deadline.getTime());
      expect(Date.parse(result.body.expiresAt)).toBeGreaterThan(nearDeadline.getTime());
      expect(result.body.expiresIn).toBeGreaterThan(0);
      expect(result.body.expiresIn).toBe(Math.floor((Date.parse(result.body.expiresAt) - nearDeadline.getTime()) / 1000));
    }
  });

  it('answers 410 once the deadline has passed', async () => {
    const state = makeState();
    const { row } = await mintSession(state);
    const deps = makeDeps(state, { now: () => new Date(row.deadline.getTime() + 1) });
    expect(await renewStorageSession(row, deps)).toMatchObject({ status: 410 });
  });

  it('never reports a negative expiresIn even at the instant of the deadline', async () => {
    const state = makeState();
    const { row } = await mintSession(state);
    row.expiresAt = row.deadline;
    const deps = makeDeps(state, { now: () => new Date(row.deadline.getTime() - 1) });
    const result = await renewStorageSession(row, deps);
    expect(result.status).toBe(200);
    if (result.status === 200) expect(result.body.expiresIn).toBeGreaterThanOrEqual(0);
  });
});

describe('storage session per-call revalidation', () => {
  it.each([
    ['the snapshot moved to another organization', (s: FakeState) => { s.snapshots = [makeSnapshot({ orgId: OTHER_ORG })]; }],
    ['the snapshot now belongs to another source device', (s: FakeState) => { s.snapshots = [makeSnapshot({ deviceId: OTHER_DEVICE })]; }],
    ['the snapshot pinned storage identity changed', (s: FakeState) => { s.snapshots = [makeSnapshot({ storageIdentity: 's3::storage.example::bucket-z' })]; }],
    ['the destination endpoint is no longer https', (s: FakeState) => { s.config!.providerConfig.endpoint = 'http://storage.example'; }],
    ['the snapshot reports a key layout this server cannot read', (s: FakeState) => { s.snapshots = [makeSnapshot({ keyLayout: 'device_scoped' })]; }],
  ])('ends the session when %s', async (_name, mutate) => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    mutate(state);
    const result = await resolveStorageSessionObjects(row, [`snapshots/${SNAP}/manifest.json`], deps);
    expect(result).toMatchObject({ status: 410 });
    expect(state.revoked).toEqual([{ id: row.id, reason: 'storage_changed' }]);
    expect(deps.presignGet).not.toHaveBeenCalled();
  });
});

describe('storage session key grammar', () => {
  it('denies indexed rows under the snapshot prefix that are not well-formed object keys', async () => {
    const state = makeState();
    const malformed = [
      `snapshots/${SNAP}/files/../../snap-other/files/x.bin`,
      `snapshots/${SNAP}/files/./x.bin`,
      `snapshots/${SNAP}//files/x.bin`,
      `snapshots/${SNAP}/files/dir/`,
    ];
    state.indexed.get(SNAPSHOT_DB_ID)!.push(...malformed);
    const { deps, row } = await mintSession(state);
    const result = await resolveStorageSessionObjects(row, [...malformed, `snapshots/${SNAP}/files/a.txt`], deps);
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body.objects.map((o) => o.key)).toEqual([`snapshots/${SNAP}/files/a.txt`]);
    expect(result.body.denied).toEqual(malformed);
  });

  it.each([
    ['backup_restore', '../snap-other'],
    ['backup_restore', 'snap a/b'],
    ['mssql_restore', '.hidden'],
    ['mssql_restore', 'snap/../x'],
  ])('does not build %s keys from a snapshot id outside the key grammar (%s)', async (type, snapshotId) => {
    const state = makeState();
    state.snapshots = [makeSnapshot({ snapshotId, metadata: { backupFileName: 'db.bak' } })];
    const deps = makeDeps(state);
    await expect(deliverBrokeredReadCommand({ ...restorePayload(), snapshotId }, ctx({ type }), deps))
      .rejects.toBeInstanceOf(CommandDeliveryRefusedError);
    expect(deps.recordDispatch).toHaveBeenCalledWith(type, 'refused', 'invalid_snapshot_key');
    expect(deps.materializeLocalDestination).not.toHaveBeenCalled();
    expect(state.sessions.size).toBe(0);
  });
});

describe('storage session rate limiting', () => {
  it('throttles repeated resolution and names the wait after which the next call succeeds', async () => {
    const state = makeState();
    const keys = Array.from({ length: 100 }, (_, i) => `snapshots/${SNAP}/files/r${i}.bin`);
    state.indexed = new Map([[SNAPSHOT_DB_ID, keys]]);
    let clock = NOW.getTime();
    const deps = makeDeps(state, { now: () => new Date(clock) });
    const out = await deliverBrokeredReadCommand(restorePayload(), ctx({ type: 'hyperv_restore' }), deps);
    const sessionId = (out.storageSession as SessionDescriptor).sessionId;
    const load = () => ({ ...state.sessions.get(sessionId)! });

    // Re-resolving the same full batch back to back: the burst is served, then refused.
    let served = 0;
    let refusal: { status: 429; retryAfterSeconds: number } | null = null;
    for (let i = 0; i < 1000 && !refusal; i += 1) {
      const result = await resolveStorageSessionObjects(load(), keys, deps);
      if (result.status === 200) served += result.body.objects.length;
      else if (result.status === 429) refusal = result;
      else throw new Error(`unexpected ${result.status}`);
    }
    expect(refusal).not.toBeNull();
    expect(served).toBeGreaterThanOrEqual(STORAGE_SESSION_MAX_BATCH);
    expect(served).toBeLessThan(100 * 1000);
    const wait = refusal!.retryAfterSeconds;
    expect(wait).toBeGreaterThanOrEqual(1);

    // One second short of the stated wait is still refused; at the wait it succeeds.
    clock += (wait - 1) * 1000;
    if (wait > 1) expect((await resolveStorageSessionObjects(load(), keys, deps)).status).toBe(429);
    clock += 1000;
    expect((await resolveStorageSessionObjects(load(), keys, deps)).status).toBe(200);

    // Sustained hammering for ten minutes is held to the configured rate.
    const start = clock;
    let sustained = 0;
    while (clock - start < 10 * 60_000) {
      const result = await resolveStorageSessionObjects(load(), keys, deps);
      if (result.status === 200) sustained += result.body.objects.length;
      else if (result.status === 429) clock += result.retryAfterSeconds * 1000;
      else break;
    }
    expect(sustained).toBeLessThanOrEqual(10 * STORAGE_SESSION_OBJECTS_PER_MINUTE + STORAGE_SESSION_OBJECT_BURST);
  });

  it('ends the session with a terminal answer once its absolute ceiling is spent', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    const stored = state.sessions.get(row.id)!;
    stored.resolvedObjectCount = stored.maxResolvedObjects;
    const result = await resolveStorageSessionObjects({ ...stored }, [`snapshots/${SNAP}/manifest.json`], deps);
    expect(result).toMatchObject({ status: 410 });
    expect(state.revoked).toEqual([{ id: row.id, reason: 'budget_exhausted' }]);
    expect(deps.presignGet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Budget behaviour over a long restore. The simulator below follows the
// helper's resolve pattern: it plans every key, resolves the current key plus
// the next planned keys that have no usable URL (up to maxBatch), treats a URL
// as usable until 30 s before it expires, restarts a stalled transfer on a
// fresh URL after 2 minutes without bytes (at most 3 times per object), renews
// the lease when less than a third of it remains, and honours 429 Retry-After
// for at most 5 minutes per resolve.
// ---------------------------------------------------------------------------

type SimResult = { ok: true; calls: number; objects: number; maxWaitPerResolve: number } | { ok: false; error: string };

async function simulateRestore(opts: {
  type: string;
  keyCount: number;
  perObjectSeconds: number;
  stallObjects?: (index: number) => number;
}): Promise<SimResult> {
  const state = makeState();
  const keys = Array.from({ length: opts.keyCount }, (_, i) => `snapshots/${SNAP}/files/f${String(i).padStart(6, '0')}.bin`);
  state.indexed = new Map([[SNAPSHOT_DB_ID, keys]]);
  let clock = NOW.getTime();
  const deps = makeDeps(state, { now: () => new Date(clock) });
  const out = await deliverBrokeredReadCommand(restorePayload(), ctx({ type: opts.type }), deps);
  const desc = out.storageSession as SessionDescriptor & { maxBatch: number };
  if (!desc) return { ok: false, error: 'not brokered' };
  const agent = { deviceId: EXEC_DEVICE, orgId: ORG };
  const cache = new Map<string, number>();
  const usable = (k: string) => (cache.get(k) ?? 0) - 30_000 > clock;
  let calls = 0;
  let objects = 0;
  let maxWaitPerResolve = 0;

  // The helper renews from a background ticker, independent of downloads.
  const renewIfDue = async (): Promise<string | null> => {
    const stored = state.sessions.get(desc.sessionId)!;
    if (stored.expiresAt.getTime() - clock >= STORAGE_SESSION_LEASE_MS / 3) return null;
    const auth = await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps);
    if (!auth.ok) return `auth ${auth.status} ${auth.error}`;
    const renewed = await renewStorageSession(auth.session, deps);
    return renewed.status === 200 ? null : `renew ${renewed.status}`;
  };
  const advance = async (ms: number): Promise<string | null> => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + 10_000);
      const err = await renewIfDue();
      if (err) return err;
    }
    return null;
  };

  const resolve = async (batch: string[]): Promise<string | null> => {
    let waited = 0;
    for (;;) {
      const auth = await authenticateStorageSession({ sessionId: desc.sessionId, token: desc.token, agent }, deps);
      if (!auth.ok) return `auth ${auth.status} ${auth.error}`;
      const result = await resolveStorageSessionObjects(auth.session, batch, deps);
      calls += 1;
      if (result.status === 200) {
        for (const o of result.body.objects) cache.set(o.key, Date.parse(o.expiresAt));
        objects += result.body.objects.length;
        if (result.body.denied.length > 0) return `denied ${result.body.denied[0]}`;
        maxWaitPerResolve = Math.max(maxWaitPerResolve, waited);
        return null;
      }
      if (result.status !== 429) return `resolve ${result.status} ${result.error}`;
      if (waited >= 300) return `still rate limited after ${waited} s`;
      waited += result.retryAfterSeconds;
      const err = await advance(result.retryAfterSeconds * 1000);
      if (err) return err;
    }
  };

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]!;
    let stalls = opts.stallObjects ? Math.min(3, opts.stallObjects(i)) : 0;
    for (;;) {
      if (!usable(key)) {
        const batch = [key];
        for (let j = i + 1; j < keys.length && batch.length < desc.maxBatch; j += 1) {
          if (!usable(keys[j]!)) batch.push(keys[j]!);
        }
        const err = await resolve(batch);
        if (err) return { ok: false, error: `object ${i} at +${Math.round((clock - NOW.getTime()) / 1000)} s: ${err}` };
      }
      // No bytes for 2 minutes aborts the transfer, which restarts on a fresh URL.
      const err = await advance(stalls > 0 ? 120_000 : opts.perObjectSeconds * 1000);
      if (err) return { ok: false, error: `object ${i} at +${Math.round((clock - NOW.getTime()) / 1000)} s: ${err}` };
      if (stalls > 0) {
        stalls -= 1;
        cache.delete(key);
        continue;
      }
      break;
    }
  }
  return { ok: true, calls, objects, maxWaitPerResolve };
}

describe('storage session budgets over a long restore', () => {
  it.each([
    ['many mid-size objects on a slow link', { type: 'hyperv_restore', keyCount: 3000, perObjectSeconds: 20 }],
    ['a few large objects, each far longer than a URL lifetime', { type: 'hyperv_restore', keyCount: 40, perObjectSeconds: 20 * 60 }],
    ['large objects that stall and are restarted', { type: 'vm_restore_from_backup', keyCount: 12, perObjectSeconds: 90 * 60, stallObjects: () => 3 }],
    ['mid-size objects with frequent stalls', { type: 'hyperv_restore', keyCount: 600, perObjectSeconds: 60, stallObjects: (i: number) => (i % 5 === 0 ? 3 : 0) }],
    ['a two-hour verify of many small objects', { type: 'backup_verify', keyCount: 20000, perObjectSeconds: 0.3 }],
  ])('%s never meets a permanent refusal', async (_name, opts) => {
    const result = await simulateRestore(opts);
    expect(result.ok ? 'completed' : result.error).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Wire compatibility with the helper's storage-session client. The two
// validators below mirror, rule for rule, the helper's descriptor validation
// and strict resolve-answer parsing, and the example descriptor is the
// helper's own test baseline. Anything the server emits must pass both.
// ---------------------------------------------------------------------------

const HELPER_EXAMPLE_DESCRIPTOR = {
  version: 1,
  sessionId: '0b6f0c7e-3d2a-4f5b-9e1c-8a7d6c5b4a39',
  token: 's'.repeat(43),
  baseUrl: 'https://control-plane.example',
  expiresAt: '2026-09-26T12:10:00Z',
  deadline: '2026-09-26T13:00:00Z',
  capabilities: ['resolve_batch', 'renew'],
  maxBatch: 100,
};

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function helperAcceptsDescriptor(payload: Record<string, unknown>): string | null {
  const d = payload.storageSession as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') return 'no session';
  if (payload.providerConfig !== undefined && payload.providerConfig !== null) return 'mutually exclusive';
  if (payload.provider !== undefined && payload.provider !== '' && payload.provider !== 's3') return 'provider';
  if (d.version !== 1) return 'version';
  if (typeof d.sessionId !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(d.sessionId)) return 'sessionId';
  if (typeof d.token !== 'string' || !/^[A-Za-z0-9_-]{43,512}={0,2}$/.test(d.token)) return 'token';
  let base: URL;
  try {
    base = new URL(String(d.baseUrl));
  } catch {
    return 'baseUrl';
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.pathname !== '' && base.pathname !== '/')) return 'baseUrl';
  if (String(d.baseUrl).includes(':443')) return 'baseUrl port';
  if (typeof d.expiresAt !== 'string' || !RFC3339.test(d.expiresAt)) return 'expiresAt';
  if (typeof d.deadline !== 'string' || !RFC3339.test(d.deadline)) return 'deadline';
  if (Date.parse(d.expiresAt) > Date.parse(d.deadline)) return 'expiresAt after deadline';
  if (!Array.isArray(d.capabilities) || !d.capabilities.includes('resolve_batch')) return 'capabilities';
  if (typeof d.maxBatch !== 'number' || d.maxBatch < 1 || d.maxBatch > 1000) return 'maxBatch';
  return null;
}

const FORBIDDEN_OBJECT_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'content-length',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'keep-alive', 'x-breeze-storage-session',
]);

function helperAcceptsResolveAnswer(raw: string, requested: string[]): string | null {
  const wire = JSON.parse(raw) as { objects?: Array<Record<string, unknown>>; denied?: string[] };
  const want = new Map(requested.map((k) => [k, false]));
  for (const o of wire.objects ?? []) {
    const key = o.key as string;
    if (!want.has(key)) return 'unrequested object';
    if (want.get(key)) return 'answered twice';
    want.set(key, true);
    if (o.method !== 'GET') return 'method';
    let u: URL;
    try {
      u = new URL(String(o.url));
    } catch {
      return 'url';
    }
    if (u.protocol !== 'https:' || u.username || u.password) return 'url';
    for (const name of Object.keys((o.headers as SessionDescriptor) ?? {})) {
      if (!name.trim()) return 'empty header';
      if (FORBIDDEN_OBJECT_HEADERS.has(name.trim().toLowerCase())) return `forbidden header ${name}`;
    }
    if (typeof o.expiresAt !== 'string' || !RFC3339.test(o.expiresAt)) return 'expiresAt';
  }
  for (const k of wire.denied ?? []) {
    if (!want.has(k)) return 'unrequested denial';
    if (want.get(k)) return 'granted and denied';
    want.set(k, true);
  }
  for (const answered of want.values()) if (!answered) return 'unanswered key';
  return null;
}

describe('helper wire compatibility', () => {
  it('the validators accept the helper example descriptor (sanity)', () => {
    expect(helperAcceptsDescriptor({ storageSession: HELPER_EXAMPLE_DESCRIPTOR, provider: 's3' })).toBeNull();
    expect(helperAcceptsDescriptor({ storageSession: HELPER_EXAMPLE_DESCRIPTOR, providerConfig: { bucket: 'b' } })).toBe('mutually exclusive');
  });

  it('every minted descriptor passes the helper descriptor rules', async () => {
    for (const type of BROKERED_READ_COMMAND_TYPES) {
      const state = makeState();
      if (type === 'mssql_restore' || type === 'mssql_verify') {
        state.snapshots = [makeSnapshot({ metadata: { backupFileName: 'db.bak' } })];
      }
      const deps = makeDeps(state);
      const out = await deliverBrokeredReadCommand(restorePayload(), ctx({ type }), deps);
      expect(helperAcceptsDescriptor(out), type).toBeNull();
      // Round-trip through JSON exactly as the frame travels.
      expect(helperAcceptsDescriptor(JSON.parse(JSON.stringify(out))), type).toBeNull();
    }
  });

  it('a resolve answer passes the helper strict parser, including an empty key from a Hyper-V restore', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    const requested = ['', `snapshots/${SNAP}/manifest.json`, `snapshots/${SNAP}/files/a.txt`, 'snapshots/other/files/x', `snapshots/${SNAP}/files/a.txt`];
    const result = await resolveStorageSessionObjects(row, requested, deps);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(helperAcceptsResolveAnswer(JSON.stringify(result.body), requested)).toBeNull();
    }
  });

  it('a renew answer is an RFC3339 instant in the future', async () => {
    const state = makeState();
    const { deps, row } = await mintSession(state);
    const result = await renewStorageSession(row, deps);
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.expiresAt).toMatch(RFC3339);
      expect(Date.parse(result.body.expiresAt)).toBeGreaterThan(NOW.getTime());
      expect(typeof result.body.expiresIn).toBe('number');
      expect(result.body.expiresIn).toBeGreaterThanOrEqual(0);
      expect(Object.keys(result.body).sort()).toEqual(['expiresAt', 'expiresIn']);
    }
  });
});
