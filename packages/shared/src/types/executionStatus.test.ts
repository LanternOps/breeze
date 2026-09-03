import { describe, it, expect } from 'vitest';
import {
  EXECUTION_STATUSES,
  AUTOMATION_RUN_STATUSES,
  type ExecutionStatus,
  type AutomationRunStatus,
} from './index';

// This asserts the app-level unions' own shape, not live parity with the DB
// enums: apps/api/src/db/schema/scripts.ts's execution_status pgEnum doesn't
// gain 'cancelling' until W02's migration, and automations.ts's
// automation_run_status pgEnum doesn't gain 'cancelled' until W05. This suite
// widens ahead of the DB on purpose (#3525) — it is not a drift guard against
// the schema files, which have no runtime link to this package.
describe('status unions are enumerable', () => {
  it('EXECUTION_STATUSES is the full widened set, including the not-yet-in-DB cancelling state', () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual(
      ['cancelled', 'cancelling', 'completed', 'failed', 'pending', 'queued', 'running', 'timeout'].sort(),
    );
  });

  it('AUTOMATION_RUN_STATUSES is the full widened set, including the not-yet-in-DB cancelled state', () => {
    expect([...AUTOMATION_RUN_STATUSES].sort()).toEqual(
      ['cancelled', 'completed', 'failed', 'partial', 'running'].sort(),
    );
  });

  it('the arrays are assignable to their unions', () => {
    const e: readonly ExecutionStatus[] = EXECUTION_STATUSES;
    const a: readonly AutomationRunStatus[] = AUTOMATION_RUN_STATUSES;
    expect(e.length).toBe(8);
    expect(a.length).toBe(5);
  });
});
