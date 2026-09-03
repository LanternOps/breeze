import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptExecutions, executionStatusEnum, scriptCancelStateEnum } from './scripts';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const readMigration = (name: string) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8');

const ENUM_MIGRATION = '2026-10-07-100000-cancellation-enums.sql';
const COLUMN_MIGRATION = '2026-10-07-100100-cancellation-columns.sql';

/**
 * #3525 W02. `status` describes what happened to the PROCESS; `cancel_state`
 * describes what happened to the CANCEL REQUEST. They are orthogonal on
 * purpose (spec OD8-C) — a cancel that could not be proven reverts `status`
 * to `cancel_prev_status` rather than lying about the outcome.
 */
describe('script_executions cancellation columns', () => {
  it('execution_status carries the transient cancelling value', () => {
    expect(executionStatusEnum.enumValues).toContain('cancelling');
  });

  it('script_cancel_state has exactly the four lifecycle values', () => {
    expect([...scriptCancelStateEnum.enumValues].sort())
      .toEqual(['confirmed', 'failed', 'requested', 'unconfirmed']);
  });

  it('exposes all five cancellation columns', () => {
    const cols = Object.keys(scriptExecutions);
    for (const c of ['cancelRequestedAt', 'cancelledBy', 'cancelState', 'cancelCommandId', 'cancelPrevStatus']) {
      expect(cols, `missing ${c}`).toContain(c);
    }
  });

  it('cancel_prev_status reuses execution_status so a revert is always representable', () => {
    // A revert writes the exact value `status` held at request time. A narrower
    // type here would silently drop a legal prior status.
    expect(scriptExecutions.cancelPrevStatus.enumValues).toEqual(executionStatusEnum.enumValues);
  });

  it('the Drizzle enum order matches the order the migration installs', () => {
    // drizzle-kit compares the declared value ORDER against the introspected
    // type, so `ADD VALUE ... AFTER 'running'` and the TS array must agree or
    // `db:check-drift` reports drift that does not exist.
    const sql = readMigration(ENUM_MIGRATION);
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'cancelling' AFTER 'running'");
    expect(executionStatusEnum.enumValues.indexOf('cancelling'))
      .toBe(executionStatusEnum.enumValues.indexOf('running') + 1);
  });
});

describe('cancellation migrations', () => {
  it('adds enum values in a file separate from the one that writes those literals', () => {
    // Postgres forbids USING a new enum literal in the transaction that ADDs
    // it, and autoMigrate wraps each file in exactly one transaction.
    const enums = readMigration(ENUM_MIGRATION);
    const columns = readMigration(COLUMN_MIGRATION);
    expect(enums).not.toMatch(/ALTER TABLE script_executions/i);
    expect(columns).toMatch(/WHERE status = 'cancelling'/);
    expect(ENUM_MIGRATION < COLUMN_MIGRATION).toBe(true);
  });

  it('is idempotent — every statement is guarded', () => {
    for (const name of [ENUM_MIGRATION, COLUMN_MIGRATION]) {
      const sql = readMigration(name);
      expect(sql, `${name} must not open its own transaction`).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
      const guards = [
        [/ADD VALUE(?! IF NOT EXISTS)/, 'ADD VALUE without IF NOT EXISTS'],
        [/ADD COLUMN(?! IF NOT EXISTS)/, 'ADD COLUMN without IF NOT EXISTS'],
        [/CREATE INDEX(?! IF NOT EXISTS)/, 'CREATE INDEX without IF NOT EXISTS'],
      ] as const;
      for (const [pattern, guard] of guards) {
        expect(sql, `${name}: ${guard}`).not.toMatch(pattern);
      }
    }
  });

  it('constrains cancel_state and cancel_requested_at to move together', () => {
    // Either the cancellation lifecycle started or it did not. A state with no
    // request time (or the reverse) is unreadable by every closer.
    const sql = readMigration(COLUMN_MIGRATION);
    expect(sql).toMatch(/CHECK \(\(cancel_state IS NULL\) = \(cancel_requested_at IS NULL\)\)/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS script_executions_cancel_state_chk/);
  });

  it('cancelled_by drops to NULL on user delete so org erasure cannot trip on it', () => {
    expect(readMigration(COLUMN_MIGRATION)).toMatch(/cancelled_by uuid REFERENCES users\(id\) ON DELETE SET NULL/);
  });
});
