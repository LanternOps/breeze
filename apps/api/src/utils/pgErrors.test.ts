import { describe, it, expect } from 'vitest';
import { isPgUniqueViolation, pgErrorCode } from './pgErrors';

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
