/**
 * Deterministic generated input for equivalence tests that compare a pattern
 * with the one it replaced.
 */

/** mulberry32: 32-bit integer steps (Math.imul), so the sequence does not
 *  collapse the way a float LCG does. Returns unsigned 32-bit integers. */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const RUN_CHARS = ['a', 'Z', '0', '_', '-', 'e', 'y', 'J'];

/**
 * Text made of compact-JWT-shaped pieces: whole `eyJ…\.…\.…` tokens with
 * segment lengths around the patterns' minimums, `eyJ`-prefixed and plain
 * base64url runs, dots and separators. A good share of inputs hold a token
 * each JWT pattern accepts, and many hold near misses.
 */
export function tokenShapedText(next: () => number, maxPieces = 8, maxRun = 32): string {
  const run = (min = 0, max = maxRun) => {
    let out = '';
    for (let n = min + (next() % (max - min + 1)); n > 0; n -= 1) out += RUN_CHARS[next() % RUN_CHARS.length];
    return out;
  };
  const token = () => `eyJ${run(5, 30)}.${next() % 2 ? 'eyJ' : ''}${run(5, 30)}.${run(0, 20)}`;
  let text = '';
  for (let pieces = 1 + (next() % maxPieces); pieces > 0; pieces -= 1) {
    switch (next() % 10) {
      case 0: case 1: case 2: text += token(); break;
      case 3: case 4: text += `eyJ${run()}`; break;
      case 5: text += run(); break;
      case 6: text += '.'; break;
      case 7: text += '-'; break;
      case 8: text += ' '; break;
      default: text += ['\n', '!', 'eyJ', '+', '/'][next() % 5]; break;
    }
  }
  return text;
}

/** Every match of `pattern` (made global) in `text`, as [index, match]. */
export function matchSpans(pattern: RegExp, text: string): Array<[number, string]> {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((m) => [m.index ?? 0, m[0]]);
}

/** Inputs for the JWT pattern timing tests (each about 80,000 characters). */
export const LONG_TOKEN_RUNS: readonly string[] = [
  '-eyJ'.repeat(20_000),
  'eyJ'.repeat(26_000),
  `${'-eyJ'.repeat(20_000)}.x`,
  `-eyJ${'a'.repeat(30)}`.repeat(2_300),
  `${'a'.repeat(80_000)}eyJ`,
  'eyJa-'.repeat(16_000),
  '_'.repeat(80_000),
  'a-'.repeat(40_000),
];
