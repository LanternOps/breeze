import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

describe('PAM actuation worker runtime lifecycle', () => {
  it('registers initialization in the readiness-tracked worker manifest', () => {
    expect(indexSource).toContain("['pamActuationWorker', initializePamActuationWorker]");
  });

  it('registers shutdown symmetry before Redis and database teardown', () => {
    const workerShutdown = indexSource.indexOf('shutdownPamActuationWorker,');
    const redisShutdown = indexSource.indexOf('closeRedis,', workerShutdown);
    expect(workerShutdown).toBeGreaterThan(-1);
    expect(redisShutdown).toBeGreaterThan(workerShutdown);
  });
});
