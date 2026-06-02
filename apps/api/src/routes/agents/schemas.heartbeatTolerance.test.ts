import { describe, expect, it } from 'vitest';
import { heartbeatSchema } from './schemas';

// Tolerant-heartbeat contract: optional informational fields that fail
// validation MUST drop silently. The heartbeat as a whole must still parse so
// the device stays "online" — only the bad field is missing from the parsed
// output. See schemas.ts header comment for the systemic rationale.

describe('heartbeatSchema — Layer A tolerance', () => {
  const minimal = {
    status: 'ok' as const,
    agentVersion: '0.65.15',
  };

  it('accepts a minimal valid heartbeat', () => {
    const result = heartbeatSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('drops oversized macAddress in currentIPs instead of rejecting heartbeat', () => {
    const payload = {
      ...minimal,
      ipHistoryUpdate: {
        currentIPs: [
          {
            interfaceName: 'eth0',
            ipAddress: '10.0.0.1',
            // 100 chars, well past the 64-char informational cap.
            macAddress: 'A'.repeat(100),
          },
        ],
      },
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // The bad macAddress drops to undefined; the rest of the IP record is
    // preserved. Heartbeat parses, server applies the IP-history update
    // without the oversized MAC.
    const entry = result.data.ipHistoryUpdate?.currentIPs?.[0];
    expect(entry?.interfaceName).toBe('eth0');
    expect(entry?.ipAddress).toBe('10.0.0.1');
    expect(entry?.macAddress).toBeUndefined();
  });

  it('drops currentIPs array when an element has invalid required ipAddress', () => {
    const payload = {
      ...minimal,
      ipHistoryUpdate: {
        currentIPs: [
          {
            interfaceName: 'eth0',
            ipAddress: 'not-an-ip',
          },
        ],
      },
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Array catches to undefined when a required inner field is invalid.
    expect(result.data.ipHistoryUpdate?.currentIPs).toBeUndefined();
  });

  it('keeps macAddress when within 64-char limit (covers pseudo-interfaces)', () => {
    // A 35-char tunnel-form MAC from a Windows pseudo-interface should pass
    // through unchanged — this was the original incident's regression test.
    const payload = {
      ...minimal,
      ipHistoryUpdate: {
        currentIPs: [
          {
            interfaceName: 'isatap.{guid}',
            ipAddress: '10.0.0.1',
            macAddress: 'AA-BB-CC-DD-EE-FF-AA-BB-CC-DD-EE-FF',
          },
        ],
      },
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ipHistoryUpdate?.currentIPs?.[0]?.macAddress).toBe(
      'AA-BB-CC-DD-EE-FF-AA-BB-CC-DD-EE-FF',
    );
  });

  it('drops oversized lastUser instead of rejecting', () => {
    const payload = {
      ...minimal,
      lastUser: 'x'.repeat(500),
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lastUser).toBeUndefined();
  });

  it('drops oversized helperVersion instead of rejecting', () => {
    const payload = {
      ...minimal,
      helperVersion: 'v'.repeat(50),
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.helperVersion).toBeUndefined();
  });

  it('drops bad osBuild instead of rejecting', () => {
    const payload = {
      ...minimal,
      osBuild: 'b'.repeat(500),
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.osBuild).toBeUndefined();
  });

  it('drops malformed tccPermissions (missing required inner) instead of rejecting', () => {
    const payload = {
      ...minimal,
      tccPermissions: {
        // missing required booleans
        checkedAt: '2026-05-21T06:00:00+00:00',
      },
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tccPermissions).toBeUndefined();
  });

  it('drops oversized interfaceStats names', () => {
    const payload = {
      ...minimal,
      metrics: {
        cpuPercent: 5,
        ramPercent: 50,
        ramUsedMb: 4096,
        diskPercent: 30,
        diskUsedGb: 100,
        interfaceStats: [
          {
            // empty name violates min(1)
            name: '',
            inBytesPerSec: 0,
            outBytesPerSec: 0,
            inBytes: 0,
            outBytes: 0,
            inPackets: 0,
            outPackets: 0,
            inErrors: 0,
            outErrors: 0,
          },
        ],
      },
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.metrics?.interfaceStats).toBeUndefined();
  });

  it('rejects when REQUIRED top-level fields are missing (status)', () => {
    const payload = { agentVersion: '0.65.15' };
    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects when REQUIRED top-level fields are wrong type (status)', () => {
    const payload = { status: 'banana', agentVersion: '0.65.15' };
    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('keeps required metrics fields strict when metrics block is present', () => {
    const payload = {
      ...minimal,
      metrics: {
        // missing cpuPercent (required)
        ramPercent: 50,
        ramUsedMb: 4096,
        diskPercent: 30,
        diskUsedGb: 100,
      },
    };
    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});
