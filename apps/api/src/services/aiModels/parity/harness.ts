/**
 * AI model registry parity harness (#7600 W02; reused by W03 with
 * resolveModel as the registry side). The legacy side is computed by the REAL
 * legacy functions (legacyOracle.ts); the registry side by whatever the
 * caller passes (W02: projectSurfaceUse over the materialized projection).
 */
import type { AiSurface } from '@breeze/shared';
import type { ListedProvider } from '../../llmProviderCatalog';
import type { LegacySnapshot } from '../legacyProjection';

export type SurfaceUse =
  | { outcome: 'ok'; destination: 'platform' | { connectionId: string }; funding: 'platform' | 'partner_key'; logicalModel: string; wireModel: string }
  | { outcome: 'unavailable'; reason: string };

export type ParityQuery =
  | { kind: 'surface'; surface: Exclude<AiSurface, 'ai_agents'>; orgId: string }
  | { kind: 'agent'; agentKind: string; orgId: string }
  | { kind: 'session'; sessionId: string };

export interface ParityFixture {
  name: string;
  env: Readonly<Record<string, string | undefined>>;
  snapshot: LegacySnapshot;
  /** Plaintext BYOK key; the test seals it under the legacy AAD for snapshot.config.id. */
  legacyApiKey: string | null;
  /** Seal the key under ANOTHER row's AAD, so the stored ciphertext fails to decrypt (an active config with an unreadable key). */
  legacyKeyUndecryptable?: boolean;
  catalogProvider: ListedProvider | null;
}

export interface ParityRow {
  fixture: string;
  query: ParityQuery;
  legacy: SurfaceUse;
  registry: SurfaceUse;
  divergence: string | null;
}

export function sameUse(a: SurfaceUse, b: SurfaceUse): boolean {
  if (a.outcome === 'unavailable' || b.outcome === 'unavailable') return a.outcome === b.outcome;
  const dest = (d: SurfaceUse & { outcome: 'ok' }) => (d.destination === 'platform' ? 'platform' : d.destination.connectionId);
  return dest(a) === dest(b) && a.funding === b.funding && a.logicalModel === b.logicalModel && a.wireModel === b.wireModel;
}

export interface ExpectedDivergence {
  id: string;
  why: string;
  applies(fixture: ParityFixture, query: ParityQuery, legacy: SurfaceUse, registry: SurfaceUse): boolean;
}

const isCatalog = (f: ParityFixture) => f.snapshot.config?.catalogEntryId != null;

/**
 * The oracle's reason when resolveLlmConfig itself is unavailable because the
 * partner DEFAULT is not mapped+verified on the catalog revision — distinct
 * from a per-surface resolveWireModel failure (`model_unverified`).
 */
export const PARTNER_DEFAULT_UNVERIFIED = 'partner_default_unverified';

/** The fixture's pinned partner default is not mapped AND verified on its catalog revision (a null default is checked by the resolver). */
const partnerDefaultUnverifiedOnCatalog = (f: ParityFixture): boolean => {
  const model = f.snapshot.config?.defaultModel;
  if (model == null) return true;
  const p = f.catalogProvider;
  return !p || !Object.hasOwn(p.modelMap, model) || !p.verifiedModels.includes(model);
};

export const EXPECTED_DIVERGENCES: readonly ExpectedDivergence[] = [
  {
    id: 'catalog_refused_surfaces',
    why: 'Legacy refuses catalog partners on ai_agents (no resolveWireModel / egress proxy) and extension_content (buildAnthropicClient). Spec §9: every surface resolves the catalog offering from W03.',
    applies: (f, q, legacy, registry) =>
      isCatalog(f)
      && legacy.outcome === 'unavailable' && legacy.reason === 'catalog_refused'
      && registry.outcome === 'ok'
      && (q.kind === 'agent' || (q.kind === 'surface' && q.surface === 'extension_content')),
  },
  {
    id: 'catalog_partner_default_unverified',
    why: 'Legacy resolveLlmConfig disables every surface when the partner DEFAULT is not verified on the catalog revision; the registry resolves each surface\'s own offering (spec §9 eligibility is per offering).',
    applies: (f, _q, legacy, registry) =>
      isCatalog(f)
      && partnerDefaultUnverifiedOnCatalog(f)
      && legacy.outcome === 'unavailable' && legacy.reason === PARTNER_DEFAULT_UNVERIFIED
      && registry.outcome === 'ok',
  },
];

export async function runParity(
  fixture: ParityFixture,
  queries: readonly ParityQuery[],
  legacySide: (f: ParityFixture, q: ParityQuery) => Promise<SurfaceUse>,
  registrySide: (f: ParityFixture, q: ParityQuery) => Promise<SurfaceUse> | SurfaceUse,
): Promise<ParityRow[]> {
  const rows: ParityRow[] = [];
  for (const query of queries) {
    const legacy = await legacySide(fixture, query);
    const registry = await registrySide(fixture, query);
    const divergence = sameUse(legacy, registry)
      ? null
      : EXPECTED_DIVERGENCES.find((d) => d.applies(fixture, query, legacy, registry))?.id ?? 'UNEXPECTED';
    rows.push({ fixture: fixture.name, query, legacy, registry, divergence });
  }
  return rows;
}

export function parityQueries(fixture: ParityFixture): ParityQuery[] {
  const surfaces = ['chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat', 'office_ticket',
    'catalog_enrichment', 'extension_content', 'patch_test'] as const;
  const queries: ParityQuery[] = [];
  for (const orgId of fixture.snapshot.orgIds) {
    for (const surface of surfaces) queries.push({ kind: 'surface', surface, orgId });
    for (const agent of fixture.snapshot.agents.filter((a) => a.orgId === null)) {
      queries.push({ kind: 'agent', agentKind: agent.kind, orgId });
    }
  }
  for (const session of fixture.snapshot.liveSessions) queries.push({ kind: 'session', sessionId: session.id });
  return queries;
}
