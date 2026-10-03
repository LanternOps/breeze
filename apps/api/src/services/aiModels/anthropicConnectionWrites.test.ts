import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const remap = vi.hoisted(() => ({
  lockAnthropicConnection: vi.fn(),
  lockAnthropicConnectionIds: vi.fn(),
  connectAnthropicConnection: vi.fn(),
  disconnectAnthropicConnection: vi.fn(),
  rotateAnthropicConnectionKey: vi.fn(),
  setAnthropicConnectionCatalogEntry: vi.fn(),
  bumpConnectionConfigVersion: vi.fn(),
  switchAnthropicConnectionKind: vi.fn(),
  connectionPrimaryModelId: vi.fn(),
}));
const order = vi.hoisted(() => [] as string[]);
const gateState = vi.hoisted(() => ({ cutOver: true, catalogEnabled: true }));

vi.mock('./connectionRemap', async (orig) => ({
  ...(await orig<typeof import('./connectionRemap')>()),
  ...remap,
}));
vi.mock('./connectionProbe', async (orig) => ({
  ...(await orig<typeof import('./connectionProbe')>()),
  probeAnthropicKey: vi.fn(async () => { order.push('probe'); }),
  resolveCatalogEndpointForSelection: vi.fn(async () => ({ kind: 'catalog' })),
}));
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { order.push('tx'); return fn(); },
}));
vi.mock('./registryWriteLock', () => ({ lockPartnerRegistry: vi.fn(async () => { order.push('lock'); }) }));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: vi.fn(async () => gateState.cutOver) }));
vi.mock('./connections', async (orig) => ({
  ...(await orig<typeof import('./connections')>()),
  getConnection: vi.fn(),
  getConnectionKeyMaterial: vi.fn(async () => ({ id: 'c1', partnerId: 'p1', apiKeyEncrypted: 'enc' })),
  decryptConnectionKey: vi.fn(() => 'sk-ant-stored'),
}));
vi.mock('../llm/llmConfigResolver', () => ({
  isLlmProviderCatalogEnabled: vi.fn(() => gateState.catalogEnabled),
  buildCatalogEndpointSnapshot: vi.fn(() => ({ kind: 'catalog', baseUrl: 'https://gw.example', authMode: 'bearer' })),
}));
vi.mock('../llmProviderCatalog', () => ({ getListedProviderByEntryId: vi.fn(async () => ({ entryId: 'e1', slug: 'gw', revision: 3, dataNote: null })) }));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueueConnectionSync: vi.fn(async () => undefined) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { enqueueConnectionSync } from '../../jobs/aiModelDiscoveryWorker';
import { captureException } from '../sentry';
import { buildCatalogEndpointSnapshot } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import { ConnectionKeyError, getConnection } from './connections';
import { probeAnthropicKey } from './connectionProbe';
import { AnthropicConnectionMissingError, RegistryNotCutOverError } from './connectionRemap';
import { RegistryWriteError } from './registryWriteErrors';
import { changeAnthropicEndpoint, createAnthropicKeyConnection, deleteAnthropicConnection, rotateAnthropicKey } from './anthropicConnectionWrites';

const byok = { id: 'c1', partnerId: 'p1', kind: 'anthropic_byok', catalogEntryId: null, configVersion: 4, status: 'active' };
const WRITES = [
  'connectAnthropicConnection', 'disconnectAnthropicConnection', 'rotateAnthropicConnectionKey',
  'setAnthropicConnectionCatalogEntry', 'bumpConnectionConfigVersion', 'switchAnthropicConnectionKind',
] as const;
const writesIssued = () => WRITES.filter((w) => remap[w].mock.calls.length > 0);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  gateState.cutOver = true;
  gateState.catalogEnabled = true;
  vi.mocked(getConnection).mockResolvedValue(byok as never);
  remap.lockAnthropicConnection.mockResolvedValue({ ...byok, connectedBy: null, verifiedAt: null });
  remap.lockAnthropicConnectionIds.mockResolvedValue([]);
  remap.connectAnthropicConnection.mockResolvedValue('c-new');
  remap.rotateAnthropicConnectionKey.mockResolvedValue({ configVersion: 5 });
  remap.connectionPrimaryModelId.mockResolvedValue('model-conn');
});

