// Picked up by the existing root script: test:dev-scripts (vitest over scripts/dev).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const TURBO_DEFAULT_CONCURRENCY = 10;

describe('turbo concurrency for `pnpm dev` (#8375)', () => {
  // turbo refuses to start when concurrency is not greater than the number of persistent tasks, so a
  // package that adds a `dev` script can break `pnpm dev` for everyone. This fails first instead.
  it('leaves a slot beyond every persistent dev task', () => {
    const turbo = createRequire(import.meta.url).resolve('turbo');
    const plan = JSON.parse(
      execFileSync(process.execPath, [turbo, 'run', 'dev', '--dry=json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The dry-run plan outgrows execFileSync's 1 MiB default maxBuffer (ENOBUFS).
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
    // Packages without a `dev` script are still listed, as <NONEXISTENT>; turbo does not count them.
    const persistent = plan.tasks.filter(
      (task: { command: string; resolvedTaskDefinition: { persistent: boolean } }) =>
        task.resolvedTaskDefinition.persistent && task.command !== '<NONEXISTENT>',
    ).length;
    // turbo.json carries comments, so read the one key rather than JSON.parse the file.
    const configured = readFileSync(`${repoRoot}turbo.json`, 'utf8').match(/"concurrency"\s*:\s*"(\d+)"/);
    const concurrency = configured ? Number(configured[1]) : TURBO_DEFAULT_CONCURRENCY;

    expect(persistent).toBeGreaterThan(0);
    expect(concurrency).toBeGreaterThan(persistent);
  }, 60_000);
});
