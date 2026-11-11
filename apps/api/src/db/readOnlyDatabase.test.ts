import { describe, expect, it } from 'vitest';
import { isReadOnlyProbeResult } from './readOnlyDatabase';
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
    'treats an unexpected shape (%j) as not read-only',
    (value) => {
      expect(isReadOnlyProbeResult(value)).toBe(false);
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
