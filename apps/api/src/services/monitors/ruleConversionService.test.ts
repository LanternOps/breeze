import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every scenario below fails BEFORE `db.transaction` is reached (rule lookup,
 * visibility, ownership, and convertibility checks all run first), so the
 * transaction mock is a trap: any test that reaches it is exercising a path
 * this suite does not cover.
 *
 * `../configurationPolicy` is mocked per the module's own doc comment — the
 * real module pulls a far larger graph in than this unit needs, and is never
 * called on the failure paths tested here.
 */
const { dbMock, resultsQueue } = vi.hoisted(() => {
  const resultsQueue: unknown[][] = [];
  return {
    resultsQueue,
    dbMock: {
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(resultsQueue.shift() ?? []),
          }),
        }),
      })),
      transaction: vi.fn(async () => {
        throw new Error('transaction should not be reached in these cases');
      }),
    },
  };
});

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: dbMock,
}));

vi.mock('../configurationPolicy', () => ({
  addFeatureLink: vi.fn(),
  assignPolicy: vi.fn(),
  createConfigPolicy: vi.fn(),
}));

import { convertRuleToMonitor } from './ruleConversionService';
import type { AuthContext } from '../../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    ...overrides,
  } as unknown as AuthContext;
}

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    templateId: 'template-1',
    orgId: ORG,
    partnerId: null,
    name: 'CPU rule',
    isActive: true,
    managedByMonitorId: null,
    overrideSettings: null,
    targetType: 'all',
    targetId: null,
    ...overrides,
  };
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'template-1',
    conditions: { type: 'threshold', metric: 'cpuPercent', operator: 'gt', value: 90 },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: false,
    description: null,
    ...overrides,
  };
}

beforeEach(() => {
  resultsQueue.length = 0;
});

describe('convertRuleToMonitor (#5289)', () => {
  it('rule_not_found when no rule exists for the id', async () => {
    resultsQueue.push([]); // rule select

    const result = await convertRuleToMonitor('missing-rule', auth());

    expect(result).toEqual({ ok: false, failure: { kind: 'rule_not_found' } });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('already_managed when the rule already carries a managedByMonitorId', async () => {
    resultsQueue.push([ruleRow({ managedByMonitorId: 'monitor-9' })]);

    const result = await convertRuleToMonitor('rule-1', auth());

    expect(result).toEqual({ ok: false, failure: { kind: 'already_managed' } });
  });

  it('not_convertible for a condition GROUP (no single-monitor representation)', async () => {
    resultsQueue.push([ruleRow()]);
    resultsQueue.push([templateRow({ conditions: { logic: 'and', conditions: [] } })]);

    const result = await convertRuleToMonitor('rule-1', auth());

    expect(result).toEqual({ ok: false, failure: { kind: 'not_convertible' } });
  });

  it('not_convertible when the rule\'s targetType maps to no assignment', async () => {
    // 'monitor' is a legal legacy targetType (a rule already compiled from a
    // monitor) but `assignmentForRule` has no case for it — converting an
    // already-monitor-managed target makes no sense.
    resultsQueue.push([ruleRow({ targetType: 'monitor', targetId: 'monitor-1' })]);
    resultsQueue.push([templateRow()]);

    const result = await convertRuleToMonitor('rule-1', auth());

    expect(result).toEqual({ ok: false, failure: { kind: 'not_convertible' } });
  });

  it('partner_wide_denied for a partner-wide rule when the caller lacks canManagePartnerWidePolicies', async () => {
    resultsQueue.push([ruleRow({ orgId: null, partnerId: PARTNER })]);

    const result = await convertRuleToMonitor(
      'rule-1',
      auth({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'selected' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('partner_wide_denied');
  });

  it('#4952 regression: an ORG-scoped caller whose auth carries the owning partnerId cannot see a partner-wide rule', async () => {
    // The org token carries a partnerId (every org user's does), and it
    // matches the rule's owning partner here on purpose — canSee must still
    // be false because the caller's SCOPE is 'organization', not 'partner' or
    // 'system'. Matching on partnerId alone would leak every partner-wide
    // rule to every org user under that partner.
    resultsQueue.push([ruleRow({ orgId: null, partnerId: PARTNER })]);

    const result = await convertRuleToMonitor('rule-1', auth({ scope: 'organization', partnerId: PARTNER }));

    expect(result).toEqual({ ok: false, failure: { kind: 'rule_not_found' } });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it('template_not_found when the rule points at a template that no longer exists', async () => {
    resultsQueue.push([ruleRow()]);
    resultsQueue.push([]); // template select

    const result = await convertRuleToMonitor('rule-1', auth());

    expect(result).toEqual({ ok: false, failure: { kind: 'template_not_found' } });
  });
});
