import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', async () => (await import('./legacyFixtureMocks')).legacyDbMockModule());
vi.mock('../../llmProviderCatalog', async () => (await import('./legacyFixtureMocks')).legacyCatalogMockModule());
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: vi.fn() }));
vi.mock('../../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { buildDesiredRegistryState } from '../legacyProjection';
import { bindLegacyFixture } from './bindLegacyFixture';
import { PARITY_FIXTURES } from './fixtures';
import { EXPECTED_DIVERGENCES, PARTNER_DEFAULT_UNVERIFIED, parityQueries, runParity, type ParityFixture, type ParityRow } from './harness';

const ORG_A = '70000000-0000-4000-8000-0000000000a1';
const ORG_B = '70000000-0000-4000-8000-0000000000b1';
import { legacySurfaceUse, withFixtureEnv } from './legacyOracle';
import { projectionEnvFor } from './projectionEnv';
import { materializeDesiredState, projectSurfaceUse } from './storeProjection';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'parity-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'parity-test';
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
});

async function parityFor(f: ParityFixture, snapshotOverride?: ParityFixture['snapshot']): Promise<ParityRow[]> {
  const sealed = bindLegacyFixture(f);
  const projected: ParityFixture = snapshotOverride ? { ...f, snapshot: snapshotOverride } : f;
  const store = materializeDesiredState(buildDesiredRegistryState(projected.snapshot, projectionEnvFor(f)), projected, projected.snapshot.config ? sealed : null);
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

  it('every declared divergence actually occurs (no stale allowlist), exactly where expected', async () => {
    const label = (r: ParityRow): string => {
      const q = r.query;
      const at = (orgId: string) => (orgId === ORG_A ? 'A' : orgId === ORG_B ? 'B' : orgId);
      const what = q.kind === 'surface' ? `${q.surface}@${at(q.orgId)}` : q.kind === 'agent' ? `agent:${q.agentKind}@${at(q.orgId)}` : `session:${q.sessionId}`;
      return `${r.divergence} ${r.fixture} ${what}`;
    };
    const seen: string[] = [];
    for (const f of PARITY_FIXTURES) for (const r of await parityFor(f)) if (r.divergence) seen.push(label(r));
    expect(seen.sort()).toEqual([
      'catalog_partner_default_unverified catalog_default_unverified extension_content@A',
      'catalog_partner_default_unverified catalog_default_unverified extension_content@B',
      'catalog_partner_default_unverified catalog_default_unverified script_reviewer@A',
      'catalog_partner_default_unverified catalog_default_unverified script_reviewer@B',
      'catalog_refused_surfaces byok_catalog_verified agent:patch@A',
      'catalog_refused_surfaces byok_catalog_verified agent:patch@B',
      'catalog_refused_surfaces byok_catalog_verified agent:triage@A',
      'catalog_refused_surfaces byok_catalog_verified extension_content@A',
      'catalog_refused_surfaces byok_catalog_verified extension_content@B',
    ]);
    expect([...new Set(seen.map((s) => s.split(' ')[0]))].sort()).toEqual(EXPECTED_DIVERGENCES.map((d) => d.id).sort());
  });

  it('catalog_partner_default_unverified does not swallow a per-surface unverified model', () => {
    const f = PARITY_FIXTURES.find((x) => x.name === 'byok_catalog_verified')!;
    const q = { kind: 'surface', surface: 'office_chat', orgId: ORG_A } as const;
    const ok = { outcome: 'ok', destination: 'platform', funding: 'platform', logicalModel: 'm', wireModel: 'm' } as const;
    const d = EXPECTED_DIVERGENCES.find((x) => x.id === 'catalog_partner_default_unverified')!;
    // A surface-level resolveWireModel failure (legacy reason model_unverified) is never explained away…
    expect(d.applies(f, q, { outcome: 'unavailable', reason: 'model_unverified' }, ok)).toBe(false);
    // …and nor is the config-level reason on a fixture whose default IS verified.
    expect(d.applies(f, q, { outcome: 'unavailable', reason: PARTNER_DEFAULT_UNVERIFIED }, ok)).toBe(false);
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

  it('an ACTIVE BYOK config whose key fails to decrypt is unavailable on BOTH sides and never re-pointed to the platform', async () => {
    const f = PARITY_FIXTURES.find((x) => x.name === 'byok_active_key_undecryptable')!;
    const rows = await parityFor(f);
    const nonPatch = rows.filter((r) => !(r.query.kind === 'surface' && r.query.surface === 'patch_test'));
    expect(nonPatch.length).toBeGreaterThan(0);
    for (const r of nonPatch) {
      expect(r.legacy).toMatchObject({ outcome: 'unavailable' });
      expect(r.registry).toEqual({ outcome: 'unavailable', reason: 'key_error' });
      expect(r.divergence).toBeNull();
    }
    // The projection kept every partner-destination surface on the connection.
    const desired = buildDesiredRegistryState(f.snapshot, projectionEnvFor(f));
    for (const a of desired.assignments.filter((x) => x.orgId === null && x.surface !== 'patch_test')) {
      expect(a.defaultOfferingKey).toMatch(/^conn:/);
    }
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
