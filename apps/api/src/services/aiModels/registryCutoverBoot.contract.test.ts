import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
/** Source with `//` line comments removed, so a mention in a comment never satisfies or trips the contract. */
const code = (rel: string) => src(rel).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('AI model registry cutover boot wiring (#7601 Task 6A)', () => {
  it('no entrypoint runs W02\'s per-boot re-projection any more', () => {
    for (const file of ['index.ts', 'worker.ts']) {
      expect(code(file), file).not.toMatch(/reconcileAllPartnersFromLegacy/);
    }
  });

  it('index.ts starts the cutover sweep detached, after serve()', () => {
    const text = code('index.ts');
    const serveAt = text.indexOf('server = serve(');
    const sweepAt = text.search(/void runRegistryCutoverSweepWithRetry\(\)/);
    expect(serveAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(serveAt);
    expect(text).not.toMatch(/await runRegistryCutoverSweep(WithRetry)?\(/);
  });

  it('worker.ts starts the cutover sweep detached, after startRegisteredWorkers', () => {
    const text = code('worker.ts');
    const workersAt = text.indexOf("await startRegisteredWorkers('worker'");
    const sweepAt = text.search(/void runRegistryCutoverSweepWithRetry\(\)/);
    expect(workersAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(workersAt);
    expect(text).not.toMatch(/await runRegistryCutoverSweep(WithRetry)?\(/);
  });
});
