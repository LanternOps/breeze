import { describe, it, expect } from 'vitest';
import { EXECUTION_STATUSES, CANCEL_STATES } from '@breeze/shared';
import {
  executionRowStatusConfig,
  executionDetailStatusConfig,
  resolveExecutionStatusLabel,
} from './executionStatus';

describe('every execution status resolves in both status maps', () => {
  it.each(EXECUTION_STATUSES)('row config has label, color and icon for %s', (status) => {
    const entry = executionRowStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('detail config has label, color, bgColor and icon for %s', (status) => {
    const entry = executionDetailStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.bgColor).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('label resolution never returns empty for %s with no cancel state', (status) => {
    expect(resolveExecutionStatusLabel(status, null)).toBeTruthy();
  });

  it('an unconfirmed cancel gets its own label, distinct from a confirmed one', () => {
    expect(resolveExecutionStatusLabel('cancelled', 'confirmed'))
      .not.toBe(resolveExecutionStatusLabel('completed', 'unconfirmed'));
    expect(resolveExecutionStatusLabel('completed', 'unconfirmed'))
      .toBe('status.completedCancelTooLate');
  });

  it.each(CANCEL_STATES)('every cancel state resolves a label against a terminal status: %s', (cancelState) => {
    expect(resolveExecutionStatusLabel('completed', cancelState)).toBeTruthy();
  });
});
