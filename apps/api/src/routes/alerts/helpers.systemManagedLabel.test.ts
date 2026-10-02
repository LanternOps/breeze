import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../../db/schema', () => ({
  organizations: {}, partners: {}, notificationChannels: {}, escalationPolicies: {},
  alertRules: {}, alerts: {}, alertTemplates: {}, sites: {}, devices: {},
}));

import { formatAlertRuleResponse } from './helpers';

// #7626: the Built-in alerts list labels policy / compliance anchor rules by
// what they are about, not by their machine names.
const rule = (overrideSettings: Record<string, unknown>) => ({
  id: 'r-1', orgId: 'org-1', partnerId: null, templateId: 't-1', name: 'policy-violation:abc',
  targetType: 'org', targetId: 'org-1', isActive: true, overrideSettings,
  managedByMonitorId: null, createdAt: new Date('2026-09-01T00:00:00Z'),
}) as any;
const builtIn = { id: 't-1', isBuiltIn: true } as any;
const custom = { id: 't-1', isBuiltIn: false } as any;

describe('formatAlertRuleResponse — built-in rule labels (#7626)', () => {
  it('exposes the policy name of a policy-violation anchor rule', () => {
    const res = formatAlertRuleResponse(rule({ source: 'policy-evaluation', policyName: 'Baseline security' }), builtIn);
    expect(res).toMatchObject({ systemManaged: true, systemSource: 'policy-evaluation', systemSubject: 'Baseline security' });
  });

  it('exposes the compliance rule name of a config-compliance anchor rule', () => {
    const res = formatAlertRuleResponse(
      rule({ source: 'config-policy-compliance', configPolicyComplianceRuleName: 'BitLocker on' }),
      builtIn,
    );
    expect(res).toMatchObject({ systemSource: 'config-policy-compliance', systemSubject: 'BitLocker on' });
  });

  it('has no subject for the patch anchor rules (their names are already readable)', () => {
    const res = formatAlertRuleResponse(rule({ source: 'patch-job-finalizer' }), builtIn);
    expect(res).toMatchObject({ systemSource: 'patch-job-finalizer', systemSubject: null });
  });

  it('never surfaces overrides of an ordinary rule', () => {
    const res = formatAlertRuleResponse(rule({ source: 'x', policyName: 'y' }), custom);
    expect(res).toMatchObject({ systemManaged: false, systemSource: null, systemSubject: null });
  });
});
