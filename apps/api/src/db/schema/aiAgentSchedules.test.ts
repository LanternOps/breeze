import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { aiAgentSchedules } from './aiAgentSchedules';
import { aiAgentRuns } from './aiAgents';
import { actionIntents } from './actionIntents';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

// NOTE: the task brief's Step 1 sample imports `CORE_ORG_CASCADE_DELETE_ORDER`
// and `ORG_MERGE_REGISTRY` directly — neither is exported under those names
// (see aiAlertVerdicts.test.ts's own note on this). `tenantCascade.ts` only
// exports the alias `ORG_CASCADE_DELETE_ORDER`, and `orgMergeRegistry.ts` only
// exposes its SPECIAL map through the public `getOrgMergePolicies()` function.
// Using the real exported surface here per the controller's decision.
describe('ai_agent_schedules schema + ceremonies', () => {
  it('declares the schedule columns', () => {
    expect(getTableName(aiAgentSchedules)).toBe('ai_agent_schedules');
    expect(Object.keys(getTableColumns(aiAgentSchedules))).toEqual(expect.arrayContaining([
      'id', 'orgId', 'partnerId', 'agentId', 'baselineScheduleId', 'cron', 'timezone',
      'sweepKinds', 'enabled', 'lastEnqueuedAt', 'lastOccurrenceKey', 'lastRunSummary',
      'createdBy', 'createdAt', 'updatedAt',
    ]));
  });
  it('adds schedule_id to ai_agent_runs and the typed scope to action_intents', () => {
    expect(getTableColumns(aiAgentRuns).scheduleId).toBeDefined();
    const intentCols = getTableColumns(actionIntents);
    expect(intentCols.scopeKind).toBeDefined();
    expect(intentCols.scopeDeviceId).toBeDefined();
  });
  it('is registered in every org-cascade contract', () => {
    const order = ORG_CASCADE_DELETE_ORDER;
    expect(order).toContain('ai_agent_schedules');
    expect(order.indexOf('ai_agent_runs')).toBeLessThan(order.indexOf('ai_agent_schedules'));
    expect(order.indexOf('ai_agent_schedules')).toBeLessThan(order.indexOf('ai_agents'));
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_schedules).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs!.columns.schedule_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.action_intents!.columns.scope_kind).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.action_intents!.columns.scope_device_id).toBeDefined();
    expect(getOrgMergePolicies().get('ai_agent_schedules')).toEqual(expect.objectContaining({ kind: 'leave-for-erasure' }));
  });
});
