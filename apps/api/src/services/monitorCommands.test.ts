import { describe, expect, it } from 'vitest';
import { buildMonitorCommand } from './monitorCommands';

/**
 * `buildMonitorCommand` — extracted from `routes/monitors.ts` (wave 3.5d-b,
 * #4086) so `jobs/monitorWorker.ts` can import it without reaching the route
 * graph. Coverage ported from `routes/monitors_actions.test.ts`'s
 * `buildMonitorCommand` describe block (still green there via the re-export)
 * plus verifying `monitorWorker`'s tests get the same command shape.
 */

const MONITOR_ID = 'monitor-1';

describe('buildMonitorCommand', () => {
  it('builds icmp_ping command', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'icmp_ping',
      target: '8.8.8.8',
      config: { count: 5 },
      timeout: 10,
    });

    expect(cmd.type).toBe('network_ping');
    expect(cmd.payload.target).toBe('8.8.8.8');
    expect(cmd.payload.count).toBe(5);
    expect(cmd.payload.timeout).toBe(10);
    expect(cmd.id).toContain(`mon-${MONITOR_ID}`);
  });

  it('builds tcp_port command', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'tcp_port',
      target: '10.0.0.1',
      config: { port: 443 },
      timeout: 5,
    });

    expect(cmd.type).toBe('network_tcp_check');
    expect(cmd.payload.port).toBe(443);
  });

  it('builds http_check command with url fallback', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'http_check',
      target: 'https://example.com',
      config: {},
      timeout: 30,
    });

    expect(cmd.type).toBe('network_http_check');
    expect(cmd.payload.url).toBe('https://example.com');
  });

  it('does not override an explicit url in config for http_check', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'http_check',
      target: 'https://example.com',
      config: { url: 'https://other.example.com/health' },
      timeout: 30,
    });

    expect(cmd.payload.url).toBe('https://other.example.com/health');
  });

  it('builds dns_check command with hostname fallback', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'dns_check',
      target: 'example.com',
      config: { recordType: 'A' },
      timeout: 5,
    });

    expect(cmd.type).toBe('network_dns_check');
    expect(cmd.payload.hostname).toBe('example.com');
    expect(cmd.payload.recordType).toBe('A');
  });

  it('throws for unknown monitor type', () => {
    expect(() =>
      buildMonitorCommand({
        id: MONITOR_ID,
        monitorType: 'unknown_type',
        target: '8.8.8.8',
        config: {},
        timeout: 5,
      })
    ).toThrow('Unknown monitor type');
  });

  it('tolerates a null/undefined config', () => {
    const cmd = buildMonitorCommand({
      id: MONITOR_ID,
      monitorType: 'icmp_ping',
      target: '8.8.8.8',
      config: null,
      timeout: 10,
    });

    expect(cmd.payload).toEqual({ monitorId: MONITOR_ID, target: '8.8.8.8', timeout: 10 });
  });
});
