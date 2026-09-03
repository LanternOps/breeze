import { describe, it, expect } from 'vitest';
import {
  EXECUTION_STATUSES,
  AUTOMATION_RUN_STATUSES,
  type ExecutionStatus,
  type AutomationRunStatus,
} from './index';

describe('status unions are enumerable', () => {
  it('EXECUTION_STATUSES matches the execution_status pgEnum', () => {
    expect([...EXECUTION_STATUSES].sort()).toEqual(
      ['cancelled', 'cancelling', 'completed', 'failed', 'pending', 'queued', 'running', 'timeout'].sort(),
    );
  });

  it('AUTOMATION_RUN_STATUSES matches the automation_run_status pgEnum', () => {
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
