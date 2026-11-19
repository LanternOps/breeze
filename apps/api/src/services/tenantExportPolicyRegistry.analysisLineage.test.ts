import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiAgentRuns } from '../db/schema/aiAgents';
import { aiRunArtifacts } from '../db/schema/aiWorkspace';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

// Wisp analysis sessions W03: the lineage columns and the export dataset are
// registered with the DDL, and Drizzle maps each to its SQL name.
describe('analysis lineage columns (Wisp analysis sessions W03)', () => {
  it.each([
    { table: 'ai_agent_runs', schema: aiAgentRuns, property: 'continuedFromRunId', column: 'continued_from_run_id' },
    { table: 'ai_agent_runs', schema: aiAgentRuns, property: 'chainRootRunId', column: 'chain_root_run_id' },
    { table: 'ai_agent_runs', schema: aiAgentRuns, property: 'chainDepth', column: 'chain_depth' },
    { table: 'ai_run_artifacts', schema: aiRunArtifacts, property: 'dataset', column: 'dataset' },
  ] as const)('$table.$column is mapped and included', ({ table, schema, property, column }) => {
    expect(getTenantExportPolicyRegistry()[table]?.columns[column]?.decision).toBe('include');
    expect((getTableColumns(schema) as Record<string, { name: string }>)[property]?.name).toBe(column);
  });
});
