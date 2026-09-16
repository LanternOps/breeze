import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricsRegistry } from './metricsRegistry';
import {
  addWorkspaceComputeSeconds,
  incArtifactBytes,
  incChatRunDelivery,
  incWorkspaceCapHit,
  incWorkspaceDestroyFailed,
  incWorkspaceStep,
  observeWorkspaceCreateSeconds,
} from './aiWorkspaceMetrics';

beforeEach(() => {
  metricsRegistry.resetMetrics();
});

async function scrape(): Promise<string> {
  return metricsRegistry.metrics();
}

describe('workspace metrics (spec §10)', () => {
  it('publishes every series the spec names', async () => {
    observeWorkspaceCreateSeconds(3.2, { backend: 'vercel', region: 'eu' });
    incWorkspaceStep('ok');
    incWorkspaceStep('timeout');
    addWorkspaceComputeSeconds(41.5, { backend: 'vercel', region: 'eu' });
    incWorkspaceCapHit('staged_bytes');
    incWorkspaceDestroyFailed({ backend: 'vercel', region: 'eu' });
    incArtifactBytes('output', 40_112);
    incChatRunDelivery('completed');

    const text = await scrape();
    for (const name of [
      'ai_workspace_create_seconds',
      'ai_workspace_steps_total',
      'ai_workspace_compute_seconds_total',
      'ai_workspace_cap_hits_total',
      'ai_workspace_destroy_failed_total',
      'ai_artifacts_bytes_total',
      'ai_workspace_chat_deliveries_total',
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain('ai_workspace_steps_total{exit="timeout"} 1');
    expect(text).toContain('ai_workspace_cap_hits_total{cap="staged_bytes"} 1');
    expect(text).toContain('ai_artifacts_bytes_total{kind="output"} 40112');
    expect(text).toContain('ai_workspace_chat_deliveries_total{outcome="completed"} 1');
  });

  it('ignores a non-finite or negative measurement rather than poisoning a counter', async () => {
    addWorkspaceComputeSeconds(Number.NaN, { backend: 'vercel', region: 'eu' });
    observeWorkspaceCreateSeconds(Number.POSITIVE_INFINITY, { backend: 'vercel', region: 'eu' });
    incArtifactBytes('output', -1);
    const text = await scrape();
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('ai_artifacts_bytes_total{kind="output"} -1');
  });

  it('imports nothing but prom-client and the registry (worker-closure leaf rule)', () => {
    const source = readFileSync(join(__dirname, 'aiWorkspaceMetrics.ts'), 'utf8');
    const imports = [...source.matchAll(/^import .*? from '([^']+)';$/gm)].map((m) => m[1]);
    expect([...new Set(imports)].sort()).toEqual(['./metricsRegistry', 'prom-client']);
  });
});
