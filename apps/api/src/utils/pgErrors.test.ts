import { describe, it, expect } from 'vitest';
import { isPgUniqueViolation } from './pgErrors';

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
