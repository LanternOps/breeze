import { describe, expect, it } from 'vitest';
import {
  collapseAncestorDirectories,
  formatBytes,
  isDescendantPath,
  normalizeHierarchyPath,
  readThresholdEvents,
  selectedBytes,
  summariseActionStatuses,
  type CleanupAction,
  type CommandRow,
} from './filesystemTabUtils';

describe('formatBytes', () => {
  it('renders a dash for a missing or non-finite value', () => {
    expect(formatBytes(undefined)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });

  it('renders exact bytes below a kibibyte and scales above it', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.00 TB');
  });
});

describe('normalizeHierarchyPath', () => {
  it('lower-cases, flips separators and collapses doubles', () => {
    expect(normalizeHierarchyPath('C:\\Users\\\\Admin\\')).toBe('c:/users/admin');
  });

  it('keeps the trailing slash on a Windows drive root and on /', () => {
    expect(normalizeHierarchyPath('C:\\')).toBe('c:/');
    expect(normalizeHierarchyPath('/')).toBe('/');
  });
});

describe('isDescendantPath', () => {
  it('is false for the same path and for an unrelated sibling', () => {
    expect(isDescendantPath('/var/log', '/var/log')).toBe(false);
    expect(isDescendantPath('/var/logging', '/var/log')).toBe(false);
  });

  it('is true under a POSIX ancestor, / and a Windows drive root', () => {
    expect(isDescendantPath('/var/log/syslog', '/var/log')).toBe(true);
    expect(isDescendantPath('/var', '/')).toBe(true);
    expect(isDescendantPath('C:\\Windows\\Temp', 'C:\\')).toBe(true);
  });
});

describe('collapseAncestorDirectories', () => {
  it('drops an ancestor whose size is explained by one child', () => {
    const rows = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/big', sizeBytes: 95 },
      { path: '/other', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(rows, 5).map((r) => r.path)).toEqual(['/data/big', '/other']);
  });

  it('keeps an ancestor whose children are all small', () => {
    const rows = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/small', sizeBytes: 10 },
    ];
    expect(collapseAncestorDirectories(rows, 5).map((r) => r.path)).toEqual(['/data', '/data/small']);
  });

  it('is stricter when the ancestor is an estimate and the child is measured', () => {
    // An estimated ancestor at 100 with a MEASURED child at 50 is explained by
    // that child (ratio drops to 0.45); the same pair both-measured is not.
    const estimated = [
      { path: '/data', sizeBytes: 100, estimated: true },
      { path: '/data/child', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(estimated, 5).map((r) => r.path)).toEqual(['/data/child']);

    const measured = [
      { path: '/data', sizeBytes: 100 },
      { path: '/data/child', sizeBytes: 50 },
    ];
    expect(collapseAncestorDirectories(measured, 5).map((r) => r.path)).toEqual(['/data', '/data/child']);
  });

  it('returns nothing for a non-positive limit and tolerates missing paths', () => {
    expect(collapseAncestorDirectories([{ path: '/a', sizeBytes: 1 }], 0)).toEqual([]);
    expect(collapseAncestorDirectories([{ sizeBytes: 1 }, { path: '/a', sizeBytes: 2 }], 5))
      .toEqual([{ path: '/a', sizeBytes: 2 }]);
  });
});

describe('readThresholdEvents', () => {
  const cmd = (over: Partial<CommandRow> & { payload?: unknown }): CommandRow => ({
    id: 'c1', type: 'filesystem_analysis', status: 'completed', createdAt: '2026-09-19T10:00:00Z', ...over,
  });

  it('keeps only threshold-triggered filesystem_analysis commands, newest first', () => {
    const events = readThresholdEvents([
      cmd({ id: 'a', createdAt: '2026-09-19T09:00:00Z', payload: { trigger: 'threshold', path: 'C:\\' } }),
      cmd({ id: 'b', createdAt: '2026-09-19T11:00:00Z', payload: { trigger: 'threshold', path: 'D:\\' } }),
      cmd({ id: 'c', payload: { trigger: 'on_demand', path: 'C:\\' } }),
      cmd({ id: 'd', type: 'script_execute', payload: { trigger: 'threshold' } }),
    ]);
    expect(events.map((e) => e.id)).toEqual(['b', 'a']);
    expect(events[0].path).toBe('D:\\');
  });

  it('caps the list at 8 and falls back to a dash for a missing path', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      cmd({ id: `c${i}`, createdAt: `2026-09-${10 + i}T10:00:00Z`, payload: { trigger: 'threshold' } }));
    const events = readThresholdEvents(many);
    expect(events).toHaveLength(8);
    expect(events[0].path).toBe('-');
  });
});

describe('summariseActionStatuses', () => {
  it('counts every outcome bucket, including the ones with no rows', () => {
    const actions: CleanupAction[] = [
      { path: '/a', category: 'temp_files', sizeBytes: 1, status: 'completed' },
      { path: '/b', category: 'temp_files', sizeBytes: 1, status: 'completed' },
      { path: '/c', category: 'trash', sizeBytes: 1, status: 'skipped_locked' },
      { path: '/d', category: 'trash', sizeBytes: 1, status: 'failed', error: 'boom' },
    ];
    expect(summariseActionStatuses(actions)).toEqual({
      completed: 2, failed: 1, skipped_locked: 1, rejected: 0, skipped_budget: 0,
    });
  });
});

describe('selectedBytes', () => {
  it('sums only the checked candidates', () => {
    const candidates = [
      { path: '/a', category: 'temp_files', sizeBytes: 100 },
      { path: '/b', category: 'temp_files', sizeBytes: 200 },
    ];
    expect(selectedBytes(candidates, new Set(['/b']))).toBe(200);
    expect(selectedBytes(candidates, new Set())).toBe(0);
  });
});
