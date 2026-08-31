import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiKillState } from './aiKillState';

describe('ai_kill_state schema', () => {
  it('exposes exactly the kill-state columns', () => {
    const cols = getTableColumns(aiKillState);
    expect(Object.keys(cols).sort()).toEqual(
      ['id', 'killed', 'epoch', 'reason', 'updatedBy', 'updatedAt'].sort(),
    );
  });

  it('defaults to a single not-killed row at epoch 0 (inertness: pure pass-through until flipped)', () => {
    const cols = getTableColumns(aiKillState);
    expect(cols.id.default).toBe('global');
    expect(cols.killed.notNull).toBe(true);
    expect(cols.killed.default).toBe(false);
    expect(cols.epoch.notNull).toBe(true);
    expect(cols.epoch.default).toBe(0);
  });

  it('leaves reason and updatedBy nullable (no writer in this PR)', () => {
    const cols = getTableColumns(aiKillState);
    expect(cols.reason.notNull).toBe(false);
    expect(cols.updatedBy.notNull).toBe(false);
  });
});
