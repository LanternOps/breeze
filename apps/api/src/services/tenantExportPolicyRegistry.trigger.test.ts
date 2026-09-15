import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { actionIntents } from '../db/schema/actionIntents';
import { scriptExecutions } from '../db/schema/scripts';
import { automationActionResults } from '../db/schema/automations';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

// Registration shipped with DDL in Task 2; this also pins Drizzle parity.
describe('remediation trigger columns', () => {
  for (const [table, schema] of Object.entries({ action_intents: actionIntents, script_executions: scriptExecutions, automation_action_results: automationActionResults })) {
    for (const [property, column] of Object.entries({ triggerKind: 'trigger_kind', triggerRefId: 'trigger_ref_id', triggerKey: 'trigger_key' })) {
      it(`${table}.${column} is mapped and included`, () => {
        expect(getTenantExportPolicyRegistry()[table]?.columns[column]?.decision).toBe('include');
        expect((getTableColumns(schema) as Record<string, { name: string }>)[property]?.name).toBe(column);
      });
    }
  }
});
