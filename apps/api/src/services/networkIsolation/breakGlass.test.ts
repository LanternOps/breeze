import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakGlassCode, currentBreakGlassCodes, generateEpisodeSecret } from './breakGlass';

interface Vector {
  description: string;
  secretHex: string;
  isolationId: string;
  generation: number;
  hourBucket: number;
  message: string;
  code: string;
}

// Shared with the agent (W1d): generated once by an independent reference implementation.
const VECTORS_FILE = resolve(__dirname, '../../../../../agent/internal/isolation/testdata/breakglass_vectors.json');
const { vectors } = JSON.parse(readFileSync(VECTORS_FILE, 'utf8')) as { vectors: Vector[] };

const ISOLATION_ID = '6f1c2a9e-4b3d-4c5e-8f70-1a2b3c4d5e6f';

describe('breakGlassCode — shared vectors', () => {
  it('covers the cases the plan names', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
    expect(vectors.some((v) => /^0+$/.test(v.secretHex))).toBe(true);
    expect(new Set(vectors.map((v) => v.generation))).toEqual(new Set([1, 2, 7]));
    expect(vectors.some((v) => v.hourBucket === 0)).toBe(true);
    expect(vectors.some((v) => v.hourBucket === 493000)).toBe(true);
    expect(vectors.some((v) => v.isolationId !== v.isolationId.toLowerCase())).toBe(true);
  });

  it.each(vectors.map((v) => [v.description, v] as const))('%s', (_desc, v) => {
    const code = breakGlassCode(Buffer.from(v.secretHex, 'hex'), v.isolationId, v.generation, v.hourBucket);
    expect(code).toBe(v.code);
    expect(code).toMatch(/^[A-Z2-7]{8}$/);
  });
});

describe('breakGlassCode — inputs', () => {
  const secret = Buffer.alloc(32, 1);

  it('lowercases the isolation id before signing', () => {
    expect(breakGlassCode(secret, ISOLATION_ID.toUpperCase(), 3, 10)).toBe(breakGlassCode(secret, ISOLATION_ID, 3, 10));
  });

  it('binds the generation and the hour bucket', () => {
    const base = breakGlassCode(secret, ISOLATION_ID, 1, 493000);
    expect(breakGlassCode(secret, ISOLATION_ID, 2, 493000)).not.toBe(base);
    expect(breakGlassCode(secret, ISOLATION_ID, 1, 493001)).not.toBe(base);
  });

  it('refuses a secret that is not 32 bytes, a bad id, generation or bucket', () => {
    expect(() => breakGlassCode(Buffer.alloc(31), ISOLATION_ID, 1, 0)).toThrow(/32 bytes/);
    expect(() => breakGlassCode(Buffer.alloc(33), ISOLATION_ID, 1, 0)).toThrow(/32 bytes/);
    expect(() => breakGlassCode(secret, 'not-a-uuid', 1, 0)).toThrow(/isolationId/);
    expect(() => breakGlassCode(secret, `${ISOLATION_ID}|9|9`, 1, 0)).toThrow(/isolationId/);
    for (const generation of [0, -1, 1.5, Number.NaN]) {
      expect(() => breakGlassCode(secret, ISOLATION_ID, generation, 0), String(generation)).toThrow(/generation/);
    }
    for (const bucket of [-1, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => breakGlassCode(secret, ISOLATION_ID, 1, bucket), String(bucket)).toThrow(/hourBucket/);
    }
  });
});

describe('currentBreakGlassCodes', () => {
  const secret = Buffer.alloc(32, 9);

  it('returns this hour and the next hour, valid until the hour boundary', () => {
    const now = new Date(Date.UTC(2026, 10, 1, 12, 34, 56, 789));
    const bucket = Math.floor(now.getTime() / 3_600_000);
    const codes = currentBreakGlassCodes(secret, ISOLATION_ID, 4, now);
    expect(codes.current).toBe(breakGlassCode(secret, ISOLATION_ID, 4, bucket));
    expect(codes.next).toBe(breakGlassCode(secret, ISOLATION_ID, 4, bucket + 1));
    expect(codes.currentValidUntil.toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });

  it('rolls over exactly on the hour', () => {
    const before = currentBreakGlassCodes(secret, ISOLATION_ID, 1, new Date('2026-11-01T12:59:59.999Z'));
    const after = currentBreakGlassCodes(secret, ISOLATION_ID, 1, new Date('2026-11-01T13:00:00.000Z'));
    expect(after.current).toBe(before.next);
  });

  it('refuses an invalid date', () => {
    expect(() => currentBreakGlassCodes(secret, ISOLATION_ID, 1, new Date('nope'))).toThrow(/now/);
  });
});

describe('generateEpisodeSecret', () => {
  it('returns 32 fresh random bytes', () => {
    const a = generateEpisodeSecret();
    const b = generateEpisodeSecret();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a.equals(b)).toBe(false);
  });
});
