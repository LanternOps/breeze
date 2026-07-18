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

  it('parses a full battery snapshot (#2142)', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      battery: {
        present: true,
        percent: 42.5,
        chargingState: 'discharging',
        pluggedIn: false,
        timeRemainingMinutes: 90,
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.battery).toMatchObject({ present: true, percent: 42.5, chargingState: 'discharging' });
  });

  it('drops an out-of-range battery percent but keeps the rest of the snapshot', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      battery: { present: true, percent: 250, chargingState: 'charging' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // 250 > 100 fails the range check → dropped via .catch; present/state survive.
    expect(result.data.battery?.percent).toBeUndefined();
    expect(result.data.battery?.present).toBe(true);
    expect(result.data.battery?.chargingState).toBe('charging');
  });

  it('drops the whole battery object when the required present field is missing', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      // `present` is required with no .catch, so the object collapses to
      // undefined via the outer .catch rather than 400-ing the heartbeat.
      battery: { percent: 80, chargingState: 'charging' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.battery).toBeUndefined();
  });

  it('drops an unknown chargingState enum value rather than rejecting', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      battery: { present: true, chargingState: 'supercharging' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.battery?.chargingState).toBeUndefined();
    expect(result.data.battery?.present).toBe(true);
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

  it('drops oversized watchdogVersion instead of rejecting (#1802)', () => {
    const payload = {
      ...minimal,
      watchdogVersion: 'v'.repeat(50),
    };

    const result = heartbeatSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.watchdogVersion).toBeUndefined();
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

// signedInUpns degrades at FIELD level (.catch([])): a violating UPN list must
// cost only the UPNs, never the whole onedriveDeviceState block — the block
// carries mounted/drift/KFM state whose silent loss leaves stale rows that
// graph_group tagging keeps consuming.
describe('heartbeatSchema — onedriveDeviceState signedInUpns bounds', () => {
  const minimal = { status: 'ok' as const, agentVersion: '0.65.15' };
  const state = (signedInUpns: unknown) => ({
    ...minimal,
    onedriveDeviceState: {
      signedIn: true,
      filesOnDemandOn: true,
      kfmFolderStates: { Desktop: 'redirected' },
      mountedLibraries: ['C:\\x'],
      entitledLibraries: ['lib-1'],
      driftEntries: [],
      signedInUpns,
    },
  });
  const parseState = (signedInUpns: unknown) => {
    const result = heartbeatSchema.safeParse(state(signedInUpns));
    expect(result.success).toBe(true);
    return (result as { success: true; data: { onedriveDeviceState?: { signedInUpns: string[]; mountedLibraries: string[] } } }).data.onedriveDeviceState;
  };

  it('keeps exactly 16 UPNs (the cap the agent mirrors)', () => {
    const upns = Array.from({ length: 16 }, (_, i) => `u${i}@c.com`);
    const parsed = parseState(upns);
    expect(parsed?.signedInUpns).toEqual(upns);
  });

  it('17 UPNs → field degrades to [], the rest of the state block survives', () => {
    const parsed = parseState(Array.from({ length: 17 }, (_, i) => `u${i}@c.com`));
    expect(parsed?.signedInUpns).toEqual([]);
    expect(parsed?.mountedLibraries).toEqual(['C:\\x']);
  });

  it('an oversized (>320 char) UPN → field degrades to [], block survives', () => {
    const parsed = parseState([`${'a'.repeat(321)}@c.com`]);
    expect(parsed?.signedInUpns).toEqual([]);
    expect(parsed?.mountedLibraries).toEqual(['C:\\x']);
  });

  it('non-array → field degrades to [], block survives', () => {
    const parsed = parseState('not-an-array');
    expect(parsed?.signedInUpns).toEqual([]);
    expect(parsed?.mountedLibraries).toEqual(['C:\\x']);
  });

  it('omitted → defaults to [] (Phase 3 agents), block survives', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      onedriveDeviceState: {
        signedIn: false,
        filesOnDemandOn: false,
      },
    });
    expect(result.success).toBe(true);
    expect((result as { success: true; data: { onedriveDeviceState?: { signedInUpns: string[] } } }).data.onedriveDeviceState?.signedInUpns).toEqual([]);
  });
});

// uint64Counter guards the cumulative byte/packet counters against v4's new
// z.number().int() 2^53 cap. The agent emits Go uint64 counters (bigint columns)
// that exceed 2^53 on busy/long-uptime hosts; a revert to .int() would, via the
// .catch(undefined)/array-catch guards, SILENTLY drop them. These boundary tests
// lock that in — no existing test exercises a value above 2^53.
describe('heartbeatSchema — large uint64 counters (v4 .int() 2^53 cap)', () => {
  const minimal = { status: 'ok' as const, agentVersion: '0.65.15' };
  const BIG = 18_014_398_509_481_984; // 2^54, above Number.MAX_SAFE_INTEGER (2^53)
  const baseMetrics = { cpuPercent: 5, ramPercent: 50, ramUsedMb: 4096, diskPercent: 30, diskUsedGb: 100 };

  it('accepts cumulative byte/packet counters above 2^53 and preserves them', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      metrics: {
        ...baseMetrics,
        networkInBytes: BIG,
        diskReadBytes: BIG,
        interfaceStats: [
          { name: 'eth0', inBytesPerSec: 0, outBytesPerSec: 0, inBytes: BIG, outBytes: BIG, inPackets: BIG, outPackets: 0, inErrors: 0, outErrors: 0 },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.metrics?.networkInBytes).toBe(BIG);
    expect(result.data.metrics?.diskReadBytes).toBe(BIG);
    // If inBytes/inPackets were still .int(), the whole interface object would
    // fail and the array .catch would drop interfaceStats entirely.
    expect(result.data.metrics?.interfaceStats?.[0]?.inBytes).toBe(BIG);
    expect(result.data.metrics?.interfaceStats?.[0]?.inPackets).toBe(BIG);
  });

  it('still drops a fractional byte counter (refine integer check intact)', () => {
    const result = heartbeatSchema.safeParse({ ...minimal, metrics: { ...baseMetrics, networkInBytes: 1.5 } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.metrics?.networkInBytes).toBeUndefined();
  });
});

// #1121 — the watchdogState collapse premise: a corrupted (non-string) value
// must drop to undefined rather than 400 the heartbeat. The route-side
// observability for this collapse is detectWatchdogStateCollapse in
// heartbeat.ts (unit-tested in heartbeat.test.ts).
describe('heartbeatSchema — watchdogState .catch collapse (#1121)', () => {
  const minimal = { status: 'ok' as const, agentVersion: '0.65.15' };

  it('corrupted watchdogState (number) collapses to undefined, heartbeat still parses', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      role: 'watchdog',
      watchdogState: 42,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.watchdogState).toBeUndefined();
    }
  });

  it('valid FAILOVER passes through untouched', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      role: 'watchdog',
      watchdogState: 'FAILOVER',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.watchdogState).toBe('FAILOVER');
    }
  });
});

