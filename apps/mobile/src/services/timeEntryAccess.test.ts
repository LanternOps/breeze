import { describe, it, expect, vi } from 'vitest';

// `timeEntries` pulls in `./api`, which imports @sentry/react-native — Flow
// syntax Vitest's node environment cannot parse. Mock the transport, not the
// network, exactly as timeEntries.test.ts does.
vi.mock('./api', () => ({ coreRequest: vi.fn() }));

import { classifyTimeEntryDenial, isAccountLevelDenial } from './timeEntryAccess';
import { TimeEntryError } from './timeEntries';

describe('classifyTimeEntryDenial', () => {
  it('returns null for anything that is not a 403', () => {
    expect(classifyTimeEntryDenial(new TimeEntryError('conflict', 'ENTRY_RUNNING', 409))).toBeNull();
    expect(classifyTimeEntryDenial(new Error('offline'))).toBeNull();
    expect(classifyTimeEntryDenial(undefined)).toBeNull();
  });

  it('reads the scope rejection the route emits for an organization-scoped token', () => {
    // requireScope('partner','system') throws exactly this message
    // (apps/api/src/middleware/auth.ts), and time_entries has no org-axis RLS
    // policy, so an org-scoped login can never reach the feature.
    const denial = classifyTimeEntryDenial(
      new TimeEntryError('Insufficient permissions', undefined, 403)
    );
    expect(denial?.reason).toBe('scope');
    expect(denial?.message).toMatch(/organization/i);
    expect(denial?.message).not.toMatch(/an error occurred/i);
  });

  it('reads a role/permission rejection distinctly from a scope rejection', () => {
    const denied = classifyTimeEntryDenial(new TimeEntryError('Permission denied', undefined, 403));
    expect(denied?.reason).toBe('permission');
    expect(denied?.message).toMatch(/role/i);

    const missing = classifyTimeEntryDenial(
      new TimeEntryError('No permissions found', undefined, 403)
    );
    expect(missing?.reason).toBe('permission');
  });

  it('maps NOT_OWN_ENTRY to an ownership denial rather than a role problem', () => {
    const denial = classifyTimeEntryDenial(new TimeEntryError('nope', 'NOT_OWN_ENTRY', 403));
    expect(denial?.reason).toBe('ownership');
    expect(denial?.message).toMatch(/someone else|another/i);
  });

  it('maps ADMIN_REQUIRED to a permission denial that names the administrator', () => {
    const denial = classifyTimeEntryDenial(new TimeEntryError('nope', 'ADMIN_REQUIRED', 403));
    expect(denial?.reason).toBe('permission');
    expect(denial?.message).toMatch(/administrator/i);
  });

  it('never falls back to a generic message on an unclassifiable 403', () => {
    // A blank "Something went wrong" here is the exact failure the W02 gate
    // called out: the technician cannot tell a scope wall from a role gap.
    const denial = classifyTimeEntryDenial(new TimeEntryError('teapot', undefined, 403));
    expect(denial?.reason).toBe('unknown');
    expect(denial?.message).toMatch(/time tracking/i);
    expect(denial?.message).toMatch(/teapot/);
  });

  it('accepts a bare ApiError shape from coreRequest, not just TimeEntryError', () => {
    const denial = classifyTimeEntryDenial({
      message: 'Insufficient permissions',
      statusCode: 403,
    });
    expect(denial?.reason).toBe('scope');
  });

  it('maps APPROVED_IMMUTABLE to a per-entry verdict, not a role problem', () => {
    // assertCanMutate raises this 403 about ONE ROW. Classified as anything
    // account-shaped it becomes a sticky wall that removes the Stop button from
    // a running timer and replaces the whole Time tab until sign-out.
    const denial = classifyTimeEntryDenial(
      new TimeEntryError('Approved entries can only be changed by an approver', 'APPROVED_IMMUTABLE', 403)
    );
    expect(denial?.reason).toBe('entry');
    expect(denial?.message).toMatch(/approv/i);
  });
});

describe('isAccountLevelDenial', () => {
  it('treats the scope wall and a missing role grant as account-level', () => {
    // Both stay true for the whole session: an org-scoped token can never read
    // the table, and a missing time_entries:write grant needs an administrator.
    expect(isAccountLevelDenial({ reason: 'scope', message: '' })).toBe(true);
    expect(isAccountLevelDenial({ reason: 'permission', message: '' })).toBe(true);
  });

  it('refuses to escalate a per-row verdict into an app-wide wall', () => {
    // The bug this closes: a manager approves the week from the web while the
    // timesheet is open, one "Mark billable" tap returns 403 APPROVED_IMMUTABLE,
    // and time tracking is withdrawn app-wide until the technician signs out.
    expect(isAccountLevelDenial({ reason: 'entry', message: '' })).toBe(false);
    expect(isAccountLevelDenial({ reason: 'ownership', message: '' })).toBe(false);
    expect(isAccountLevelDenial({ reason: 'unknown', message: '' })).toBe(false);
  });
});
