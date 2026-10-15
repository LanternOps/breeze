import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { deploymentResults, devices, scriptExecutions, scripts } from '../db/schema';
import { deploymentResultRestorePointSql, scriptExecutionRestorePointSql } from './restorePointInline';

// The subquery aliases the ledger as `rpa`, which has its own `id` and
// `device_id`. If the OUTER column were rendered unqualified it would bind to
// the inner table (`rpa.device_id = rpa.device_id` -> always true -> another
// device's row). Drizzle drops table qualifiers on single-table selects and
// keeps them once a join exists, so pin the rendered SQL for the exact join
// shapes the two routes use.
const db = drizzle.mock();

describe('restore-point inline subqueries qualify the outer columns', () => {
  it('script execution detail (joined select)', () => {
    const { sql } = db
      .select({ rp: scriptExecutionRestorePointSql(scriptExecutions.id) })
      .from(scriptExecutions)
      .leftJoin(scripts, eq(scriptExecutions.scriptId, scripts.id))
      .leftJoin(devices, eq(scriptExecutions.deviceId, devices.id))
      .toSQL();
    expect(sql).toContain('rpa.script_execution_id = "script_executions"."id"');
  });

  it('deployment results (joined select)', () => {
    const { sql } = db
      .select({ rp: deploymentResultRestorePointSql(deploymentResults.deploymentId, deploymentResults.deviceId) })
      .from(deploymentResults)
      .leftJoin(devices, eq(deploymentResults.deviceId, devices.id))
      .toSQL();
    expect(sql).toContain('rpa.software_deployment_id = "deployment_results"."deployment_id"');
    expect(sql).toContain('rpa.device_id = "deployment_results"."device_id"');
  });
});
