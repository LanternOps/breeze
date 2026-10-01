/**
 * W03 per-surface parity (#7601, quorum #14): for every W02 fixture shape and
 * query, the REAL resolver's destination, funding, logical model and wire model
 * equal the frozen legacy route, except W02's two declared divergences (which
 * must equal W02's projected tuple exactly). The resolver's data adapters are
 * backed by W02's materialized RegistrySnapshot (registrySnapshotDeps.ts).
 * One describe per surface; Tasks 10–14 append theirs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ── hoisted mock block: written ONCE for every surface in this file ──
const h = vi.hoisted(() => {
  const state: { deps: Record<string, (...a: unknown[]) => unknown> | null } = { deps: null };
  const call = (k: string) => (...a: unknown[]) => {
    if (!state.deps) throw new Error(`parity adapter '${k}' called before a fixture was bound`);
    return state.deps[k]!(...a);
  };
  return { state, call };
});
// Every resolver read goes through the snapshot adapters below; a DB read that
// slips past them must fail loudly, never return something.
vi.mock('../../../db', () => ({
  db: new Proxy({}, { get: (_t, k) => { if (k === 'then') return undefined; throw new Error(`parity: unexpected db.${String(k)}`); } }),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => undefined,
}));
vi.mock('../../sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../registryCutover', async (orig) => ({
  ...(await orig<typeof import('../registryCutover')>()), ensurePartnerCutover: async () => true,
}));
vi.mock('../offerings', async (orig) => ({
  ...(await orig<typeof import('../offerings')>()), getOffering: h.call('getOffering'),
}));
vi.mock('../connections', async (orig) => ({
  ...(await orig<typeof import('../connections')>()),
  getConnection: h.call('getConnection'), getConnectionKeyMaterial: h.call('getConnectionKeyMaterial'),
}));
vi.mock('../platformModels', async (orig) => ({
  ...(await orig<typeof import('../platformModels')>()),
  getPlatformModelById: h.call('getPlatformModelById'), getPlatformModelByModelId: h.call('getPlatformModelByModelId'),
  getPlatformDefaultModel: async () => { throw new Error('parity: no platform-only surface is compared here'); },
  getPlatformInferenceGeo: async () => null,
}));
vi.mock('../../llmProviderCatalog', async (orig) => ({
  ...(await orig<typeof import('../../llmProviderCatalog')>()), getListedProviderByEntryId: h.call('getListedProviderByEntryId'),
}));
vi.mock('../assignments', async (orig) => ({
  ...(await orig<typeof import('../assignments')>()), getEffectiveAssignment: h.call('getEffectiveAssignment'),
}));
vi.mock('../candidateLoader', async (orig) => ({
  ...(await orig<typeof import('../candidateLoader')>()),
  loadPartnerFacts: h.call('loadPartnerFacts'), readOrgPartnerId: h.call('readOrgPartnerId'),
  readSessionModelRow: h.call('readSessionModelRow'),
  // No fixture offering carries a required permission, so the predicate cannot route.
  loadUserPermissionPredicate: async () => () => false,
}));
// ──────────────────────────────────────────────────────────────────────

import type { AiSurface } from '@breeze/shared';
import { resolveModel } from '../resolveModel';
import { resolveSessionTurn } from '../sessionModel';
import type { ParityFixture, ParityQuery } from './harness';
import { snapshotDeps, storeFor } from './registrySnapshotDeps';
import { assertSurfaceParity, loadW03Goldens, queryKey, toSurfaceUse } from './w03Parity';

const SAVED_ENV = { ...process.env };
beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = 'parity-unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'parity-test';
  process.env.LLM_PROVIDER_CATALOG_ENABLED = 'true';
  // The deployment the goldens describe has a platform key configured.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-parity-platform-key';
  delete process.env.AI_PLATFORM_INFERENCE_GEO;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED_ENV)) delete process.env[k];
  Object.assign(process.env, SAVED_ENV);
});

const bind = (fixture: ParityFixture) => {
  const store = storeFor(fixture);
  h.state.deps = snapshotDeps(store, fixture) as unknown as Record<string, (...a: unknown[]) => unknown>;
  return store;
};
const surfaceQuery = (surface: AiSurface) => (q: ParityQuery) => q.kind === 'surface' && q.surface === surface;
const viaAssignment = (surface: AiSurface, userInitiated: boolean) => async (fixture: ParityFixture, q: ParityQuery) => {
  if (q.kind !== 'surface') throw new Error(`viaAssignment(${surface}) got a ${q.kind} query`);
  return toSurfaceUse(await resolveModel({
    partnerId: fixture.snapshot.partnerId, orgId: q.orgId, surface,
    ...(userInitiated ? { userId: 'parity-user' } : {}),
  }));
};

/**
 * Surface queries. Were blocked on two W02 projection gaps, fixed in #7601:
 * the env-bootstrapped platform row is offered at the legacy rate
 * (ensureLegacyPlatformModel), and unknown capabilities on an Anthropic
 * connection resolve to tool use + the W00 thinking rules (candidateLoader).
 */
