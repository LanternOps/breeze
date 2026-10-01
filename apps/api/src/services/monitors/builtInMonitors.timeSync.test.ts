import { expect, it } from 'vitest';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  BUILT_IN_MONITORS_VERSION,
  defaultsToProvision,
} from './builtInMonitors';
import { getMonitorKindSpec } from './kinds';
it('adds exactly the three approved v4 defaults using their original version gate', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(5);
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.sinceVersion === 4).map((d) => [
      d.key,
      d.name,
      d.condition,
      d.severity,
      d.sinceVersion,
    ]),
  ).toEqual([
    [
      'time_source_problem',
      'Time source problem',
      {
        findings: [
          'pdc_no_external_source',
          'source_local_clock',
          'dc_vm_host_sync',
          'ntp_server_unresolvable',
          'ntp_peer_unreachable',
          'domain_source_unavailable',
          'member_not_on_hierarchy',
          'correction_refused',
        ],
        consecutiveSnapshots: 2,
      },
      'high',
      4,
    ],
    [
      'time_sync_stale',
      'Time sync stale or disabled',
      { findings: ['sync_stale', 'sync_disabled'], consecutiveSnapshots: 2 },
      'medium',
      4,
    ],
    [
      'timezone_mismatch',
      'Timezone mismatch',
      { findings: ['timezone_mismatch'], consecutiveSnapshots: 2 },
      'low',
      4,
    ],
  ]);
  expect(defaultsToProvision(5)).toEqual([]);
});
it('adds only the management monitor to a v4 partner and never resurrects a deleted v5 default', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(5);
  expect(defaultsToProvision(4)).toEqual([
    {
      key: 'time_policy_not_applied',
      name: 'Time policy not applied',
      description:
        'Alerts after two snapshots reporting failed time-policy enforcement.',
      kind: 'time_sync',
      condition: { findings: ['policy_not_applied'], consecutiveSnapshots: 2 },
      severity: 'low',
      cooldownMinutes: 60,
      sinceVersion: 5,
    },
  ]);
  expect(defaultsToProvision(5)).toEqual([]);
});
it('preserves the v4 time defaults and validates every condition', () => {
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((x) => x.sinceVersion === 4).map(
      (x) => x.key,
    ),
  ).toEqual(['time_source_problem', 'time_sync_stale', 'timezone_mismatch']);
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((x) => x.sinceVersion < 4),
  ).toHaveLength(8);
  for (const monitor of BUILT_IN_MONITOR_DEFAULTS) {
    expect(
      getMonitorKindSpec(monitor.kind).conditionSchema.safeParse(
        monitor.condition,
      ).success,
    ).toBe(true);
  }
});
