import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny in-memory stand-in for the cutover table; registryCutover.ts reaches it
// only through the two helpers below, which it imports from './registryCutoverStore'.
const store = vi.hoisted(() => ({ rows: new Set<string>() }));
vi.mock('./registryCutoverStore', () => ({
  hasCutoverRow: vi.fn(async (id: string) => store.rows.has(id)),
  withPartnerCutoverTx: vi.fn(async (id: string, fn: (exists: boolean) => Promise<void>) => {
    const exists = store.rows.has(id);
    await fn(exists);   // a throw here aborts the "transaction": no row
    if (!exists) store.rows.add(id);
  }),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./registryBootstrap', () => ({ bootstrapPartnerRegistryInTx: vi.fn() }));

import { __resetRegistryCutoverMemoForTests, cutoverPartner, ensurePartnerCutover, isPartnerCutOver } from './registryCutover';
import * as registryCutoverModule from './registryCutover';
import { bootstrapPartnerRegistryInTx } from './registryBootstrap';
import { captureException, captureMessage } from '../sentry';

const report = (over: Record<string, unknown> = {}) => ({
  destination: 'platform', connectionId: null, defaultModelId: 'model-a', offeringId: 'off-1',
  platformOfferingId: 'off-1', assignmentsCreated: 10, createdPlatformRow: false, ...over,
});

beforeEach(() => {
  store.rows.clear();
  __resetRegistryCutoverMemoForTests();
  vi.clearAllMocks();
  vi.mocked(bootstrapPartnerRegistryInTx).mockResolvedValue(report() as never);
});

describe('registry gate (W08: bootstrap, no legacy projection)', () => {
  it('bootstraps a partner with no cutover row exactly once', async () => {
    const bootstrapInTx = vi.fn(async () => report());
    expect(await cutoverPartner('p1', { bootstrapInTx: bootstrapInTx as never })).toBe('done');
    expect(await cutoverPartner('p1', { bootstrapInTx: bootstrapInTx as never })).toBe('already');
    expect(bootstrapInTx).toHaveBeenCalledTimes(1);
  });

  it('a platform bootstrap is not reported', async () => {
    await cutoverPartner('p1');
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports a partner that was bootstrapped onto an existing connection (its legacy settings were never projected)', async () => {
    const bootstrapInTx = vi.fn(async () => report({ destination: 'connection', connectionId: 'c1' }));
    await cutoverPartner('p2', { bootstrapInTx: bootstrapInTx as never });
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('bootstrapped onto its existing AI connection'),
      expect.objectContaining({ eventCode: 'ai_registry_bootstrap_existing_connection' }),
    );
  });

  it('reports an ambiguous (several connections) bootstrap as an exception', async () => {
    const bootstrapInTx = vi.fn(async () => report({ destination: 'ambiguous', offeringId: null }));
    await cutoverPartner('p4', { bootstrapInTx: bootstrapInTx as never });
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('fail closed') }),
      undefined,
      expect.objectContaining({ area: 'ai_model_registry_cutover', partnerId: 'p4' }),
    );
  });

  it('ensurePartnerCutover resolves false (never throws) and reports when the bootstrap fails; the next call retries', async () => {
    vi.mocked(bootstrapPartnerRegistryInTx).mockRejectedValueOnce(new Error('boom'));
    expect(await ensurePartnerCutover('p3')).toBe(false);
    expect(captureException).toHaveBeenCalled();
    expect(store.rows.has('p3')).toBe(false);
    expect(await isPartnerCutOver('p3')).toBe(false);
    expect(await ensurePartnerCutover('p3')).toBe(true);
    expect(store.rows.has('p3')).toBe(true);
  });

  it('a query-bearing failure reaches Sentry scrubbed: no SQL params', async () => {
    const drizzle = Object.assign(new Error('Failed query: insert into x\nparams: sk-secret-ciphertext'), {
      params: ['sk-secret-ciphertext'],
      cause: Object.assign(new Error('duplicate key value violates unique constraint "x_pk"'), { code: '23505', constraint_name: 'x_pk' }),
    });
    vi.mocked(bootstrapPartnerRegistryInTx).mockRejectedValueOnce(drizzle);
    expect(await ensurePartnerCutover('p1')).toBe(false);
    expect(captureException).toHaveBeenCalledTimes(1);
    const [reported, , tags] = vi.mocked(captureException).mock.calls[0]!;
    expect(reported).not.toBe(drizzle);
    expect(String((reported as Error).message)).not.toContain('sk-secret-ciphertext');
    expect(String((reported as Error).message)).toContain('23505');
    expect(tags).toMatchObject({ area: 'ai_model_registry_cutover', partnerId: 'p1' });
  });

  it('the W03 boot sweep is gone', () => {
    expect('runRegistryCutoverSweep' in registryCutoverModule).toBe(false);
    expect('runRegistryCutoverSweepWithRetry' in registryCutoverModule).toBe(false);
    expect('REGISTRY_CUTOVER_RETRY_DELAYS_MS' in registryCutoverModule).toBe(false);
  });
});