describe('createAnthropicKeyConnection', () => {
  it('refuses an encrypted-value prefix before probing anything', async () => {
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'enc:v1:x', userId: 'u1' }))
      .rejects.toMatchObject({ status: 400 });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
  });

  it('probes outside the transaction, then connects the first connection with platform references moved', async () => {
    const out = await createAnthropicKeyConnection({ partnerId: 'p1', apiKey: ' sk-ant-1234 ', userId: 'u1' });
    expect(order).toEqual(['probe', 'tx', 'lock']);
    expect(probeAnthropicKey).toHaveBeenCalledWith('sk-ant-1234', { kind: 'anthropic' });
    expect(remap.connectAnthropicConnection).toHaveBeenCalledWith('p1', expect.objectContaining({
      kind: 'anthropic_byok', apiKey: 'sk-ant-1234', movePlatformReferences: true, connectedBy: 'u1', catalogEntryId: null,
    }));
    expect(out).toEqual({ connectionId: 'c-new', last4: '1234', configVersion: 1 });
  });

  it('refuses a second Anthropic connection under the lock (R1 cap)', async () => {
    remap.lockAnthropicConnectionIds.mockResolvedValue(['c1']);
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(remap.connectAnthropicConnection).not.toHaveBeenCalled();
  });

  it('maps a partner without registry rows to the recoverable 503', async () => {
    remap.connectAnthropicConnection.mockRejectedValueOnce(new RegistryNotCutOverError('p1'));
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }))
      .rejects.toMatchObject({ status: 503 });
  });
});

describe('rotateAnthropicKey', () => {
  it('rotates the named connection after re-checking it under the lock', async () => {
    const out = await rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' });
    expect(remap.rotateAnthropicConnectionKey).toHaveBeenCalledWith('p1', 'c1', expect.objectContaining({ apiKey: 'sk-ant-9999' }));
    expect(out).toEqual({ last4: '9999', configVersion: 5 });
  });

  it('a connection of another partner is a 409 and writes nothing', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...byok, partnerId: 'p2' } as never);
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409 });
    expect(remap.rotateAnthropicConnectionKey).not.toHaveBeenCalled();
  });

  it('a soft-disconnected connection is refused before the probe and never revived', async () => {
    vi.mocked(getConnection).mockResolvedValue({ ...byok, status: 'disconnected' } as never);
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('configuration changed') });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('a connection disconnected between the probe and the write is "configuration changed"', async () => {
    remap.lockAnthropicConnection.mockResolvedValue(null);
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('configuration changed') });
    expect(writesIssued()).toEqual([]);
  });

  it('a kind switch between the probe and the write is "configuration changed"', async () => {
    remap.lockAnthropicConnection.mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e1' });
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('configuration changed') });
  });

  it('a catalog connection probes its endpoint for the CONNECTION\'s primary model (never a chat default elsewhere)', async () => {
    const { resolveCatalogEndpointForSelection } = await import('./connectionProbe');
    vi.mocked(getConnection).mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e1' } as never);
    remap.lockAnthropicConnection.mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e1' });
    await rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' });
    expect(remap.connectionPrimaryModelId).toHaveBeenCalledWith('p1', 'c1');
    expect(resolveCatalogEndpointForSelection).toHaveBeenCalledWith('e1', 'model-conn');
    expect(probeAnthropicKey).toHaveBeenCalledWith('sk-ant-9999', { kind: 'catalog' });
  });
});

