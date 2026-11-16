import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn() }, withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn() }));
import { db } from '../db';
import { resolveSnapshotProviderConfig } from './recoveryBootstrap';

function rows(value: unknown[]) {
  return { from: () => ({ where: () => ({ limit: async () => value }) }) } as any;
}
const snapshot = { id: 'snapshot', orgId: 'org-a', configId: 'config-a', jobId: null, metadata: {} };
const config = { id: 'config-a', orgId: 'org-a', provider: 'local', providerConfig: { path: 'C:\\Endpoint\\Backups' } };

describe('local storage mapping authority', () => {
  beforeEach(() => vi.mocked(db.select).mockReset());

  it('grants a host mapping from the snapshot-owned configuration row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(rows([snapshot])).mockReturnValueOnce(rows([config]));
    expect((await resolveSnapshotProviderConfig('snapshot'))?.localConfigId).toBe('config-a');
  });

  it.each([
    { ...snapshot, configId: null, metadata: { configId: 'config-a' } },
    { ...snapshot },
  ])('does not grant a host mapping from metadata or a cross-org row', async (record) => {
    const selected = record.configId ? { ...config, orgId: 'org-b' } : config;
    vi.mocked(db.select).mockReturnValueOnce(rows([record])).mockReturnValueOnce(rows([selected]));
    expect((await resolveSnapshotProviderConfig('snapshot'))?.localConfigId).toBeUndefined();
  });

  it('denies a deleted destination even if settings survive in snapshot metadata', async () => {
    vi.mocked(db.select).mockReturnValueOnce(rows([{ ...snapshot, metadata: { provider: 'local', providerConfig: config.providerConfig } }])).mockReturnValueOnce(rows([]));
    expect((await resolveSnapshotProviderConfig('snapshot'))?.localConfigId).toBeUndefined();
  });

  it('allows an authoritative same-org job relation when the snapshot lacks configId', async () => {
    vi.mocked(db.select).mockReturnValueOnce(rows([{ ...snapshot, configId: null, jobId: 'job-a' }]))
      .mockReturnValueOnce(rows([{ configId: 'config-a' }])).mockReturnValueOnce(rows([config]));
    expect((await resolveSnapshotProviderConfig('snapshot'))?.localConfigId).toBe('config-a');
  });
});
