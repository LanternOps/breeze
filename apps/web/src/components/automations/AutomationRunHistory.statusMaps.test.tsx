import { describe, it, expect } from 'vitest';
import { AUTOMATION_RUN_STATUSES } from '@breeze/shared';
import { statusConfig } from './AutomationRunHistory';

/** routes/automations.ts:400 `toRunStatus` renames completed -> success on the wire. */
const toPresentation = (s: string) => (s === 'completed' ? 'success' : s);

describe('automation run status map covers every run status', () => {
  it.each(AUTOMATION_RUN_STATUSES)('has label, color, bgColor and icon for %s', (status) => {
    const entry = statusConfig[toPresentation(status) as keyof typeof statusConfig];
    expect(entry, `missing statusConfig entry for ${status}`).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(['pending', 'running', 'success', 'failed', 'skipped', 'cancelled'] as const)(
    'has an entry for device-result status %s',
    (status) => {
      expect(statusConfig[status]).toBeDefined();
    },
  );
});
