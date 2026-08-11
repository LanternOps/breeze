import { describe, it, expect } from 'vitest';
import { fuseRrf, ARM_WEIGHTS } from './contentSearchService';

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
