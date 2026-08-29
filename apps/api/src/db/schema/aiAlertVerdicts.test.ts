import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { aiAlertVerdicts } from './aiAlertVerdicts';
import { aiAgentRuns } from './aiAgents';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

// NOTE: the task brief's Step 1 sample imports `CORE_ORG_CASCADE_DELETE_ORDER`
// and `ORG_MERGE_REGISTRY` directly — neither is exported under those names.
// `tenantCascade.ts` only exports the alias `ORG_CASCADE_DELETE_ORDER`, and
// `orgMergeRegistry.ts` only exposes its SPECIAL map through the public
// `getOrgMergePolicies()` function (or `__testOnly.SPECIAL`). Using the real
// exported surface here per the controller's decision 4.
describe('ai_alert_verdicts schema + ceremonies', () => {
  it('declares the verdict columns', () => {
    expect(getTableName(aiAlertVerdicts)).toBe('ai_alert_verdicts');
    const cols = Object.keys(getTableColumns(aiAlertVerdicts));
    expect(cols).toEqual(expect.arrayContaining([
      'id', 'orgId', 'runId', 'alertId', 'correlationGroupId', 'classification',
      'confidence', 'rationale', 'pattern', 'suggestedIntentId', 'feedback',
      'feedbackBy', 'feedbackAt', 'supersededBy', 'createdAt',
    ]));
  });
  it('adds profile + correlation_group_id to ai_agent_runs', () => {
    const cols = getTableColumns(aiAgentRuns);
    expect(cols.profile).toBeDefined();
    expect(cols.correlationGroupId).toBeDefined();
  });
  it('is registered in every org-cascade contract', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('ai_alert_verdicts');
    expect(CORE_TENANT_EXPORT_POLICY.ai_alert_verdicts).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs!.columns.profile).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs!.columns.correlation_group_id).toBeDefined();
    expect(getOrgMergePolicies().get('ai_alert_verdicts')).toBeDefined();
  });
});
