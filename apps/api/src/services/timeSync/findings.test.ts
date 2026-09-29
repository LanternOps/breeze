import { expect, it } from 'vitest';
import {
  TIME_SYNC_FINDING_CODES,
  type TimeStatusSnapshot,
  type TimeSyncFindingCode,
} from '@breeze/shared';
import { resolveTimeFindings, type TimeFindingsContext } from './findings';
import { resolveExpectedTimezone } from './expectedTimezone';
import { NOW, snapshot, event } from './testFixtures';
const base: TimeFindingsContext = {
  expectedTimezone: null,
  previousEventMarks: {},
};
const codes = (s: TimeStatusSnapshot, ctx = base) =>
  resolveTimeFindings(s, ctx).findings.map((f) => f.code);
const cases: Array<[TimeSyncFindingCode, (s: TimeStatusSnapshot) => void]> = [
  [
    'pdc_no_external_source',
    (s) => {
      s.domain.role = 'forest_root_pdc_emulator';
      s.config.type = 'NT5DS';
    },
  ],
  [
    'source_local_clock',
    (s) => {
      s.status.sourceKind = 'local_clock';
    },
  ],
  [
    'dc_vm_host_sync',
    (s) => {
      s.domain.role = 'dc';
      s.config.type = 'NT5DS';
      s.config.hostTimeProviderEnabled = true;
    },
  ],
  [
    'ntp_server_unresolvable',
    (s) => {
      s.config.ntpServer = 'bad;host';
    },
  ],
  [
    'ntp_peer_unreachable',
    (s) => {
      s.events = [event(47, NOW.toISOString())];
    },
  ],
  [
    'domain_source_unavailable',
    (s) => {
      s.events = [event(129, NOW.toISOString())];
    },
  ],
  [
    'member_not_on_hierarchy',
    (s) => {
      s.domain.role = 'member';
    },
  ],
  [
    'sync_disabled',
    (s) => {
      s.config.type = 'NoSync';
    },
  ],
  [
    'sync_stale',
    (s) => {
      s.status.lastSuccessfulSyncAt = '2026-09-26T00:00:00Z';
    },
  ],
  [
    'correction_refused',
    (s) => {
      s.events = [event(52, NOW.toISOString())];
    },
  ],
];
it.each(cases)(
  'raises %s with one deterministic detail object',
  (code, mutate) => {
    const s = snapshot();
    mutate(s);
    const result = resolveTimeFindings(s, base);
    expect(result.findings.filter((f) => f.code === code)).toHaveLength(1);
    expect(result.findings.find((f) => f.code === code)!.detail).toBeTypeOf(
      'object',
    );
  },
);
it('reactivates a failure after success using the latest mark, independent of event order/message', () => {
  const s = snapshot();
  s.events = [
    event(134, '2026-09-28T10:00:00Z'),
    event(37, '2026-09-28T10:05:00Z'),
  ];
  s.collectedAt = '2026-09-28T10:10:00Z';
  const cleared = resolveTimeFindings(s, base);
  expect(cleared.findings.map((f) => f.code)).not.toContain(
    'ntp_server_unresolvable',
  );
  s.collectedAt = NOW.toISOString();
  s.events = [event(134, '2026-09-28T10:40:00Z', 200)];
  const active = resolveTimeFindings(s, {
    ...base,
    previousEventMarks: cleared.eventMarks,
  });
  expect(active.findings.map((f) => f.code)).toContain(
    'ntp_server_unresolvable',
  );
  s.events[0]!.message = 'Nicht aufgelöst';
  expect(
    resolveTimeFindings(s, { ...base, previousEventMarks: cleared.eventMarks }),
  ).toEqual(active);
  s.events = [];
  expect(
    codes(s, { ...base, previousEventMarks: active.eventMarks }),
  ).toContain('ntp_server_unresolvable');
});
it('keeps maximum marks, expires at seven days, and clears at equal success', () => {
  const s = snapshot();
  s.status.lastSuccessfulSyncAt = null;
  s.events = [
    event(134, '2026-09-27T10:40:00Z'),
    event(134, '2026-09-27T10:00:00Z'),
  ];
  const r = resolveTimeFindings(s, {
    ...base,
    previousEventMarks: {
      '12': '2026-09-21T10:39:59Z',
      '52': '2026-09-21T10:40:00Z',
    },
  });
  expect(r.eventMarks['12']).toBeUndefined();
  expect(r.eventMarks['52']).toBeDefined();
  expect(r.findings.map((f) => f.code)).toContain('ntp_server_unresolvable');
  s.collectedAt = new Date(+NOW + 1).toISOString();
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
  s.collectedAt = NOW.toISOString();
  s.events.push(event(35, '2026-09-27T10:40:00Z'));
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
});
it('does not interpret flags or display text as DNS failure', () => {
  const s = snapshot();
  s.config.ntpServer = '  time.a.com,0x9   time.b.com,0x8  ';
  s.events = [
    { ...event(35, NOW.toISOString()), message: 'DNS failed NTP error' },
  ];
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
  s.config.ntpServer = 'time.a.com,0x1,0x8';
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
  s.config.type = 'NT5DS';
  s.config.ntpServer = 'bad;host';
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
});
it('applies poll fallback, threshold equality and disabled suppression', () => {
  const s = snapshot();
  s.status.pollIntervalSeconds = null;
  s.config.specialPollIntervalSeconds = null;
  s.status.lastSuccessfulSyncAt = new Date(
    +NOW - 21 * 86_400_000,
  ).toISOString();
  expect(codes(s)).not.toContain('sync_stale');
  s.status.lastSuccessfulSyncAt = new Date(
    +NOW - 21 * 86_400_000 - 1,
  ).toISOString();
  expect(codes(s)).toContain('sync_stale');
  s.config.serviceStartType = 'disabled';
  s.events = [event(36, NOW.toISOString())];
  expect(codes(s)).toContain('sync_disabled');
  expect(codes(s)).not.toContain('sync_stale');
  s.config.serviceStartType = 'auto';
  s.status.lastSuccessfulSyncAt = null;
  s.events = [];
  expect(codes(s)).not.toContain('sync_stale');
});
it('limits role/config findings and does not implement W03 enforcement', () => {
  const s = snapshot();
  s.domain.role = 'member';
  s.config.policyManaged = true;
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
  s.domain.role = 'pdc_emulator';
  s.config.type = 'NT5DS';
  s.events = [event(12, NOW.toISOString())];
  expect(codes(s)).not.toContain('pdc_no_external_source');
  const ctx = {
    ...base,
    enforcementSettings: { enforceNtp: true, timezoneAutoFix: true },
  };
  expect(codes(s, ctx)).not.toContain('policy_not_applied');
  expect(codes(s, ctx)).not.toContain('policy_conflict_gpo');
});
it('compares Windows IDs, suppresses auto timezone, respects UTC default and info-only health', () => {
  const s = snapshot();
  const site = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Main',
    timezone: 'UTC',
  };
  expect(
    codes(s, { ...base, expectedTimezone: resolveExpectedTimezone({ site }) }),
  ).not.toContain('timezone_mismatch');
  const expectedTimezone = resolveExpectedTimezone({
    site: { ...site, timezone: 'America/Detroit' },
  });
  const ctx = { ...base, expectedTimezone };
  s.status.method = 'unavailable';
  expect(resolveTimeFindings(s, ctx)).toMatchObject({
    health: 'healthy',
    findings: [
      {
        code: 'timezone_mismatch',
        detail: {
          actual: 'Pacific Standard Time',
          expected: 'Eastern Standard Time',
          expectedIana: 'America/Detroit',
          expectedSource: 'site',
          expectedSourceName: 'Main',
        },
      },
    ],
  });
  s.timezone.windowsId = 'Eastern Standard Time';
  expect(resolveTimeFindings(s, ctx).health).toBe('unknown');
  s.timezone.windowsId = 'Pacific Standard Time';
  s.timezone.autoUpdate = 'on';
  expect(codes(s, ctx)).not.toContain('timezone_mismatch');
});
it.each([
  [
    12,
    'forest_root_pdc_emulator',
    'pdc_no_external_source',
    { domainDns: null },
  ],
  [24, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [29, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [47, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [129, 'workgroup', 'domain_source_unavailable', { domainDns: null }],
  [134, 'workgroup', 'ntp_server_unresolvable', { host: 'peer.example.com' }],
  [52, 'workgroup', 'correction_refused', { occurredAt: NOW.toISOString() }],
] as const)(
  'maps active event %i with exact details',
  (id, role, code, detail) => {
    const s = snapshot();
    s.domain.role = role;
    s.events = [event(id, NOW.toISOString())];
    expect(resolveTimeFindings(s, base).findings).toContainEqual({
      code,
      detail,
      severity: code === 'pdc_no_external_source' ? 'critical' : 'warning',
    });
    s.status.lastSuccessfulSyncAt = NOW.toISOString();
    expect(codes(s)).not.toContain(code);
  },
);
it.each([
  'workgroup',
  'entra_only',
  'member',
  'dc',
  'pdc_emulator',
  'forest_root_pdc_emulator',
  'unknown',
] as const)('pins hierarchy and VM-provider guards for role %s', (role) => {
  const s = snapshot();
  s.domain.role = role;
  s.status.sourceKind = 'vm_host';
  expect(codes(s).includes('dc_vm_host_sync')).toBe(
    ['dc', 'pdc_emulator', 'forest_root_pdc_emulator'].includes(role),
  );
  expect(codes(s).includes('member_not_on_hierarchy')).toBe(
    ['member', 'dc', 'pdc_emulator'].includes(role),
  );
  s.config.policyManaged = true;
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
  s.config.policyManaged = false;
  s.config.type = 'AllSync';
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
});
it('pins remaining static details, severities and AllSync validation', () => {
  const s = snapshot();
  s.domain.role = 'member';
  s.status.sourceKind = 'local_clock';
  s.config.type = 'AllSync';
  s.config.ntpServer = 'bad;host';
  expect(resolveTimeFindings(s, base).findings).toEqual([
    {
      code: 'source_local_clock',
      severity: 'critical',
      detail: { source: 'pool.ntp.org', sourceKind: 'local_clock' },
    },
    {
      code: 'ntp_server_unresolvable',
      severity: 'warning',
      detail: { host: 'bad;host' },
    },
  ]);
  s.status.sourceKind = 'ntp_peer';
  s.config.type = 'NoSync';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_disabled',
    severity: 'critical',
    detail: { reason: 'no_sync' },
  });
  s.config.type = 'NTP';
  s.config.serviceStartType = 'disabled';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_disabled',
    severity: 'critical',
    detail: { reason: 'service_disabled' },
  });
  s.config.serviceStartType = 'auto';
  s.config.ntpServer = 'pool.ntp.org';
  s.status.lastSuccessfulSyncAt = '2026-09-26T00:00:00Z';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_stale',
    severity: 'warning',
    detail: {
      lastSuccessfulSyncAt: '2026-09-26T00:00:00Z',
      thresholdHours: 24,
    },
  });
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'member_not_on_hierarchy',
    severity: 'warning',
    detail: { type: 'NTP' },
  });
  s.domain.role = 'dc';
  s.config.hostTimeProviderEnabled = true;
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'dc_vm_host_sync',
    severity: 'warning',
    detail: { role: 'dc' },
  });
});
it('orders codes once and derives worst health', () => {
  const s = snapshot();
  s.config.type = 'NoSync';
  s.status.sourceKind = 'free_running';
  s.events = [event(47, NOW.toISOString()), event(24, NOW.toISOString())];
  const r = resolveTimeFindings(s, base);
  expect(r.health).toBe('critical');
  expect(r.findings.map((f) => f.code)).toEqual(
    TIME_SYNC_FINDING_CODES.filter((c) =>
      ['source_local_clock', 'ntp_peer_unreachable', 'sync_disabled'].includes(
        c,
      ),
    ),
  );
});
// Device/server clock skew: every age is measured on the device's own clock
// (snapshot.collectedAt), because occurredAt, event marks and
// lastSuccessfulSyncAt are all stamped by that clock. Server time (receivedAt)
// is only used for freshness, never here.
const DAY = 86_400_000;
const at = (ms: number) => new Date(ms).toISOString();
it('raises correction_refused on a device whose clock runs 2 days behind', () => {
  const s = snapshot();
  const device = +NOW - 2 * DAY;
  s.collectedAt = at(device);
  s.status.lastSuccessfulSyncAt = at(device - 3_600_000);
  s.events = [event(52, at(device - 60_000))];
  const r = resolveTimeFindings(s, base);
  expect(r.findings.map((f) => f.code)).toEqual(['correction_refused']);
  expect(r.health).toBe('warning');
});
it('keeps event marks of a device whose clock runs more than 7 days behind', () => {
  const s = snapshot();
  const device = +NOW - 8 * DAY;
  s.collectedAt = at(device);
  s.status.lastSuccessfulSyncAt = at(device - 3_600_000);
  s.events = [event(52, at(device - 60_000))];
  const r = resolveTimeFindings(s, base);
  expect(r.eventMarks['52']).toBe(at(device - 60_000));
  expect(r.findings.map((f) => f.code)).toContain('correction_refused');
});
it('clears a failure logged while the clock was ahead once the clock is fixed and a later success arrives', () => {
  const ahead = snapshot();
  const device = +NOW + 2 * DAY;
  ahead.collectedAt = at(device);
  ahead.status.lastSuccessfulSyncAt = at(device - 3_600_000);
  ahead.events = [event(52, at(device - 60_000))];
  const first = resolveTimeFindings(ahead, base);
  expect(first.findings.map((f) => f.code)).toContain('correction_refused');
  const fixed = snapshot();
  fixed.status.lastSuccessfulSyncAt = at(+NOW - 300_000);
  fixed.events = [event(35, at(+NOW - 300_000), 300)];
  const second = resolveTimeFindings(fixed, {
    ...base,
    previousEventMarks: first.eventMarks,
  });
  expect(second.findings.map((f) => f.code)).not.toContain(
    'correction_refused',
  );
  expect(second.eventMarks['52']).toBeUndefined();
  expect(second.health).toBe('healthy');
});
it('tolerates event stamps up to 5 minutes after collectedAt, drops later ones as a clock step back', () => {
  const s = snapshot();
  s.events = [event(52, at(+NOW + 300_000))];
  expect(codes(s)).toContain('correction_refused');
  s.events = [event(52, at(+NOW + 300_001))];
  const r = resolveTimeFindings(s, base);
  expect(r.findings.map((f) => f.code)).not.toContain('correction_refused');
  expect(r.eventMarks['52']).toBeUndefined();
});
it('measures sync_stale on the device clock in both skew directions', () => {
  const s = snapshot();
  // Behind by 2 days, synced 1 h ago on its own clock: not stale.
  s.collectedAt = at(+NOW - 2 * DAY);
  s.status.lastSuccessfulSyncAt = at(+NOW - 2 * DAY - 3_600_000);
  expect(codes(s)).not.toContain('sync_stale');
  // Ahead by 2 days, last sync 30 h ago on its own clock: stale.
  s.collectedAt = at(+NOW + 2 * DAY);
  s.status.lastSuccessfulSyncAt = at(+NOW + 2 * DAY - 30 * 3_600_000);
  expect(codes(s)).toContain('sync_stale');
});