describe('changeAnthropicEndpoint', () => {
  const select = (catalogEntryId: string | null, acknowledgeDataNote = true) =>
    changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId, acknowledgeDataNote, userId: 'u1' });

  it('validates the endpoint against the connection\'s primary model, probes the stored key, switches in place', async () => {
    remap.switchAnthropicConnectionKind.mockResolvedValue({ connectionId: 'c1', configVersion: 5 });
    const out = await select('e1', false);
    expect(remap.connectionPrimaryModelId).toHaveBeenCalledWith('p1', 'c1');
    expect(buildCatalogEndpointSnapshot).toHaveBeenCalledWith(expect.anything(), 'model-conn');
    expect(probeAnthropicKey).toHaveBeenCalledWith('sk-ant-stored', expect.objectContaining({ kind: 'catalog' }));
    expect(remap.switchAnthropicConnectionKind).toHaveBeenCalledWith('p1', 'c1', { kind: 'catalog', catalogEntryId: 'e1' });
    expect(out).toEqual({ connectionId: 'c1', catalogEntryId: 'e1', configVersion: 5, slug: 'gw', revision: 3 });
  });

  it('catalog → another catalog entry edits the connection in place', async () => {
    remap.lockAnthropicConnection.mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e0', connectedBy: null, verifiedAt: null });
    remap.setAnthropicConnectionCatalogEntry.mockResolvedValue({ configVersion: 6 });
    await expect(select('e1')).resolves.toMatchObject({ connectionId: 'c1', catalogEntryId: 'e1', configVersion: 6 });
    expect(writesIssued()).toEqual(['setAnthropicConnectionCatalogEntry']);
  });

  it('clearing the endpoint on a direct connection only bumps config_version (no probe, no discovery)', async () => {
    remap.bumpConnectionConfigVersion.mockResolvedValue({ configVersion: 5 });
    const out = await select(null, false);
    expect(out).toEqual({ connectionId: 'c1', catalogEntryId: null, configVersion: 5, slug: null, revision: null });
    expect(remap.switchAnthropicConnectionKind).not.toHaveBeenCalled();
    expect(probeAnthropicKey).not.toHaveBeenCalled();
    await flush();
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
  });

  it('clearing the endpoint of a catalog connection switches it back in place and rediscovers it', async () => {
    remap.lockAnthropicConnection.mockResolvedValue({ ...byok, kind: 'catalog', catalogEntryId: 'e0', connectedBy: null, verifiedAt: null });
    remap.switchAnthropicConnectionKind.mockResolvedValue({ connectionId: 'c1', configVersion: 7 });
    await expect(select(null, false)).resolves.toMatchObject({ connectionId: 'c1', configVersion: 7 });
    expect(remap.switchAnthropicConnectionKind).toHaveBeenCalledWith('p1', 'c1', { kind: 'anthropic_byok', catalogEntryId: null });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(enqueueConnectionSync).toHaveBeenCalledWith('c1'));
  });

  it.each([
    ['a delisted entry', () => vi.mocked(getListedProviderByEntryId).mockResolvedValueOnce(null), true, 409],
    ['a missing data-note consent', () => vi.mocked(getListedProviderByEntryId).mockResolvedValueOnce({ entryId: 'e1', slug: 'gw', revision: 3, dataNote: 'Prompts transit gw.' } as never), false, 400],
    ['a connection model the revision does not serve', () => vi.mocked(buildCatalogEndpointSnapshot).mockReturnValueOnce(null), true, 409],
    ['catalog selection disabled', () => { gateState.catalogEnabled = false; }, true, 409],
  ] as const)('rejects %s without probing or writing', async (_why, arrange, ack, status) => {
    arrange();
    await expect(select('e1', ack)).rejects.toMatchObject({ name: 'ConnectionCheckError', status });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
    expect(writesIssued()).toEqual([]);
  });

  it('refuses (409) when the connection was disconnected or changed between validation and the write', async () => {
    remap.lockAnthropicConnection.mockResolvedValueOnce(null);
    await expect(select('e1')).rejects.toMatchObject({ status: 409 });
    remap.lockAnthropicConnection.mockResolvedValueOnce({ ...byok, configVersion: 9, connectedBy: null, verifiedAt: null });
    await expect(select('e1')).rejects.toMatchObject({ status: 409 });
    expect(writesIssued()).toEqual([]);
  });
});

