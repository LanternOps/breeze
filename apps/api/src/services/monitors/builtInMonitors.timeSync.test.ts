// services/monitors/builtInMonitors.timeSync.test.ts
import { expect, it } from 'vitest';
import {
  BUILT_IN_MONITORS_VERSION,
  BUILT_IN_MONITOR_DEFAULTS,
  defaultsToProvision,
} from './builtInMonitors';
it('adds exactly the three approved v4 defaults and no v5 policy default', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(4);
  expect(
    defaultsToProvision(3).map((d) => [
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
  expect(defaultsToProvision(4)).toEqual([]);
  expect(
    BUILT_IN_MONITOR_DEFAULTS.some(
      (d) => String(d.key) === 'time_policy_not_applied',
    ),
  ).toBe(false);
});