describe('heartbeatSchema — agentRuntime gauges (#2389)', () => {
  const minimal = {
    status: 'ok' as const,
    agentVersion: '0.95.0',
  };

  const validRuntime = {
    heapAllocBytes: 12_345_678,
    heapInuseBytes: 23_456_789,
    heapReleasedBytes: 1_048_576,
    sysBytes: 99_999_999,
    numGc: 42,
    goroutines: 87,
  };

  it('parses a full agentRuntime snapshot', () => {
    const result = heartbeatSchema.safeParse({ ...minimal, agentRuntime: validRuntime });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toEqual(validRuntime);
  });

  it('accepts gauge values above 2^53 (uint64 counters from a big process)', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      agentRuntime: { ...validRuntime, sysBytes: 2 ** 60 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime?.sysBytes).toBe(2 ** 60);
  });

  it('drops the whole agentRuntime object on a negative gauge rather than rejecting', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      agentRuntime: { ...validRuntime, heapAllocBytes: -5 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toBeUndefined();
  });

  it('drops the whole agentRuntime object when a required gauge is missing', () => {
    const { goroutines: _omitted, ...partial } = validRuntime;
    const result = heartbeatSchema.safeParse({ ...minimal, agentRuntime: partial });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toBeUndefined();
  });

  it('heartbeat without agentRuntime (old agent) still parses', () => {
    const result = heartbeatSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toBeUndefined();
  });

  // Worker-pool wedge gauges (#2400) ride the same agentRuntime object.
  it('parses agentRuntime with wedge gauges (commandsInFlight/commandsOverdue)', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      agentRuntime: { ...validRuntime, commandsInFlight: 3, commandsOverdue: 1 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime?.commandsInFlight).toBe(3);
    expect(result.data.agentRuntime?.commandsOverdue).toBe(1);
  });

  it('agentRuntime without wedge gauges (pre-#2400 agent) still parses whole', () => {
    const result = heartbeatSchema.safeParse({ ...minimal, agentRuntime: validRuntime });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toBeDefined();
    expect(result.data.agentRuntime?.commandsInFlight).toBeUndefined();
    expect(result.data.agentRuntime?.commandsOverdue).toBeUndefined();
  });

  it('drops only the bad wedge gauge, keeping the rest of agentRuntime', () => {
    const result = heartbeatSchema.safeParse({
      ...minimal,
      agentRuntime: { ...validRuntime, commandsInFlight: -2, commandsOverdue: 1 },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.agentRuntime).toBeDefined();
    expect(result.data.agentRuntime?.commandsInFlight).toBeUndefined();
    expect(result.data.agentRuntime?.commandsOverdue).toBe(1);
    expect(result.data.agentRuntime?.goroutines).toBe(validRuntime.goroutines);
  });
});

// desktopAccess.reason forward-compat: the Linux agent (Task 12) emits
// no_display_session / wayland_unsupported / x11_connect_failed today, with
// x11_auth_failed reserved for a future emitter. All four must round-trip
// through the enum; an unrecognized reason must degrade to undefined via
// .catch(undefined) rather than dropping the whole desktopAccess object.
describe('desktopAccess Linux reasons', () => {
  const base = {
    status: 'ok' as const,
    agentVersion: '0.65.15',
    desktopAccess: {
      mode: 'unavailable' as const,
      loginUiReachable: false,
      virtualDisplayReady: false,
      checkedAt: '2026-07-17T00:00:00.000Z',
    },
  };

  it.each(['no_display_session', 'wayland_unsupported', 'x11_connect_failed', 'x11_auth_failed'])(
    'accepts Linux reason %s',
    (reason) => {
      const parsed = heartbeatSchema.parse({
        ...base,
        desktopAccess: { ...base.desktopAccess, reason },
      });
      expect(parsed.desktopAccess?.reason).toBe(reason);
    },
  );

  it('keeps the object but drops an unknown reason (forward-compat)', () => {
    const parsed = heartbeatSchema.parse({
      ...base,
      desktopAccess: { ...base.desktopAccess, reason: 'totally_new_reason' },
    });
    expect(parsed.desktopAccess).toBeDefined();
    expect(parsed.desktopAccess?.reason).toBeUndefined();
  });
});
