import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiAgentSchedules } from './aiAgentSchedules';
import { aiAgentRuns } from './aiAgents';
import { reportRuns, reports, reportTypeEnum } from './reports';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

// Phase 2 wave P2-3 (#4187 / #4190): weekly org narrative. Migrations under
// test: 2026-09-24-a-report-type-ai-org-narrative.sql (enum label) and
// 2026-09-24-b-ai-agents-org-narrative.sql (columns/constraints). This suite
// covers the Drizzle + registry side only — the DB-constraint behaviour lives
// in __tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts.
describe('P2-3 schema', () => {
  it('adds the P2-3 columns', () => {
    expect(getTableColumns(aiAgentSchedules).kind).toBeDefined();
    expect(getTableColumns(aiAgentRuns).reportRunId).toBeDefined();
    expect(getTableColumns(reports).sourceAiAgentScheduleId).toBeDefined();
    expect(getTableColumns(reports).executionScopePrincipalKind).toBeDefined();
    expect(getTableColumns(reportRuns).executionScopePrincipalKind).toBeDefined();
  });

  it('report_type enum carries ai_org_narrative', () => {
    expect(reportTypeEnum.enumValues).toContain('ai_org_narrative');
  });

  // The export-policy contract fires on a NEW COLUMN of an already-registered
  // org-cascade table, not only on a new table (CLAUDE.md). `report_runs` has
  // no org_id, so it has no policy entry and deliberately gets none here.
  // Accessor shape mirrors aiAgentSchedules.test.ts exactly (the registry's
  // index signature is optional-valued, hence the `!`).
  it('export policy classifies the new org-cascade columns', () => {
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_schedules!.columns.kind).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.ai_agent_runs!.columns.report_run_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.reports!.columns.source_ai_agent_schedule_id).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.reports!.columns.execution_scope_principal_kind).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.report_runs).toBeUndefined();
  });
});
