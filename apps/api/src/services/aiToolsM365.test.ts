import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./delegantClient', () => ({ invokeDelegantTool: vi.fn() }));
vi.mock('./m365Helpers', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, loadSession: vi.fn(), loadConnection: vi.fn() };
});
// Direct backend off by default so the existing tests exercise the Delegant path.
vi.mock('./m365DirectGraph', () => ({
  hasDirectM365Connection: vi.fn().mockResolvedValue(false),
  invokeDirect: vi.fn(),
}));

import { invokeDelegantTool } from './delegantClient';
import { loadSession, loadConnection } from './m365Helpers';
import { hasDirectM365Connection, invokeDirect } from './m365DirectGraph';
import {
  m365LookupUserHandler, m365RecentSigninsHandler, m365ListGroupMembershipsHandler,
  m365DisableUserHandler, m365ResetPasswordHandler, m365ToolTiers,
} from './aiToolsM365';

const auth = { orgId: 'org-A', user: { id: 'tech-1', email: 't@x.com' } } as any;
const activeConn = {
  id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1',
  delegantConnectionId: 'dconn-1', customerLabel: 'pinnacle', customerDisplayName: 'Pinnacle',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('m365_lookup_user', () => {
  it('errors and never calls Delegant when no customer is selected', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: null });
    const out = await m365LookupUserHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1');
    expect(JSON.parse(out).error).toBe('no_customer_selected');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('errors connection_not_found and never calls Delegant on a cross-org connection', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue({ ...activeConn, orgId: 'org-OTHER' });
    const out = await m365LookupUserHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1');
    expect(JSON.parse(out).error).toBe('connection_not_found');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('calls Delegant get_user on the happy path (object id, no UPN resolve)', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1', displayName: 'Jane', assignedLicenses: [] } });
    const out = await m365LookupUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(invokeDelegantTool).toHaveBeenCalledTimes(1);
    expect((invokeDelegantTool as any).mock.calls[0][0].toolName).toBe('get_user');
    expect(out).toContain('Jane');
  });

  it('threads the Delegant toolCallId into the output JSON when present', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1', displayName: 'Jane' }, toolCallId: 'tc-123' });
    const out = await m365LookupUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(out).toContain('Jane'); // human text still present as a substring
    const parsed = JSON.parse(out);
    expect(parsed.delegantToolCallId).toBe('tc-123');
    expect(parsed.message).toContain('Jane');
  });

  it('omits delegantToolCallId when Delegant does not return one', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1', displayName: 'Jane' } });
    const out = await m365LookupUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(out).toContain('Jane');
    expect(out).not.toContain('delegantToolCallId');
  });

  it('returns a graceful message when Delegant is unreachable', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'error', code: 'delegant_unreachable', message: 'down' });
    const out = await m365LookupUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(out.toLowerCase()).toContain('could');
  });
});

describe('UPN resolution', () => {
  it('resolves a UPN to an object id via get_user before the real call (signins)', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { id: 'resolved-id' } }) // get_user resolve
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [] } });        // signin activity
    const out = await m365RecentSigninsHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1');
    const calls = (invokeDelegantTool as any).mock.calls;
    expect(calls[0][0].toolName).toBe('get_user');
    expect(calls[1][0].toolName).toBe('get_user_signin_activity');
    expect(calls[1][0].parameters.userId).toBe('resolved-id');
    expect(out).toBeTruthy();
  });
});

describe('m365_reset_password', () => {
  it('requires a reason argument and never calls Delegant without it', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    const out = await m365ResetPasswordHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(JSON.parse(out).error).toBeDefined();
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('calls reset_user_password and surfaces the temp password', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { temporaryPassword: 'Temp123!' } });
    const out = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'forgot' }, auth, 'sess-1');
    expect((invokeDelegantTool as any).mock.calls.at(-1)[0].toolName).toBe('reset_user_password');
    expect(out).toContain('Temp123!');
  });
});

describe('m365_disable_user', () => {
  it('requires a reason and calls disable_user when present', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    const noReason = await m365DisableUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1');
    expect(JSON.parse(noReason).error).toBeDefined();
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
    const ok = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'offboarding' }, auth, 'sess-1');
    expect((invokeDelegantTool as any).mock.calls.at(-1)[0].toolName).toBe('disable_user');
    expect(ok).toContain('u1');
  });
});

describe('m365_list_group_memberships', () => {
  it('lists groups without needing a user identifier', async () => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { value: [{ id: 'g1', displayName: 'Sales' }] } });
    const out = await m365ListGroupMembershipsHandler({}, auth, 'sess-1');
    expect((invokeDelegantTool as any).mock.calls[0][0].toolName).toBe('list_groups');
    expect(out).toContain('Sales');
  });
});

describe('tool tiers', () => {
  it('assigns tiers 1/1/1/3/3', () => {
    expect(m365ToolTiers['m365_lookup_user']).toBe(1);
    expect(m365ToolTiers['m365_recent_signins']).toBe(1);
    expect(m365ToolTiers['m365_list_group_memberships']).toBe(1);
    expect(m365ToolTiers['m365_disable_user']).toBe(3);
    expect(m365ToolTiers['m365_reset_password']).toBe(3);
  });
});

describe('direct Graph backend (no Delegant)', () => {
  it('routes to the direct backend when the org has an m365 connection, not Delegant', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: null });
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1', displayName: 'Jane' } });
    const out = await m365LookupUserHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1');
    expect(invokeDirect as any).toHaveBeenCalledWith('org-A', 'get_user', { userId: 'jane@x.com' });
    expect(invokeDelegantTool as any).not.toHaveBeenCalled();
    expect(out).toContain('Jane');
  });

  it('reset_password via direct backend requires a reason and dispatches reset_user_password', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: null });
    const missing = await m365ResetPasswordHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1');
    expect(JSON.parse(missing).error).toBe('missing_reason');

    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { ok: true, temporaryPassword: 'Tmp!1234' } });
    const out = await m365ResetPasswordHandler({ userIdentifier: 'jane@x.com', reason: 'lockout' }, auth, 'sess-1');
    const names = (invokeDirect as any).mock.calls.map((c: any[]) => c[1]);
    expect(names).toContain('reset_user_password');
    expect(invokeDelegantTool as any).not.toHaveBeenCalled();
    expect(out).toBeTruthy();
  });
});
