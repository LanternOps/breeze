import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', async () => (await import('./legacyFixtureMocks')).legacyDbMockModule());
vi.mock('../../llmProviderCatalog', async () => (await import('./legacyFixtureMocks')).legacyCatalogMockModule());
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
vi.mock('../../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildDesiredRegistryState } from '../legacyProjection';
import { bindLegacyFixture } from './bindLegacyFixture';
import { PARITY_FIXTURES } from './fixtures';
import { EXPECTED_DIVERGENCES, parityQueries, runParity, type ParityFixture, type ParityRow } from './harness';
import { legacySurfaceUse, withFixtureEnv } from './legacyOracle';
import { projectionEnvFor } from './projectionEnv';
import { materializeDesiredState, projectSurfaceUse } from './storeProjection';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'parity-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'parity-test';
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
});

async function parityFor(f: ParityFixture, snapshotOverride?: ParityFixture['snapshot']): Promise<ParityRow[]> {
  bindLegacyFixture(f);
  const projected: ParityFixture = snapshotOverride ? { ...f, snapshot: snapshotOverride } : f;
  const store = materializeDesiredState(buildDesiredRegistryState(projected.snapshot, projectionEnvFor(f)), projected);
  return withFixtureEnv(f.env, () =>
    runParity(f, parityQueries(f), legacySurfaceUse, (_f, q) => projectSurfaceUse(store, q)));
}

describe('AI model registry parity: projection vs the real legacy path (#7600 W02, spec §10)', () => {
  it.each(PARITY_FIXTURES.map((f) => [f.name, f] as const))('%s: every surface keeps destination, funding and model', async (_name, f) => {
    const rows = await parityFor(f);
    expect(rows.length).toBeGreaterThan(0);
    const unexpected = rows.filter((r) => r.divergence === 'UNEXPECTED');
    expect(unexpected, JSON.stringify(unexpected, null, 2)).toEqual([]);
  });

  it('every declared divergence actually occurs (no stale allowlist)', async () => {
    const seen = new Set<string>();
    for (const f of PARITY_FIXTURES) for (const r of await parityFor(f)) if (r.divergence) seen.add(r.divergence);
    expect([...seen].sort()).toEqual(EXPECTED_DIVERGENCES.map((d) => d.id).sort());
  });

  it('is discriminating: a projection that moves BYOK chat to the platform key is caught', async () => {
    const f = PARITY_FIXTURES.find((x) => x.name === 'byok_direct_pinned')!;
    const rows = await parityFor(f, { ...f.snapshot, config: null });
    expect(rows.some((r) => r.divergence === 'UNEXPECTED')).toBe(true);
  });

  it('the oracle itself is faithful: errored BYOK fails closed with key_error, catalog agents are refused', async () => {
    const errored = await parityFor(PARITY_FIXTURES.find((x) => x.name === 'byok_errored')!);
    const nonPatch = errored.filter((r) => !(r.query.kind === 'surface' && r.query.surface === 'patch_test'));
    expect(nonPatch.length).toBeGreaterThan(0);
    for (const r of nonPatch) expect(r.legacy).toEqual({ outcome: 'unavailable', reason: 'key_error' });

    const catalogAgents = (await parityFor(PARITY_FIXTURES.find((x) => x.name === 'byok_catalog_verified')!))
      .filter((r) => r.query.kind === 'agent');
    expect(catalogAgents.length).toBeGreaterThan(0);
    for (const r of catalogAgents) expect(r.legacy).toEqual({ outcome: 'unavailable', reason: 'catalog_refused' });
  });

  it('projectionEnvFor reads the fixture env, never process.env (W03 reuses it)', () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = 'process-env-must-not-leak';
    try {
      const f = PARITY_FIXTURES.find((x) => x.name === 'no_config_env_overrides')!;
      expect(projectionEnvFor(f)).toMatchObject({ defaultModel: 'claude-opus-5-5', reviewerModel: 'claude-haiku-4-5', extensionModel: 'claude-sonnet-4-6' });
      expect(projectionEnvFor(PARITY_FIXTURES.find((x) => x.name === 'no_config')!).defaultModel).not.toBe('process-env-must-not-leak');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL; else process.env.ANTHROPIC_MODEL = saved;
    }
  });
});
