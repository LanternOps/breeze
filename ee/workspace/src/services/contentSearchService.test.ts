import { describe, it, expect, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { WorkspaceDatabase } from '../hostTypes';
import { fuseRrf, ARM_WEIGHTS, createContentSearchService } from './contentSearchService';

describe('fuseRrf — weighted reciprocal rank fusion', () => {
  it('a rank-1 hit in a heavy arm beats a rank-1 hit in a light arm', () => {
    const fused = fuseRrf([
      { weight: ARM_WEIGHTS.ftsAnd, ids: ['deed'] },
      { weight: ARM_WEIGHTS.trigram, ids: ['near-name'] },
    ]);
    expect(fused[0].id).toBe('deed');
  });

  it('the Beat-3 shape: one FTS-AND hit outranks a deep trigram arm', () => {
    // scan_0034 is the sole AND match; a dozen Henderson-named files fill the
    // trigram arm. The single heavy hit must win the fusion.
    const trigramArm = Array.from({ length: 12 }, (_, i) => `henderson-file-${i}`);
    const fused = fuseRrf([
      { weight: ARM_WEIGHTS.ftsAnd, ids: ['scan_0034'] },
      { weight: ARM_WEIGHTS.trigram, ids: trigramArm },
      { weight: ARM_WEIGHTS.ftsOr, ids: [...trigramArm.slice(0, 5), 'scan_0034'] },
    ]);
    expect(fused[0].id).toBe('scan_0034');
  });

  it('membership in multiple arms accumulates', () => {
    const fused = fuseRrf([
      { weight: 1.0, ids: ['a', 'b'] },
      { weight: 1.0, ids: ['b', 'a'] },
      { weight: 0.8, ids: ['b'] },
    ]);
    expect(fused[0].id).toBe('b');
    // a: 1/61 + 1/62; b: 1/62 + 1/61 + 0.8/61 — b strictly higher
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('is deterministic for ties (stable id ordering)', () => {
    const fused = fuseRrf([{ weight: 1.0, ids: ['z'] }, { weight: 1.0, ids: ['m'] }]);
    expect(fused.map((f) => f.id)).toEqual(['m', 'z']);
  });

  it('returns empty for no arms or empty arms', () => {
    expect(fuseRrf([])).toEqual([]);
    expect(fuseRrf([{ weight: 2, ids: [] }])).toEqual([]);
  });
});

describe('contentSearchService.search — local-profile owner scoping', () => {
  function makeDb() {
    const executed: SQL[] = [];
    let call = 0;
    const db = {
      execute: vi.fn(async (query: SQL) => {
        executed.push(query);
        call += 1;
        // First execute is visibleSources(): one local-profile source.
        return call === 1
          ? [{ id: '55555555-5555-5555-5555-555555555555', display_name: 'Profiles', kind: 'local_profile', root_path: '/Users' }]
          : [];
      }),
    };
    return { db: db as unknown as WorkspaceDatabase, executed };
  }

  /** Every rendered arm that carries the local-profile owner predicate. */
  function ownerArms(executed: SQL[]) {
    const dialect = new PgDialect();
    return executed
      .map((q) => dialect.sqlToQuery(q))
      .flatMap((r) => {
        const m = r.sql.match(/fi\.rel_path ILIKE \$(\d+)( ESCAPE '\\')?/);
        return m ? [{ pattern: r.params[Number(m[1]) - 1], escaped: Boolean(m[2]) }] : [];
      });
  }

  it('escapes LIKE wildcards in the claimed ownerUsername and names the escape character', async () => {
    const { db, executed } = makeDb();
    await createContentSearchService(db).search(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
      { q: 'invoice', ownerUsername: '%a_b\\' },
    );
    const arms = ownerArms(executed);
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) {
      expect(arm).toEqual({ pattern: '\\%a\\_b\\\\/%', escaped: true });
    }
  });

  it('binds NULL (never matches) when no ownerUsername is claimed', async () => {
    const { db, executed } = makeDb();
    await createContentSearchService(db).search(
      '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
      { q: 'invoice' },
    );
    const arms = ownerArms(executed);
    expect(arms.length).toBeGreaterThan(0);
    for (const arm of arms) expect(arm.pattern).toBeNull();
  });
});
