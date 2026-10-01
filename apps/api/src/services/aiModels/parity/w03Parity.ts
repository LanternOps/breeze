/**
 * W03 parity (#7601): the REAL resolveModel against the legacy routing frozen
 * by w03Goldens.test.ts, through W02's harness (#7600 Task 11) — same
 * fixtures, same queries, same comparison rule (`sameUse`), same declared
 * divergences. Only the legacy side changed: a golden lookup instead of the
 * legacy code, which W03 deletes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ResolveModelResult } from '../resolveModel';
import { PARITY_FIXTURES } from './fixtures';
import { parityQueries, runParity, sameUse, type ParityFixture, type ParityQuery, type SurfaceUse } from './harness';
import { projectSurfaceUse, type RegistrySnapshot } from './storeProjection';

export const W03_GOLDENS_PATH = join(__dirname, 'w03Goldens.json');
export type W03Goldens = Record<string, Record<string, SurfaceUse>>;

export function queryKey(q: ParityQuery): string {
  switch (q.kind) {
    case 'surface': return `surface:${q.surface}:${q.orgId}`;
    case 'agent': return `agent:${q.agentKind}:${q.orgId}`;
    case 'session': return `session:${q.sessionId}`;
  }
}

export function loadW03Goldens(): W03Goldens {
  return JSON.parse(readFileSync(W03_GOLDENS_PATH, 'utf8')) as W03Goldens;
}

/** The resolver's answer as the harness's comparison tuple (destination, funding, logical + wire model). */
export function toSurfaceUse(r: ResolveModelResult): SurfaceUse {
  if (!r.ok) return { outcome: 'unavailable', reason: r.reason };
  return {
    outcome: 'ok',
    destination: r.connection.id === null ? 'platform' : { connectionId: r.connection.id },
    funding: r.funding,
    logicalModel: r.logicalModel,
    wireModel: r.wireModel,
  };
}

/**
 * W02's runParity with the frozen goldens as the legacy side. Fails on any
 * UNEXPECTED divergence, AND (review finding 13) on a DECLARED divergence whose
 * registry answer is not exactly W02's projected registry answer for that query.
 * W02's `applies()` accepts any `ok`; that alone would pass a catalog surface
 * resolved to the platform, or to the wrong model.
 */
export async function assertSurfaceParity(opts: {
  select: (q: ParityQuery) => boolean;
  /** Binds the resolver's data adapters to this fixture and returns the snapshot they read. */
  bind: (fixture: ParityFixture) => RegistrySnapshot | Promise<RegistrySnapshot>;
  registrySide: (fixture: ParityFixture, q: ParityQuery) => Promise<SurfaceUse>;
  /** Mutation self-tests only: override the frozen legacy side. */
  legacySide?: (fixture: ParityFixture, q: ParityQuery) => SurfaceUse;
}): Promise<void> {
  const goldens = loadW03Goldens();
  const failures: string[] = [];
  let compared = 0;
  for (const fixture of PARITY_FIXTURES) {
    const store = await opts.bind(fixture);
    const rows = await runParity(
      fixture,
      parityQueries(fixture).filter(opts.select),
      async (f, q) => {
        if (opts.legacySide) return opts.legacySide(f, q);
        const golden = goldens[f.name]?.[queryKey(q)];
        if (!golden) throw new Error(`no W03 golden for ${f.name} ${queryKey(q)}`);
        return golden;
      },
      opts.registrySide,
    );
    compared += rows.length;
    for (const row of rows) {
      const at = `${row.fixture} ${queryKey(row.query)}`;
      if (row.divergence === 'UNEXPECTED') {
        failures.push(`${at} [UNEXPECTED]: legacy ${JSON.stringify(row.legacy)} vs registry ${JSON.stringify(row.registry)}`);
      } else if (row.divergence !== null) {
        // Declared divergence: the registry answer must be the EXACT projected tuple
        // (destination, funding, logical model, wire model), not merely `ok`.
        const projected = projectSurfaceUse(store, row.query);
        if (projected.outcome !== 'ok' || !sameUse(row.registry, projected)) {
          failures.push(`${at} [${row.divergence}]: registry ${JSON.stringify(row.registry)} vs projected ${JSON.stringify(projected)}`);
        }
      }
    }
  }
  expect(compared, 'the selector matched no parity query').toBeGreaterThan(0);
  expect(failures, `parity failures:\n${failures.join('\n')}`).toEqual([]);
}
