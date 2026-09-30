import { beforeEach, expect, it, vi } from 'vitest';
import type { TimeSyncEnforcementState } from '@breeze/shared';
const m = vi.hoisted(() => ({ insert: vi.fn(), existing: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const q: any = {
        then: (yes: any) => Promise.resolve(m.existing).then(yes),
      };
      for (const k of ['from', 'where', 'limit']) q[k] = () => q;
      return q;
    },
    insert: () => ({ values: m.insert }),
  },
}));
import {
  managementFindings,
  auditEnforcement,
  readEnforcement,
} from './enforcement';
const id = '11111111-1111-4111-8111-111111111111';
const result = {
  resultId: id,
  fingerprint: 'sha256:test',
  at: '2026-09-28T12:00:00Z',
  outcome: 'failed' as const,
  reason: 'exec_failed' as const,
  before: { type: 'NoSync' },
  after: { type: 'NTP' },
  error: 'exit 1',
};
const on = { enforceNtp: true, timezoneAutoFix: true };
beforeEach(() => {
  m.insert.mockReset().mockResolvedValue(undefined);
  m.existing = [];
});
it.each([
  ['failed', 'exec_failed', 'policy_not_applied'],
  ['failed', 'readback_mismatch', 'policy_not_applied'],
  ['skipped', 'role_unknown', 'policy_not_applied'],
  ['skipped', 'conflict_gpo', 'policy_conflict_gpo'],
  ['ok', 'applied', null],
  ['ok', 'already_compliant', null],
] as const)('maps NTP %s/%s', (outcome, reason, code) => {
  const report = { ntp: { ...result, outcome, reason }, timezone: null };
  expect(managementFindings(report, ['Type'], on).map((f) => f.code)).toEqual(
    code ? [code] : [],
  );
});
it('suppresses stale failures after enforcement is disabled', () => {
  expect(
    managementFindings({ ntp: result, timezone: result }, [], {
      enforceNtp: false,
      timezoneAutoFix: false,
    }),
  ).toEqual([]);
});
it('emits the failure code once when both kinds fail, preferring NTP detail', () => {
  const findings = managementFindings(
    { ntp: result, timezone: result },
    [],
    on,
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    code: 'policy_not_applied',
    detail: { kind: 'ntp', reason: 'exec_failed', error: 'exit 1' },
  });
});
it('timezone skipped outcomes never imply failed enforcement', () => {
  const report = {
    ntp: null,
    timezone: {
      ...result,
      outcome: 'skipped' as const,
      reason: 'auto_timezone_on' as const,
    },
  };
  expect(managementFindings(report, [], on)).toEqual([]);
});
it('writes one system device audit for each changed kind', async () => {
  await auditEnforcement({
    deviceId: id,
    orgId: id,
    previous: null,
    report: { ntp: result, timezone: null },
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      actorType: 'system',
      action: 'time_sync.enforced',
      resourceType: 'device',
      resourceId: id,
      orgId: id,
      details: expect.objectContaining({
        kind: 'ntp',
        resultId: id,
        before: result.before,
        after: result.after,
      }),
    }),
  );
});
it('does not audit a repeated latest result or an already audited older result', async () => {
  const report: TimeSyncEnforcementState = { ntp: result, timezone: null };
  await auditEnforcement({ deviceId: id, orgId: id, previous: report, report });
  expect(m.insert).not.toHaveBeenCalled();
  m.existing = [{ id }];
  await auditEnforcement({ deviceId: id, orgId: id, previous: null, report });
  expect(m.insert).not.toHaveBeenCalled();
});
it('propagates an audit write failure so ingest cannot advance past it', async () => {
  m.insert.mockRejectedValue(new Error('audit unavailable'));
  await expect(
    auditEnforcement({
      deviceId: id,
      orgId: id,
      previous: null,
      report: { ntp: result, timezone: null },
    }),
  ).rejects.toThrow('audit unavailable');
});
it('treats migrated empty objects and null as no report', () => {
  expect(readEnforcement({})).toBeNull();
  expect(readEnforcement(null)).toBeNull();
  expect(readEnforcement({ ntp: result, timezone: null })).toEqual({
    ntp: result,
    timezone: null,
  });
});
