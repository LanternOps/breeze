/**
 * The executor has no prom-client dependency; it hand-rolls Prometheus text on
 * GET /metrics (contract, executor section). So there is no registry to
 * interrogate — what can still be pinned mechanically is the SPELLING: the
 * contract's five names must appear verbatim in the source, so a rename cannot
 * silently orphan a dashboard.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [readFileSync(full, 'utf8')] : [];
  });
}

describe('m365 sync executor metric names', () => {
  it('emits every metric name from the shared interface contract', () => {
    const corpus = sources(srcDir).join('\n');
    for (const name of [
      'm365_sync_actions_total',
      'm365_sync_in_flight',
      'm365_in_flight_total',
      'm365_sync_capacity_rejected_total',
      'm365_signin_limiter_tokens',
    ]) {
      expect(corpus.includes(name), `${name} appears nowhere in the executor source`).toBe(true);
    }
  });
});
