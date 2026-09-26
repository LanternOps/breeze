import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The topology island runs under the web CSP (no 'unsafe-eval'). zod's JIT
 * probes `Function('')` when an object schema is CONSTRUCTED, unless
 * `@breeze/shared/validators/topologyZod` has set `jitless` first. The topology
 * validator subpaths import it before any schema; the `@breeze/shared` barrel
 * constructs hundreds of unrelated schemas before it and trips the CSP
 * (topology-browser-gate: "script-src: eval …/schemas.*.js"). Runtime imports
 * here must use the topology subpaths; type-only barrel imports are fine.
 */
const dir = join(__dirname);
const sources = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name));

describe('topology UI runtime imports', () => {
  it('never pulls the @breeze/shared barrel at runtime', () => {
    const offenders = sources.flatMap((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      return [...text.matchAll(/^import\s+(?!type\b)([^;]*?)\s+from\s+'@breeze\/shared'/gm)]
        .filter(([, clause]) => !/^\{\s*(type\s+\w+\s*,?\s*)+\}$/.test(clause!.trim()))
        .map(([line]) => `${name}: ${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
