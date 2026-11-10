import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * `astro dev` records its PID in `.astro/dev.json`. The file lives in the
 * container's writable layer, so it survives `docker restart`; on Alpine Astro
 * cannot verify PID ownership, treats any reused PID as a live server and exits
 * ("Another astro dev server is already running"). With
 * `restart: unless-stopped` the container then crash-loops (#11184).
 * Each dev CMD must clear the stale lock before starting the dev server.
 */
describe.each([
  ['docker/Dockerfile.web.dev', '.astro/dev.json'],
  ['docker/Dockerfile.portal.dev', '.astro/dev.json'],
])('%s', (file, lock) => {
  it('clears the stale astro dev lock before running pnpm dev', () => {
    const cmd = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('CMD '));
    expect(cmd).toBeDefined();
    const rmIdx = cmd!.indexOf(`rm -f ${lock}`);
    const devIdx = cmd!.indexOf('pnpm dev');
    expect(rmIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeLessThan(devIdx);
  });
});
