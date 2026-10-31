import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { heartbeatSchema } from './schemas';
const beat = { status: 'ok', agentVersion: '999.0.0', metrics: { cpuPercent: 1, ramPercent: 1, ramUsedMb: 1, diskPercent: 1, diskUsedGb: 1 } };
describe('containment heartbeat contract', () => {
  it('accepts and preserves capabilities', () => {
    const securityCapabilities = { networkIsolationVersion: 1, networkIsolationMechanism: 'wfp', networkIsolationUnsupportedReason: 'diagnostic', networkIsolationReady: true };
    expect(heartbeatSchema.parse({ ...beat, securityCapabilities }).securityCapabilities).toMatchObject(securityCapabilities);
  });
  it('drops a malformed report without rejecting the heartbeat', () => {
    const parsed = heartbeatSchema.parse({ ...beat, containment: { networkIsolation: { state: 'garbage' } } });
    expect(parsed).toHaveProperty('containment');
    expect(parsed.containment?.networkIsolation).toBeUndefined();
  });
  it('wires reconciliation and a top-level block, with non-sticky capabilities', () => {
    const source = readFileSync(new URL('./heartbeat.ts', import.meta.url), 'utf8');
    expect(source).toContain('await reconcileContainmentReport(');
    expect(source).toContain('containment: await buildContainmentHeartbeatBlock(');
    expect(source).toContain('networkIsolationVersion: data.securityCapabilities?.networkIsolationVersion ?? 0');
    expect(source).toContain('networkIsolationReady: data.securityCapabilities?.networkIsolationReady ?? false');
  });
});
