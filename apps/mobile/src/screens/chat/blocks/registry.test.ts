import { describe, expect, it, vi } from 'vitest';

// The block components are .tsx files that import react-native. The
// vitest config restricts the include glob to .test.ts so RN never loads
// at the test root, but `registry.ts` imports the .tsx blocks. We mock
// those modules with stub identifiers so `createElement(Stub, props)`
// produces a deterministic React element we can inspect by `.type` name.
vi.mock('./DeviceCard', () => ({ DeviceCard: 'DeviceCard' }));
vi.mock('./FleetStatusRow', () => ({ FleetStatusRow: 'FleetStatusRow' }));
vi.mock('./AlertCard', () => ({ AlertCard: 'AlertCard' }));
vi.mock('./AlertSummaryRow', () => ({ AlertSummaryRow: 'AlertSummaryRow' }));
vi.mock('./AuditLogRow', () => ({ AuditLogRow: 'AuditLogRow' }));
vi.mock('./ScriptResultBlock', () => ({ ScriptResultBlock: 'ScriptResultBlock' }));

import { renderBlockForOutput } from './registry';

interface ElementLike {
  type: string;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ElementLike {
  if (!node || typeof node !== 'object' || !('type' in node)) {
    throw new Error('expected single React element, got: ' + JSON.stringify(node));
  }
  return node as ElementLike;
}

function asArray(node: unknown): ElementLike[] {
  if (!Array.isArray(node)) {
    throw new Error('expected array of React elements, got: ' + JSON.stringify(node));
  }
  return node.map(asElement);
}

describe('renderBlockForOutput', () => {
  describe('devices', () => {
    it('single bare device → DeviceCard', () => {
      const out = renderBlockForOutput({
        id: 'd1',
        hostname: 'mac-mini',
        status: 'online',
      });
      const el = asElement(out);
      expect(el.type).toBe('DeviceCard');
    });

    it('wrapped { device } → DeviceCard', () => {
      const out = renderBlockForOutput({
        device: { id: 'd1', hostname: 'mac-mini', status: 'online' },
      });
      expect(asElement(out).type).toBe('DeviceCard');
    });

    it('multiple devices ≤3 → stacked DeviceCards', () => {
      const out = renderBlockForOutput({
        devices: [
          { id: 'd1', hostname: 'a', status: 'online' },
          { id: 'd2', hostname: 'b', status: 'online' },
          { id: 'd3', hostname: 'c', status: 'offline' },
        ],
        total: 3,
      });
      const arr = asArray(out);
      expect(arr).toHaveLength(3);
      expect(arr.every((e) => e.type === 'DeviceCard')).toBe(true);
    });

    it('multiple devices >3 → FleetStatusRow', () => {
      const out = renderBlockForOutput({
        devices: [
          { id: 'd1', hostname: 'a', status: 'online' },
          { id: 'd2', hostname: 'b', status: 'online' },
          { id: 'd3', hostname: 'c', status: 'offline' },
          { id: 'd4', hostname: 'd', status: 'warning' },
        ],
        total: 4,
      });
      const el = asElement(out);
      expect(el.type).toBe('FleetStatusRow');
      expect(el.props.total).toBe(4);
    });

    it('empty devices list → null', () => {
      const out = renderBlockForOutput({ devices: [], total: 0 });
      expect(out).toBeNull();
    });
  });

  describe('alerts', () => {
    it('alert list ≤2 → stacked AlertCards', () => {
      const out = renderBlockForOutput({
        alerts: [
          { id: 'a1', title: 'CPU spike', severity: 'critical' },
          { id: 'a2', title: 'Disk full', severity: 'high' },
        ],
        total: 2,
      });
      const arr = asArray(out);
      expect(arr).toHaveLength(2);
      expect(arr.every((e) => e.type === 'AlertCard')).toBe(true);
    });

    it('alert list >2 → AlertSummaryRow', () => {
      const out = renderBlockForOutput({
        alerts: [
          { id: 'a1', title: 'one', severity: 'critical' },
          { id: 'a2', title: 'two', severity: 'high' },
          { id: 'a3', title: 'three', severity: 'medium' },
          { id: 'a4', title: 'four', severity: 'low' },
          { id: 'a5', title: 'five', severity: 'info' },
        ],
        total: 5,
      });
      const el = asElement(out);
      expect(el.type).toBe('AlertSummaryRow');
      expect(el.props.total).toBe(5);
    });

    it('single { alert } → AlertCard', () => {
      const out = renderBlockForOutput({
        alert: { id: 'a1', title: 'Disk full', severity: 'high' },
      });
      expect(asElement(out).type).toBe('AlertCard');
    });

    it('empty alerts list → null', () => {
      const out = renderBlockForOutput({ alerts: [], total: 0 });
      expect(out).toBeNull();
    });
  });

  describe('audit log', () => {
    it('audit entries → AuditLogRow', () => {
      const out = renderBlockForOutput({
        entries: [
          {
            id: 'e1',
            timestamp: '2026-05-07T00:00:00Z',
            actorType: 'user',
            actorId: 'u1',
            action: 'device.approve',
            resourceType: 'device',
            resourceId: 'd1',
          },
          {
            id: 'e2',
            timestamp: '2026-05-07T00:01:00Z',
            actorType: 'agent',
            actorId: 'a1',
            action: 'patch.install',
            resourceType: 'device',
            resourceId: 'd2',
          },
        ],
      });
      const el = asElement(out);
      expect(el.type).toBe('AuditLogRow');
      expect((el.props.entries as unknown[]).length).toBe(2);
    });

    it('empty entries → null', () => {
      const out = renderBlockForOutput({ entries: [] });
      expect(out).toBeNull();
    });
  });

  describe('script result', () => {
    it('script result with exitCode 0 → ScriptResultBlock', () => {
      const out = renderBlockForOutput({
        scriptName: 'reboot.ps1',
        deviceId: 'd1',
        deviceHostname: 'mac-mini',
        exitCode: 0,
        output: 'Reboot scheduled.',
        durationMs: 1234,
      });
      const el = asElement(out);
      expect(el.type).toBe('ScriptResultBlock');
    });

    it('script result with non-zero exitCode → ScriptResultBlock', () => {
      const out = renderBlockForOutput({
        scriptName: 'check.sh',
        exitCode: 2,
        error: 'permission denied',
        durationMs: 50,
      });
      expect(asElement(out).type).toBe('ScriptResultBlock');
    });
  });

  describe('fallback', () => {
    it('unknown shape → null', () => {
      const out = renderBlockForOutput({ random: 'data', count: 3 });
      expect(out).toBeNull();
    });

    it('null → null', () => {
      expect(renderBlockForOutput(null)).toBeNull();
    });

    it('string → null', () => {
      expect(renderBlockForOutput('hello')).toBeNull();
    });

    it('array → null', () => {
      expect(renderBlockForOutput([1, 2, 3])).toBeNull();
    });
  });

  describe('match order', () => {
    it('alert wrapper wins over device-shaped fields when both could match', () => {
      // An object with both an `alerts` array and a `devices` array — the
      // alert sniffer runs first because it's more specific.
      const out = renderBlockForOutput({
        alerts: [{ id: 'a1', title: 'x', severity: 'critical' }],
        total: 1,
        devices: [{ id: 'd1', hostname: 'a', status: 'online' }],
      });
      const arr = asArray(out);
      expect(arr[0].type).toBe('AlertCard');
    });
  });
});
