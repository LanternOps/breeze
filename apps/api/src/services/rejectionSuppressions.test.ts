import { describe, it, expect } from 'vitest';
import { isBenignRejection, isRecoverablePostgresConnectionTeardown } from './rejectionSuppressions';

describe('isBenignRejection', () => {
  it('suppresses ProcessTransport-not-ready', () => {
    expect(isBenignRejection(new Error('ProcessTransport is not ready for writing'))).toBe(true);
  });
  it('suppresses AbortError by name', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(isBenignRejection(e)).toBe(true);
  });
  it('suppresses "Operation aborted" + Transport', () => {
    expect(isBenignRejection(new Error('Operation aborted on Transport'))).toBe(true);
  });
  it('does NOT suppress a real error', () => {
    expect(isBenignRejection(new Error('TypeError: cannot read x of undefined'))).toBe(false);
  });
});

// Builds a TypeError shaped like the one postgres@3 throws from the orphaned
// `nextWrite` Immediate when the backend connection is torn down (idle-in-
// transaction timeout firing during slow non-DB work, #1105) while a write is
// still buffered. The throw escapes every async frame → uncaughtException.
function pgTeardownError(message: string, stack: string): TypeError {
  const err = new TypeError(message);
  err.stack = `TypeError: ${message}\n${stack}`;
  return err;
}

const PG_STACK_FRAME =
  '    at Immediate.nextWrite (/app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/cjs/src/connection.js:255:22)\n' +
  '    at process.processImmediate (node:internal/timers:504:21)';

describe('isRecoverablePostgresConnectionTeardown', () => {
  it('suppresses the postgres null-socket write teardown (modern V8 message)', () => {
    expect(isRecoverablePostgresConnectionTeardown(
      pgTeardownError("Cannot read properties of null (reading 'write')", PG_STACK_FRAME)
    )).toBe(true);
  });

  it('suppresses the legacy V8 phrasing of the same teardown', () => {
    expect(isRecoverablePostgresConnectionTeardown(
      pgTeardownError("Cannot read property 'write' of null", PG_STACK_FRAME)
    )).toBe(true);
  });

  it('does NOT suppress an identical message from NON-postgres code (real bug)', () => {
    expect(isRecoverablePostgresConnectionTeardown(
      pgTeardownError(
        "Cannot read properties of null (reading 'write')",
        '    at Object.handler (/app/apps/api/src/routes/devices.ts:42:10)'
      )
    )).toBe(false);
  });

  it('does NOT suppress an unrelated null-read inside postgres (only the write teardown)', () => {
    expect(isRecoverablePostgresConnectionTeardown(
      pgTeardownError("Cannot read properties of null (reading 'query')", PG_STACK_FRAME)
    )).toBe(false);
  });

  it('does NOT suppress a plain Error or non-error value', () => {
    expect(isRecoverablePostgresConnectionTeardown(new Error('boom'))).toBe(false);
    expect(isRecoverablePostgresConnectionTeardown('nope')).toBe(false);
    expect(isRecoverablePostgresConnectionTeardown(null)).toBe(false);
  });

  it('is covered by neither predicate for ordinary errors (no cross-suppression)', () => {
    const real = new Error('ordinary failure');
    expect(isBenignRejection(real)).toBe(false);
    expect(isRecoverablePostgresConnectionTeardown(real)).toBe(false);
  });
});