describe('deleteAnthropicConnection', () => {
  it('disconnects the named connection; a vanished connection is "configuration changed"', async () => {
    remap.disconnectAnthropicConnection.mockResolvedValueOnce(true);
    expect(await deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' })).toBe(true);
    expect(remap.disconnectAnthropicConnection).toHaveBeenCalledWith('p1', 'c1');
    remap.disconnectAnthropicConnection.mockRejectedValueOnce(new AnthropicConnectionMissingError());
    await expect(deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' })).rejects.toMatchObject({ status: 409 });
  });

  it('runs gate → lock → disconnect and queues no discovery', async () => {
    remap.disconnectAnthropicConnection.mockImplementationOnce(async () => { order.push('disconnect'); return true; });
    await deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' });
    expect(order).toEqual(['tx', 'lock', 'disconnect']);
    await flush();
    expect(enqueueConnectionSync).not.toHaveBeenCalled();
  });
});

describe('every write', () => {
  const everyWrite = [
    () => createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }),
    () => rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' }),
    () => changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId: 'e1', acknowledgeDataNote: true, userId: 'u1' }),
    () => changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId: null, acknowledgeDataNote: false, userId: 'u1' }),
    () => deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' }),
  ];

  it('a partner whose registry cannot be bootstrapped now gets a retryable 503; nothing is probed or written', async () => {
    gateState.cutOver = false;
    for (const write of everyWrite) await expect(write()).rejects.toMatchObject({ name: 'ConnectionCheckError', status: 503 });
    expect(probeAnthropicKey).not.toHaveBeenCalled();
    expect(order).not.toContain('lock');
    expect(writesIssued()).toEqual([]);
  });

  it.each([
    ['conflict', 409, 409],
    ['stale_write', 409, 409],
    ['invalid', 422, 500],
    ['write_failed', 500, 500],
  ] as const)('maps a RegistryWriteError %s (%i) to a ConnectionCheckError %i with a safe message', async (code, status, expected) => {
    const scrubbedCause = Object.assign(new Error('AI model registry write failed: Error (SQLSTATE 23505)'), { code: '23505' });
    const registryError = new RegistryWriteError('enc:v3:SECRET-CIPHERTEXT', code, status);
    registryError.cause = scrubbedCause;
    remap.connectAnthropicConnection.mockRejectedValueOnce(registryError);
    const error = await createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' }).catch((e: unknown) => e) as Error;
    expect(error).toMatchObject({ name: 'ConnectionCheckError', status: expected });
    expect(error.message).toBe(expected === 409
      ? 'The AI provider configuration changed. Reload and try again.'
      : 'Could not save the AI provider configuration.');
    expect(error.cause).toBe(scrubbedCause);
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain('SECRET');
  });

  it('a platform model that cannot be found keeps its actionable 409 message', async () => {
    remap.disconnectAnthropicConnection.mockRejectedValueOnce(new RegistryWriteError(
      'No platform AI model is available to move these features to. Ask an operator to price the platform default model on Admin → AI models, then try again.',
      'conflict', 409,
    ));
    await expect(deleteAnthropicConnection({ partnerId: 'p1', connectionId: 'c1' }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('No platform AI model') });
  });

  it('a key that cannot be sealed maps to a 500 without the key', async () => {
    remap.connectAnthropicConnection.mockRejectedValueOnce(new ConnectionKeyError('Could not encrypt the connection key.', 'key_rejected'));
    const error = await createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-api03-secret-1234', userId: 'u1' }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ConnectionCheckError', status: 500 });
    expect(inspect(error, { showHidden: true, depth: 10 })).not.toContain('secret-1234');
  });

  it('a non-query error from a remap is rethrown with its message and stack intact', async () => {
    const bug = new Error('remap: x');
    remap.rotateAnthropicConnectionKey.mockRejectedValueOnce(bug);
    await expect(rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' })).rejects.toBe(bug);
  });
});

describe('connection discovery (spec §6: after commit, on connect and on key/endpoint change)', () => {
  it('a new connection, a rotation and a catalog selection each enqueue discovery after the write', async () => {
    await createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-1234', userId: 'u1' });
    await vi.waitFor(() => expect(enqueueConnectionSync).toHaveBeenCalledWith('c-new'));
    expect(vi.mocked(enqueueConnectionSync).mock.invocationCallOrder[0]!)
      .toBeGreaterThan(remap.connectAnthropicConnection.mock.invocationCallOrder[0]!);
    vi.mocked(enqueueConnectionSync).mockClear();
    await rotateAnthropicKey({ partnerId: 'p1', connectionId: 'c1', apiKey: 'sk-ant-9999', userId: 'u1' });
    await vi.waitFor(() => expect(enqueueConnectionSync).toHaveBeenCalledWith('c1'));
    vi.mocked(enqueueConnectionSync).mockClear();
    remap.switchAnthropicConnectionKind.mockResolvedValue({ connectionId: 'c1', configVersion: 5 });
    await changeAnthropicEndpoint({ partnerId: 'p1', connectionId: 'c1', catalogEntryId: 'e1', acknowledgeDataNote: true, userId: 'u1' });
    await vi.waitFor(() => expect(enqueueConnectionSync).toHaveBeenCalledWith('c1'));
  });

  it('a failed enqueue (Redis down) never fails the committed save and never logs the key', async () => {
    vi.mocked(enqueueConnectionSync).mockRejectedValue(new Error('redis down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(createAnthropicKeyConnection({ partnerId: 'p1', apiKey: 'sk-ant-api03-secret-1234', userId: 'u1' }))
      .resolves.toMatchObject({ configVersion: 1 });
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(inspect(errors.mock.calls)).not.toContain('secret-1234');
    // Not silent: the failure reaches Sentry, tagged, still non-fatal.
    await vi.waitFor(() => expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'redis down' }), undefined, { service: 'aiModels', stage: 'enqueue' },
    ));
    errors.mockRestore();
  });
});