const surfaceParity = it;

describe('W03 parity: chat + topology (assignment route and stored sessions)', () => {
  surfaceParity('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('chat'), bind, registrySide: viaAssignment('chat', true) });
  });
  it('session queries (a stored session re-resolved per turn)', async () => {
    await assertSurfaceParity({
      select: (q) => q.kind === 'session',
      bind,
      registrySide: async (_f, q) => {
        if (q.kind !== 'session') throw new Error('expected a session query');
        return toSurfaceUse(await resolveSessionTurn({ sessionId: q.sessionId, surface: 'chat', userId: 'parity-user' }));
      },
    });
  });
});

describe('W03 parity: helper', () => {
  surfaceParity('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('helper'), bind, registrySide: viaAssignment('helper', false) });
  });
});

describe('W03 parity: script_builder', () => {
  surfaceParity('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('script_builder'), bind, registrySide: viaAssignment('script_builder', true) });
  });
});

describe('W03 parity: office_chat', () => {
  surfaceParity('surface queries', async () => {
    await assertSurfaceParity({ select: surfaceQuery('office_chat'), bind, registrySide: viaAssignment('office_chat', false) });
  });
});

describe('W03 parity harness discriminates (mutations that MUST fail)', () => {
  const chatSide = viaAssignment('chat', true);

  it('a registry side that forces platform funding fails', async () => {
    await expect(assertSurfaceParity({
      select: surfaceQuery('chat'), bind,
      registrySide: async (f, q) => {
        const u = await chatSide(f, q);
        return u.outcome === 'ok' ? { ...u, destination: 'platform', funding: 'platform' } : u;
      },
    })).rejects.toThrow(/byok_direct_pinned surface:chat:\S+ \[UNEXPECTED\]/);
  });

  it('an entrypoint that resolves the WRONG surface fails (chat answered as patch_test: BYOK chat vs platform patch_test)', async () => {
    await expect(assertSurfaceParity({
      select: surfaceQuery('chat'), bind,
      registrySide: async (f, q) => {
        if (q.kind !== 'surface') throw new Error('expected a surface query');
        const golden = loadW03Goldens()[f.name]?.[queryKey({ kind: 'surface', surface: 'patch_test', orgId: q.orgId })];
        if (!golden) throw new Error(`no patch_test golden for ${f.name}`);
        return golden;
      },
    })).rejects.toThrow(/byok_direct_pinned surface:chat:\S+ \[UNEXPECTED\]/);
  });

  it('a declared catalog divergence resolved to the wrong destination fails (any-ok is not enough)', async () => {
    // Only the declared catalog_refused rows are mutated, so the ONLY thing that
    // can fail is the exact-projection check on a declared divergence.
    const extensionSide = viaAssignment('extension_content', false);
    const goldens = loadW03Goldens();
    await expect(assertSurfaceParity({
      select: surfaceQuery('extension_content'), bind,
      registrySide: async (f, q) => {
        const u = await extensionSide(f, q);
        const declared = goldens[f.name]?.[queryKey(q)];
        const refused = declared?.outcome === 'unavailable' && declared.reason === 'catalog_refused';
        return refused && u.outcome === 'ok' ? { ...u, destination: 'platform', funding: 'platform' } : u;
      },
    })).rejects.toThrow(/byok_catalog_verified surface:extension_content:\S+ \[catalog_refused_surfaces\]: registry .*"destination":"platform"/);
  });
});
