import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import './capacityMetrics';

function sample(text: string, name: string, labels = ''): number {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `));
  if (!line) throw new Error(`series ${name}${labels} not in scrape`);
  return Number(line.split(' ')[1]);
}

describe('capacityMetrics: process CPU', () => {
  it('publishes user and system CPU seconds from process.cpuUsage at scrape time', async () => {
    const spy = vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 2_500_000, system: 500_000 });
    try {
      const text = await metricsRegistry.metrics();
      expect(sample(text, 'breeze_process_cpu_seconds_total', '{mode="user"}')).toBeCloseTo(2.5, 6);
      expect(sample(text, 'breeze_process_cpu_seconds_total', '{mode="system"}')).toBeCloseTo(0.5, 6);
    } finally {
      spy.mockRestore();
    }
  });

  it('is monotonic across scrapes', async () => {
    const a = sample(await metricsRegistry.metrics(), 'breeze_process_cpu_seconds_total', '{mode="user"}');
    let x = 0;
    for (let i = 0; i < 2e6; i++) x += i; // burn a little CPU
    const b = sample(await metricsRegistry.metrics(), 'breeze_process_cpu_seconds_total', '{mode="user"}');
    expect(b).toBeGreaterThanOrEqual(a);
    expect(x).toBeGreaterThan(0);
  });

  it('is part of the role-agnostic runtime set', () => {
    const src = readFileSync(new URL('./metricsRuntime.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^import '\.\/capacityMetrics';$/m);
  });
});

describe('capacityMetrics: owned agent sockets', () => {
  it('publishes 0 when no source is registered (worker role)', async () => {
    vi.resetModules();
    const { metricsRegistry: fresh } = await import('./metricsRegistry');
    await import('./capacityMetrics');
    expect(sample(await fresh.metrics(), 'breeze_agent_ws_connections')).toBe(0);
  });

  it('reads the registered source at scrape time', async () => {
    vi.resetModules();
    const { metricsRegistry: fresh } = await import('./metricsRegistry');
    const { registerConnectedAgentSource } = await import('./capacityMetrics');
    registerConnectedAgentSource(() => 7);
    expect(sample(await fresh.metrics(), 'breeze_agent_ws_connections')).toBe(7);
    registerConnectedAgentSource(() => 3);
    expect(sample(await fresh.metrics(), 'breeze_agent_ws_connections')).toBe(3);
  });

  it('routes/agentWs.ts registers its socket count as the source', () => {
    const src = readFileSync(new URL('../routes/agentWs.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/^import \{ registerConnectedAgentSource \} from '\.\.\/services\/capacityMetrics';$/m);
    expect(src).toMatch(/^registerConnectedAgentSource\(getConnectedAgentCount\);$/m);
  });
});
