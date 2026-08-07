import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/schema', () => ({
  backupJobs: {
    id: 'backup_jobs.id',
    startedAt: 'backup_jobs.started_at',
    createdAt: 'backup_jobs.created_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  desc: (value: unknown) => ({ op: 'desc', value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
}));

const {
  backupJobHistoryOrderBy,
  compareBackupRunRecency,
  latestBackupRunOrderBy,
} = await import('./backupJobOrdering');

/** Renders a mocked drizzle order term to a comparable string. */
function render(term: any): string {
  if (term.op === 'desc') return `${term.value} desc`;
  return term.strings
    .map((s: string, i: number) => s + (i < term.values.length ? String(term.values[i]) : ''))
    .join('')
    .trim();
}

function job(overrides: Partial<{ id: string; startedAt: Date | null; createdAt: Date }> = {}) {
  return {
    id: 'job-a',
    startedAt: new Date('2026-08-05T06:35:00.000Z'),
    createdAt: new Date('2026-08-05T06:32:11.829738Z'),
    ...overrides,
  };
}

describe('latestBackupRunOrderBy', () => {
  it('orders by started_at desc NULLS LAST, then created_at, then id', () => {
    expect(latestBackupRunOrderBy.map(render)).toEqual([
      'backup_jobs.started_at desc nulls last',
      'backup_jobs.created_at desc',
      'backup_jobs.id desc',
    ]);
  });

  it('does not order by created_at first — created_at is only the insert clock', () => {
    expect(render(latestBackupRunOrderBy[0])).not.toContain('created_at');
  });

  it('never uses a bare DESC on started_at (Postgres would put NULLs FIRST)', () => {
    const startedTerm = render(latestBackupRunOrderBy[0]);
    expect(startedTerm).toContain('nulls last');
  });
});

describe('backupJobHistoryOrderBy', () => {
  it('keeps created_at primary but makes the order total', () => {
    expect(backupJobHistoryOrderBy.map(render)).toEqual([
      'backup_jobs.created_at desc',
      'backup_jobs.started_at desc nulls last',
      'backup_jobs.id desc',
    ]);
  });
});

describe('compareBackupRunRecency', () => {
  it('breaks an identical created_at tie in favour of the later started_at', () => {
    // The exact release-QA shape: two jobs written by one profile fan-out inside
    // a single transaction, so created_at matches to the microsecond. Ordering by
    // created_at alone is not a total order and the planner returned the OLDER
    // run first, which hid the device tab's VSS Status panel.
    const sameCreatedAt = new Date('2026-08-05T06:32:11.829738Z');
    const older = job({ id: 'job-older', createdAt: sameCreatedAt, startedAt: new Date('2026-08-05T06:32:20.000Z') });
    const newer = job({ id: 'job-newer', createdAt: sameCreatedAt, startedAt: new Date('2026-08-05T06:40:00.000Z') });

    expect([older, newer].sort(compareBackupRunRecency)[0]).toBe(newer);
    // ...and from the opposite input order, because a tie-break that depends on
    // input order is exactly the bug.
    expect([newer, older].sort(compareBackupRunRecency)[0]).toBe(newer);
  });

  it('is deterministic on id when started_at AND created_at both tie', () => {
    const startedAt = new Date('2026-08-05T06:40:00.000Z');
    const createdAt = new Date('2026-08-05T06:32:11.829738Z');
    const a = job({ id: 'aaaa', startedAt, createdAt });
    const b = job({ id: 'bbbb', startedAt, createdAt });

    expect([a, b].sort(compareBackupRunRecency).map((j) => j.id)).toEqual(['bbbb', 'aaaa']);
    expect([b, a].sort(compareBackupRunRecency).map((j) => j.id)).toEqual(['bbbb', 'aaaa']);
  });

  it('does not let a never-started job displace a real completed run', () => {
    // A `pending` job has no started_at: it has not run, so it carries no
    // snapshot, no VSS metadata and no error log. Letting it win would blank the
    // device tab every time a backup was queued.
    const completed = job({ id: 'job-completed', startedAt: new Date('2026-08-05T06:35:00.000Z'), createdAt: new Date('2026-08-05T06:32:00.000Z') });
    const pending = job({ id: 'job-pending', startedAt: null, createdAt: new Date('2026-08-05T07:00:00.000Z') });

    expect([completed, pending].sort(compareBackupRunRecency)[0]).toBe(completed);
    expect([pending, completed].sort(compareBackupRunRecency)[0]).toBe(completed);
  });

  it('still surfaces a pending job when nothing has ever run', () => {
    // NULLS LAST only demotes — a device whose every job is queued must not
    // report "no backup jobs at all".
    const p1 = job({ id: 'p1', startedAt: null, createdAt: new Date('2026-08-05T06:00:00.000Z') });
    const p2 = job({ id: 'p2', startedAt: null, createdAt: new Date('2026-08-05T07:00:00.000Z') });

    expect([p1, p2].sort(compareBackupRunRecency)[0]).toBe(p2);
  });

  it('accepts ISO strings as well as Dates (JSON-decoded rows)', () => {
    const older = { id: 'a', startedAt: '2026-08-05T06:00:00.000Z', createdAt: '2026-08-05T06:00:00.000Z' };
    const newer = { id: 'b', startedAt: '2026-08-05T08:00:00.000Z', createdAt: '2026-08-05T06:00:00.000Z' };

    expect([older, newer].sort(compareBackupRunRecency)[0]).toBe(newer);
  });
});
