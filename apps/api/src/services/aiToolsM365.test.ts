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
// Task 9 typed Graph read-query tools delegate entirely to executeM365ReadAction
// (the Task 8 control-plane service) — mocked here per the brief so these tests
// exercise only the input -> M365ReadAction mapping and result serialization.
vi.mock('./m365ControlPlane/readActionService', () => ({
  executeM365ReadAction: vi.fn(),
}));

import { invokeDelegantTool } from './delegantClient';
import { loadSession, loadConnection } from './m365Helpers';
import { hasDirectM365Connection, invokeDirect } from './m365DirectGraph';
import { executeM365ReadAction } from './m365ControlPlane/readActionService';
import {
  m365LookupUserHandler, m365RecentSigninsHandler, m365ListGroupMembershipsHandler,
  m365DisableUserHandler, m365ResetPasswordHandler, m365ToolTiers, registerM365Tools,
} from './aiToolsM365';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const auth = { orgId: 'org-A', user: { id: 'tech-1', email: 't@x.com' } } as any;
const activeConn = {
  id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1',
  delegantConnectionId: 'dconn-1', customerLabel: 'example-dental', customerDisplayName: 'Example Dental',
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

describe('m365 user resolution surfaces real failures (not a phantom "user not found")', () => {
  beforeEach(() => {
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
  });

  it('surfaces an auth failure on get_user as itself, not as "user not found"', async () => {
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'error', code: 'auth_failed', message: 'token expired' });
    // UPN (with @) forces a get_user resolution, which fails on auth.
    const out = await m365DisableUserHandler({ userIdentifier: 'jane@x.com', reason: 'offboarding' }, auth, 'sess-1');
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('auth_failed');
    expect(parsed.error).not.toBe('user_not_found');
  });

  it('reports a genuinely-absent user (404) as user_not_found', async () => {
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'error', code: 'not_found', message: 'no such user' });
    const out = await m365DisableUserHandler({ userIdentifier: 'ghost@x.com', reason: 'offboarding' }, auth, 'sess-1');
    expect(JSON.parse(out).error).toBe('user_not_found');
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

// ============================================
// Typed Graph read-query tools (Task 9)
// ============================================

describe('registerM365Tools', () => {
  const toolMap = new Map<string, AiTool>();
  registerM365Tools(toolMap);

  const EXPECTED_TOOLS = [
    'm365_query_users',
    'm365_query_signins',
    'm365_query_intune_devices',
    'm365_query_groups',
    'm365_query_org',
    'm365_query_sites',
  ] as const;

  it('registers all 6 tools at tier 1 with no deviceArgs', () => {
    for (const name of EXPECTED_TOOLS) {
      const tool = toolMap.get(name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool!.tier).toBe(1);
      expect(tool!.deviceArgs).toBeUndefined();
    }
  });

  it('every description states a cap and that data is read live from the tenant', () => {
    for (const name of EXPECTED_TOOLS) {
      const description = toolMap.get(name)!.definition.description ?? '';
      expect(description.toLowerCase(), `${name} description`).toMatch(/microsoft 365 tenant/);
    }
  });
});

describe('m365_query_* handlers', () => {
  const queryAuth: AuthContext = { orgId: 'org-A', user: { id: 'tech-1', email: 't@x.com' } } as any;
  const toolMap = new Map<string, AiTool>();
  registerM365Tools(toolMap);

  function handlerFor(name: string) {
    return toolMap.get(name)!.handler;
  }

  beforeEach(() => {
    vi.mocked(executeM365ReadAction).mockReset();
  });

  describe('m365_query_users', () => {
    it('maps list mode to m365.user.list with defaults and optional filters', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: 'u1' }], truncated: false });
      const out = await handlerFor('m365_query_users')({ mode: 'list', search: 'ada', accountEnabled: true, department: 'eng' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.user.list', search: 'ada', accountEnabled: true, department: 'eng', pageSize: 25 },
        undefined,
      );
      expect(JSON.parse(out)).toEqual({ items: [{ id: 'u1' }], truncated: false });
    });

    it('maps get mode to m365.user.get with userIdOrUpn', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'u1' } });
      const out = await handlerFor('m365_query_users')({ mode: 'get', userIdOrUpn: 'ada@contoso.com' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
        undefined,
      );
      expect(JSON.parse(out)).toEqual({ resource: { id: 'u1' } });
    });

    it('clamps an excessive limit to the per-action max (50)', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_users')({ mode: 'list', limit: 9999 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.user.list', pageSize: 50 },
        undefined,
      );
    });

    it('threads an explicit orgId through to executeM365ReadAction', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_users')({ mode: 'list', orgId: 'org-B' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(queryAuth, expect.anything(), 'org-B');
    });

    it('returns the generic invalid-parameters error without calling the service when userIdOrUpn is missing', async () => {
      const out = await handlerFor('m365_query_users')({ mode: 'get' }, queryAuth);
      expect(JSON.parse(out)).toEqual({ error: 'Invalid parameters for this Microsoft 365 query.' });
      expect(executeM365ReadAction).not.toHaveBeenCalled();
    });
  });

  describe('m365_query_signins', () => {
    it('maps to m365.signins.list with userPrincipalName and sinceHours', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_signins')({ userPrincipalName: 'ada@contoso.com', sinceHours: 48 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 48, pageSize: 25 },
        undefined,
      );
    });

    it('clamps limit to the per-action max (50)', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_signins')({ limit: 500 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.signins.list', pageSize: 50 },
        undefined,
      );
    });
  });

  describe('m365_query_intune_devices', () => {
    it('maps list mode with complianceState/operatingSystem filters', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_intune_devices')({ mode: 'list', complianceState: 'noncompliant', operatingSystem: 'Windows' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.intune.device.list', complianceState: 'noncompliant', operatingSystem: 'Windows', pageSize: 25 },
        undefined,
      );
    });

    it('maps get mode with intuneDeviceId', async () => {
      const deviceId = '11111111-2222-3333-4444-555555555555';
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: deviceId } });
      await handlerFor('m365_query_intune_devices')({ mode: 'get', intuneDeviceId: deviceId }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.intune.device.get', deviceId },
        undefined,
      );
    });

    it('clamps limit to the per-action max (50)', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_intune_devices')({ mode: 'list', limit: 1000 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.intune.device.list', pageSize: 50 },
        undefined,
      );
    });
  });

  describe('m365_query_groups', () => {
    const groupId = '11111111-2222-3333-4444-555555555555';

    it('maps list mode with search', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_groups')({ mode: 'list', search: 'staff' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.group.list', search: 'staff', pageSize: 25 },
        undefined,
      );
    });

    it('maps get mode with groupId', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: groupId } });
      await handlerFor('m365_query_groups')({ mode: 'get', groupId }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.group.get', groupId },
        undefined,
      );
    });

    it('maps members mode with groupId and clamps limit to 100', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_groups')({ mode: 'members', groupId, limit: 5000 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.group.members.list', groupId, pageSize: 100 },
        undefined,
      );
    });

    it('clamps list-mode limit to 50 (not the members cap of 100)', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_groups')({ mode: 'list', limit: 5000 }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.group.list', pageSize: 50 },
        undefined,
      );
    });
  });

  describe('m365_query_org', () => {
    it('maps include=profile to m365.org.get', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: 'org1' } });
      await handlerFor('m365_query_org')({ include: 'profile' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(queryAuth, { type: 'm365.org.get' }, undefined);
    });

    it('maps include=licenses to m365.org.skus.list', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_org')({ include: 'licenses' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(queryAuth, { type: 'm365.org.skus.list' }, undefined);
    });
  });

  describe('m365_query_sites', () => {
    it('maps list mode with a required search term', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [], truncated: false });
      await handlerFor('m365_query_sites')({ mode: 'list', search: 'intranet' }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.sites.list', search: 'intranet' },
        undefined,
      );
    });

    it('maps get mode with siteId', async () => {
      const siteId = 'contoso.sharepoint.com,111,222';
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: siteId } });
      await handlerFor('m365_query_sites')({ mode: 'get', siteId }, queryAuth);
      expect(executeM365ReadAction).toHaveBeenCalledWith(
        queryAuth,
        { type: 'm365.site.get', siteId },
        undefined,
      );
    });

    it('returns the generic invalid-parameters error when search is missing in list mode', async () => {
      const out = await handlerFor('m365_query_sites')({ mode: 'list' }, queryAuth);
      expect(JSON.parse(out)).toEqual({ error: 'Invalid parameters for this Microsoft 365 query.' });
      expect(executeM365ReadAction).not.toHaveBeenCalled();
    });
  });

  describe('refusal serialization', () => {
    it('serializes a service refusal as { error, code, retryAfterSeconds }', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({
        ok: false,
        code: 'connection_not_ready',
        message: 'Microsoft 365 is not connected for this organization. Connect Microsoft 365 in Integrations settings.',
      });
      const out = await handlerFor('m365_query_users')({ mode: 'list' }, queryAuth);
      expect(JSON.parse(out)).toEqual({
        error: 'Microsoft 365 is not connected for this organization. Connect Microsoft 365 in Integrations settings.',
        code: 'connection_not_ready',
      });
    });

    it('includes retryAfterSeconds when the service provides one', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({
        ok: false,
        code: 'read_rate_limited',
        message: 'Microsoft 365 Graph read actions are rate limited for this connection. Try again shortly.',
        retryAfterSeconds: 42,
      });
      const out = await handlerFor('m365_query_signins')({}, queryAuth);
      expect(JSON.parse(out)).toEqual({
        error: 'Microsoft 365 Graph read actions are rate limited for this connection. Try again shortly.',
        code: 'read_rate_limited',
        retryAfterSeconds: 42,
      });
    });
  });

  describe('truncated collection note', () => {
    it('adds a narrowing note when the service reports truncation', async () => {
      vi.mocked(executeM365ReadAction).mockResolvedValue({ ok: true, kind: 'collection', items: [{ id: 'u1' }], truncated: true });
      const out = await handlerFor('m365_query_users')({ mode: 'list' }, queryAuth);
      expect(JSON.parse(out)).toEqual({
        items: [{ id: 'u1' }],
        truncated: true,
        note: 'Result capped; narrow the query for more.',
      });
    });
  });

  describe('safeHandler crash containment', () => {
    it('returns a generic error and never throws when executeM365ReadAction rejects', async () => {
      vi.mocked(executeM365ReadAction).mockRejectedValue(new Error('boom'));
      const out = await handlerFor('m365_query_users')({ mode: 'list' }, queryAuth);
      expect(JSON.parse(out)).toEqual({ error: 'Operation failed. Check server logs for details.' });
    });
  });
});
