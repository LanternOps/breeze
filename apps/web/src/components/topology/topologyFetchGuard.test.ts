import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TOPOLOGY_FETCH_ALLOWLIST } from './topologyFetchAllowlist';

// #9470: a direct fetchWithAuth call attaches the ambient working org, which a cross-org device tab
// (#9258) must not use. Everything goes through topologyRead / topologyWrite so the org pin applies.
const dir = __dirname;
const sources = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (e.name === '__tests__' ? [] : sources(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);

it('no topology source calls fetchWithAuth directly outside topologyApi.ts and the allowlist', () => {
  const allowed = new Set(['topologyApi.ts', ...TOPOLOGY_FETCH_ALLOWLIST.map((a) => a.file)]);
  const offenders = sources(dir)
    .map((f) => f.slice(dir.length + 1))
    .filter((rel) => !allowed.has(rel))
    .filter((rel) => /\bfetchWithAuth\b/.test(readFileSync(join(dir, rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  expect(offenders).toEqual([]);
});

it('every allowlist entry still calls fetchWithAuth (no stale exceptions)', () => {
  for (const { file } of TOPOLOGY_FETCH_ALLOWLIST) expect(readFileSync(join(dir, file), 'utf8')).toMatch(/\bfetchWithAuth\s*\(/);
});
