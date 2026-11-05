/**
 * Wisp W08 (spec §17.2 anti-goal, Review Focus 6): the home never calls a
 * model. `GET /wisp/home` (routes/wispHome.ts) and its aggregate
 * (services/wisp/home.ts) read tables only.
 *
 * Source-level contract: neither file — nor any local module the aggregate
 * imports for its sections — may import the model runtimes. Plain unit test;
 * reads the source tree only.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '../..');
const FORBIDDEN = [
  /from ['"][^'"]*\/aiAgentSdk[^'"]*['"]/,
  /from ['"][^'"]*\/aiAgent['"]/,
  /from ['"][^'"]*\/streamingSessionManager['"]/,
  /from ['"]@anthropic-ai\//,
  /import\(\s*['"][^'"]*(aiAgentSdk|\/aiAgent['"]|streamingSessionManager|@anthropic-ai\/)/,
];

/** The home's own files and the section readers it composes (one hop). */
const FILES = [
  'routes/wispHome.ts',
  'services/wisp/home.ts',
  'services/wisp/threadLinks.ts',
  'services/wisp/entityRefs.ts',
  'services/wisp/entityLoaders.ts',
  'services/wisp/activity.ts',
  'services/wisp/concerns.ts',
  'services/wisp/partnerSettings.ts',
];

const imports = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

describe('Wisp home: no model call', () => {
  it.each(FILES)('%s imports no model runtime', (rel) => {
    const code = imports(rel);
    for (const re of FORBIDDEN) expect(code, `${rel} matches ${re}`).not.toMatch(re);
  });

  it('the list covers every local module home.ts and wispHome.ts import from services/wisp', () => {
    const local = new Set<string>();
    for (const rel of ['routes/wispHome.ts', 'services/wisp/home.ts']) {
      for (const m of imports(rel).matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(resolve(SRC, rel)), m[1]!) + '.ts';
        const r = target.slice(SRC.length + 1);
        if (r.startsWith('services/wisp/')) local.add(r);
      }
    }
    const allowedWithoutScan = new Set(['services/wisp/grantAuthority.ts', 'services/wisp/grants.ts', 'services/wisp/threads.ts']);
    for (const r of local) if (!allowedWithoutScan.has(r)) expect(FILES, `add ${r} to FILES`).toContain(r);
  });

  it('the forbidden patterns do match a model import (control)', () => {
    expect("import { runAgent } from '../aiAgentSdk';").toMatch(FORBIDDEN[0]!);
    expect("import Anthropic from '@anthropic-ai/sdk';").toMatch(FORBIDDEN[3]!);
  });
});
