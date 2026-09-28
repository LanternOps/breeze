import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hypervOptionsSchema, resolveSnapshotPlatform } from './bareMetalRebuildSchemas';

describe('resolveSnapshotPlatform', () => {
  it.each([
    [{ schemaVersion: 1, platform: 'windows', disks: [] }, 'windows'],
    [{ schemaVersion: 1, platform: 'linux', disks: [] }, 'linux'],
    [{ schemaVersion: 1, disks: [] }, null],
    [{ platform: 'darwin' }, null],
    [{ platform: 42 }, null],
    [null, null],
    [undefined, null],
    ['windows', null],
  ])('resolveSnapshotPlatform(%j) === %s', (manifest, expected) => {
    expect(resolveSnapshotPlatform(manifest)).toBe(expected);
  });
});

describe('hypervOptionsSchema', () => {
  it('is optional', () => {
    expect(hypervOptionsSchema.safeParse(undefined).success).toBe(true);
  });

  it('accepts the documented shape', () => {
    const value = { vmName: 'w06-proof', switchName: 'lab-switch', memoryMb: 4096, cpuCount: 2 };
    expect(hypervOptionsSchema.parse(value)).toEqual(value);
  });
});

// `routes/backup/schemas.ts` and `drBareMetalRebuildStep.ts` import this module
// eagerly, and both must stay pool-free at load (see the lazy `await import('../db')`
// in drBareMetalRebuildStep.ts). A db-touching import here would drag the pool in.
describe('bareMetalRebuildSchemas module', () => {
  it('imports nothing but zod', () => {
    const source = readFileSync(join(__dirname, 'bareMetalRebuildSchemas.ts'), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const bareImports = [...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    const dynamicImports = [...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect([...specifiers, ...bareImports, ...dynamicImports]).toEqual(['zod']);
  });
});
