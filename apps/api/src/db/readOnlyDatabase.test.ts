import { describe, expect, it } from 'vitest';
import { isReadOnlyProbeResult, isReadOnlySqlError } from './readOnlyDatabase';
import { readOnlyStartupError } from './autoMigrate';

describe('isReadOnlyProbeResult (#11731)', () => {
  it('reads the bare row array drizzle postgres-js returns', () => {
    expect(isReadOnlyProbeResult([{ ro: 'on' }])).toBe(true);
    expect(isReadOnlyProbeResult([{ ro: 'off' }])).toBe(false);
  });

  it('reads a { rows } wrapper', () => {
    expect(isReadOnlyProbeResult({ rows: [{ ro: 'on' }] })).toBe(true);
    expect(isReadOnlyProbeResult({ rows: [{ ro: 'off' }] })).toBe(false);
  });

  it.each([undefined, null, [], {}, { rows: null }, [{}], [{ ro: true }], 'on'])(
    'throws on an unexpected shape (%j) so the probe failure is reported, never read as a healthy answer',
    (value) => {
      expect(() => isReadOnlyProbeResult(value)).toThrow(/transaction_read_only probe/);
    },
  );
});

describe('readOnlyStartupError (#11731)', () => {
  it('names the condition, what startup needed, and what the operator can do', () => {
    const error = readOnlyStartupError('apply 2 pending migration(s) (a.sql, b.sql)');

    expect(error.name).toBe('ReadOnlyDatabaseError');
    expect(error.message).toContain('read-only');
    expect(error.message).toContain('25006');
    expect(error.message).toContain('apply 2 pending migration(s) (a.sql, b.sql)');
    expect(error.message).toContain('default_transaction_read_only');
    expect(error.message).toMatch(/Make the database writable/);
  });
});

describe('isReadOnlySqlError (#11731)', () => {
  it('matches SQLSTATE 25006 directly and through a drizzle-style cause', () => {
    const pg = Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' });
    expect(isReadOnlySqlError(pg)).toBe(true);
    expect(isReadOnlySqlError(Object.assign(new Error('Failed query: update ...'), { cause: pg }))).toBe(true);
  });

  it('does not match other errors', () => {
    expect(isReadOnlySqlError(Object.assign(new Error('x'), { code: '40001' }))).toBe(false);
    expect(isReadOnlySqlError(new Error('plain'))).toBe(false);
    expect(isReadOnlySqlError(null)).toBe(false);
  });
});
