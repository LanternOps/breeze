import { beforeEach, describe, expect, it, vi } from 'vitest';

// Failure paths must stop before the group writer. Successful adapter tests
// mock its transaction boundary and verify the group scope and selected output.
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

const { previewGroup, convertGroup } = vi.hoisted(() => ({ previewGroup: vi.fn(), convertGroup: vi.fn() }));
vi.mock('./conversion/convert', () => ({
  previewTemplateGroup: previewGroup, convertTemplateGroup: convertGroup,
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
    orgId: ORG, partnerId: null,
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
  vi.clearAllMocks();
  previewGroup.mockResolvedValue({ previewHash: 'group-hash' });
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

  it('not_convertible for an empty condition group', async () => {
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


describe('template group conversion adapter', () => {
  it('previews the whole group and returns the selected primary plus all converted ids', async () => {
    resultsQueue.push([ruleRow()], [templateRow()]);
    convertGroup.mockResolvedValue({ conversionId: 'ledger-1', convertedRuleIds: ['rule-1', 'rule-2'], outputs: [
      { sourceRuleId: 'rule-2', role: 'primary', monitorId: 'monitor-2', policyId: 'policy-2' },
      { sourceRuleId: 'rule-1', role: 'primary', monitorId: 'monitor-1', policyId: 'policy-1' },
    ] });
    const caller = auth();
    expect(await convertRuleToMonitor('rule-1', caller)).toEqual({ ok: true, data: {
      monitorId: 'monitor-1', configPolicyId: 'policy-1', ruleName: 'CPU rule', ruleOrgId: ORG,
      conversionId: 'ledger-1', convertedRuleIds: ['rule-1', 'rule-2'],
    } });
    expect(previewGroup).toHaveBeenCalledWith('template-1', caller, dbMock);
    expect(convertGroup).toHaveBeenCalledWith('template-1', 'group-hash', caller, dbMock);
    expect(previewGroup.mock.invocationCallOrder[0]).toBeLessThan(convertGroup.mock.invocationCallOrder[0]!);
  });

  it('refuses the whole group when a sibling cannot convert', async () => {
    resultsQueue.push([ruleRow()], [templateRow()]);
    previewGroup.mockResolvedValue({ previewHash: 'group-hash', blockedBy: 'unconvertible' });
    expect(await convertRuleToMonitor('rule-1', auth())).toEqual({ ok: false, failure: { kind: 'not_convertible' } });
    expect(convertGroup).not.toHaveBeenCalled();
  });

  it('uses the supplied caller transaction for all lookups and group operations', async () => {
    const executor = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [ruleRow()] }) }) })) };
    previewGroup.mockResolvedValue({ previewHash: 'group-hash', blockedBy: 'unconvertible' });
    await convertRuleToMonitor('rule-1', auth(), executor as never);
    expect(executor.select).toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
  });
});
