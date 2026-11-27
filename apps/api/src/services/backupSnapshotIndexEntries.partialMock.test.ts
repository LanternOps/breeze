import { describe, expect, it, vi } from 'vitest';

// A test that replaces `drizzle-orm` with a partial mock (no `sql.identifier`)
// must still be able to import anything that reaches the index read path.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const sql = Object.assign(
    (...args: Parameters<typeof actual.sql>) => actual.sql(...args),
    { ...actual.sql },
  );
  Reflect.deleteProperty(sql, 'identifier');
  return { ...actual, sql };
});

describe('backupSnapshotIndexEntries import', () => {
  it('loads without calling sql.identifier at module scope', async () => {
    const mod = await import('./backupSnapshotIndexEntries');
    expect(typeof mod.snapshotIndexEntries).toBe('function');
  });
});
