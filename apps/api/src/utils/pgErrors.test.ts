import { describe, it, expect, vi } from 'vitest';
import { isPgUniqueViolation, isTransientLockError, pgErrorCode, retryOnTransientLockError } from './pgErrors';

// postgres.js surfaces the index as `constraint_name` (the real shape we hit in prod)
const pgErr = (constraint?: string) =>
  Object.assign(new Error('duplicate key value violates unique constraint' + (constraint ? ` "${constraint}"` : '')), {
    code: '23505',
    ...(constraint ? { constraint_name: constraint } : {})
  });

// node-postgres surfaces it as `constraint`
const pgErrNodePg = (constraint: string) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });

// DrizzleQueryError shape: generic message, no top-level code, real error on .cause
const drizzleWrap = (cause: unknown) => Object.assign(new Error('Failed query: insert into "t" ...'), { cause });

describe('isPgUniqueViolation', () => {
  it('detects a top-level (unwrapped) 23505', () => {
    expect(isPgUniqueViolation(pgErr())).toBe(true);
  });

  it('detects a 23505 wrapped in a DrizzleQueryError cause (no top-level code)', () => {
    expect(isPgUniqueViolation(drizzleWrap(pgErr()))).toBe(true);
  });

  it('returns false for non-unique errors and non-objects', () => {
    expect(isPgUniqueViolation(Object.assign(new Error('x'), { code: '23503' }))).toBe(false);
    expect(isPgUniqueViolation(null)).toBe(false);
    expect(isPgUniqueViolation('boom')).toBe(false);
  });

  it('matches a specific constraint when provided (wrapped, postgres.js constraint_name)', () => {
    expect(isPgUniqueViolation(drizzleWrap(pgErr('ticket_statuses_partner_name_uq')), 'ticket_statuses_partner_name_uq')).toBe(true);
  });

  it('matches a specific constraint via node-postgres `constraint` field too', () => {
    expect(isPgUniqueViolation(drizzleWrap(pgErrNodePg('ticket_statuses_partner_name_uq')), 'ticket_statuses_partner_name_uq')).toBe(true);
  });

  it('does NOT match a different constraint (other 23505s propagate)', () => {
    expect(isPgUniqueViolation(drizzleWrap(pgErr('ticket_statuses_partner_core_status_system_uq')), 'ticket_statuses_partner_name_uq')).toBe(false);
  });

  it('falls back to message scan when the constraint name is not a discrete field', () => {
    const noConstraintField = Object.assign(new Error('… unique constraint "ticket_statuses_partner_name_uq"'), { code: '23505' });
    expect(isPgUniqueViolation(noConstraintField, 'ticket_statuses_partner_name_uq')).toBe(true);
  });
});

// Build a `.cause` chain of the given depth (depth 0 = the error itself carries
// the code). Each intermediate wrapper has no `code`, mirroring DrizzleQueryError.
const nestedCode = (code: string, depth: number): Error => {
  let err: Error = Object.assign(new Error('pg error'), { code });
  for (let i = 0; i < depth; i++) {
    err = Object.assign(new Error('Failed query'), { cause: err });
  }
  return err;
};

describe('pgErrorCode', () => {
  it('returns a top-level SQLSTATE', () => {
    expect(pgErrorCode(Object.assign(new Error('denied'), { code: '42501' }))).toBe('42501');
  });

  it('unwraps a SQLSTATE buried on the Drizzle .cause chain', () => {
    expect(pgErrorCode(drizzleWrap(Object.assign(new Error('denied'), { code: '42501' })))).toBe('42501');
  });

  it('returns the FIRST string code walking down (outer wrapper code wins over inner)', () => {
    const inner = Object.assign(new Error('inner'), { code: '42501' });
    const outer = Object.assign(new Error('outer'), { code: '23505', cause: inner });
    expect(pgErrorCode(outer)).toBe('23505');
  });

  it('resolves a code at the depth-4 boundary but gives up at depth 5 (depth cap is intentional)', () => {
    expect(pgErrorCode(nestedCode('42501', 4))).toBe('42501');
    expect(pgErrorCode(nestedCode('42501', 5))).toBeUndefined();
  });

  it('skips a non-string code (e.g. numeric) rather than returning it', () => {
    expect(pgErrorCode(Object.assign(new Error('x'), { code: 42501 }))).toBeUndefined();
  });

  it('returns undefined for non-pg errors and non-objects', () => {
    expect(pgErrorCode(new Error('plain'))).toBeUndefined();
    expect(pgErrorCode(null)).toBeUndefined();
    expect(pgErrorCode('boom')).toBeUndefined();
    expect(pgErrorCode(undefined)).toBeUndefined();
  });
});

describe('isTransientLockError', () => {
  it('matches deadlock_detected and serialization_failure, including Drizzle-wrapped', () => {
    expect(isTransientLockError(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(true);
    expect(isTransientLockError(Object.assign(new Error('could not serialize'), { code: '40001' }))).toBe(true);
    // The shape that actually reaches route code: DrizzleQueryError wrapper
    // whose own .code is undefined and the real code on .cause.
    const wrapped = Object.assign(new Error('Failed query: delete from "software_inventory"'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    });
    expect(isTransientLockError(wrapped)).toBe(true);
  });

  it('does not match errors that a retry cannot fix', () => {
    // 25P02 is the SYMPTOM of an already-aborted transaction, not a lost race —
    // retrying it in place would loop until the budget ran out.
    for (const code of ['23505', '23502', '23503', '42501', '25P02', '40002']) {
      expect(isTransientLockError(Object.assign(new Error('x'), { code }))).toBe(false);
    }
    expect(isTransientLockError(new Error('plain'))).toBe(false);
    expect(isTransientLockError(null)).toBe(false);
  });
});

describe('retryOnTransientLockError', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retryOnTransientLockError('t', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a deadlock and succeeds on a later attempt', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const fn = vi.fn()
      .mockRejectedValueOnce(deadlock)
      .mockRejectedValueOnce(deadlock)
      .mockResolvedValue('ok');
    await expect(retryOnTransientLockError('t', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('exhausts the budget and rethrows the last lock error', async () => {
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const fn = vi.fn().mockRejectedValue(deadlock);
    await expect(retryOnTransientLockError('t', fn, { attempts: 2 })).rejects.toBe(deadlock);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-lock error immediately without burning retries', async () => {
    const notALock = Object.assign(new Error('not-null violation'), { code: '23502' });
    const fn = vi.fn().mockRejectedValue(notALock);
    await expect(retryOnTransientLockError('t', fn)).rejects.toBe(notALock);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats attempts < 1 as a single attempt rather than skipping the work', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(retryOnTransientLockError('t', fn, { attempts: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
