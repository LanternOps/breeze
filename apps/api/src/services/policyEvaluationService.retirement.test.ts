import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { automations, devices, organizations } from '../db/schema';

const mocks = vi.hoisted(() => ({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), enqueue: vi.fn() }));
vi.mock('../db', () => ({ db: mocks }));
vi.mock('../jobs/automationWorker', () => ({ enqueueAutomationRun: mocks.enqueue }));
vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./featureConfigResolver', () => ({ resolveComplianceRulesForDevice: vi.fn(), scanDueComplianceChecks: vi.fn() }));
import { resolvePolicyRemediationAutomationIdForOrg, __triggerRemediationAutomation, __triggerConfigPolicyRemediation } from './policyEvaluationService';

const device = { id: 'device-1', orgId: 'org-1', hostname: 'host', osType: 'windows', osVersion: '11' };
const policy = { id: 'policy-1', rules: [], remediationScriptId: 'script-1' } as never;
const rule = { id: 'rule-1', remediationScriptId: 'script-1', name: 'rule' } as never;
let reads: string[];
let retireOnRead: number;

beforeEach(() => {
  vi.clearAllMocks();
  reads = [];
  retireOnRead = 1;
  mocks.insert.mockReturnValue({ values: () => ({ returning: async () => [{ id: 'run-1' }] }) });
  mocks.update.mockReturnValue({ set: () => ({ where: async () => undefined }) });
  mocks.select.mockImplementation(() => {
    let table: unknown;
    let predicate: SQL;
    const result = () => {
      if (table === organizations) return [{ partnerId: null }];
      if (table === devices) return [{ orgId: device.orgId }];
      if (table !== automations) throw new Error('Unexpected table');
      const sql = new PgDialect().sqlToQuery(predicate).sql;
      reads.push(sql);
      const retired = reads.length >= retireOnRead;
      if (retired && sql.includes('"automations"."retired_at" is null')) return [];
      return [{ id: 'automation-1', orgId: device.orgId, enabled: true, retiredAt: retired ? new Date() : null, actions: [{ scriptId: 'script-1' }] }];
    };
    const chain = {
      from(value: unknown) { table = value; return chain; },
      where(value: SQL) { predicate = value; return chain; },
      limit: async () => result(),
      then(resolve: (rows: unknown[]) => unknown) { return Promise.resolve(result()).then(resolve); },
    };
    return chain;
  });
});

describe('policy remediation excludes retired automation sources', () => {
  it('does not resolve a retired script candidate', async () => {
    expect(await resolvePolicyRemediationAutomationIdForOrg(policy, device.orgId)).toBeNull();
    expect(reads).toHaveLength(1);
  });
  it('does not run an explicitly selected retired automation', async () => {
    expect(await __triggerRemediationAutomation(policy, device, 'non_compliant', 'automation-1')).toBeNull();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it.each([1, 2])('does not run a config policy automation retired at lookup %s', async (lookup) => {
    retireOnRead = lookup;
    expect(await __triggerConfigPolicyRemediation(rule, device)).toBe(false);
    expect(reads).toHaveLength(lookup);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('still resolves a live script candidate', async () => {
    retireOnRead = Infinity;
    expect(await resolvePolicyRemediationAutomationIdForOrg(policy, device.orgId)).toBe('automation-1');
  });
});
