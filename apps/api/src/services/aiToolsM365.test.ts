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
  executeM365UserLookupForCallerTarget: vi.fn(),
}));

vi.mock('./m365ControlPlane/writeActionService', () => ({
  executeM365WriteActionForAuth: vi.fn(),
  executeM365WriteActionByOrg: vi.fn(),
}));

// Caller verification W05: the pinned-intent loader reads action_intents and the
// connection tables through `db`; both are queue-driven here (one array per
// awaited select). prepareCallerDispatch / the gate are mocked so these tests
// pin only what the handlers hand to them.
const { dbq, prepareMock, gateMock, loadPinned } = vi.hoisted(() => ({
  dbq: { rows: [] as unknown[][] },
  prepareMock: vi.fn(),
  gateMock: vi.fn(),
  loadPinned: vi.fn(),
}));
vi.mock('../db', async (orig) => {
  const actual = await (orig as any)();
  const where = () => {
    const p = Promise.resolve().then(() => dbq.rows.shift() ?? []);
    return Object.assign(p, { limit: () => p });
  };
  return { ...actual, db: { select: () => ({ from: () => ({ where }) }) } };
});
vi.mock('./callerVerification/dispatch', () => ({ prepareCallerDispatch: prepareMock }));
vi.mock('./callerVerification/gate', () => ({ requireCallerVerification: gateMock }));
vi.mock('./actionIntents/callerTarget', async (orig) => {
  const actual = await (orig as any)();
  return { ...actual, loadPinnedCallerBackend: loadPinned };
});

import { executeM365WriteActionForAuth, executeM365WriteActionByOrg } from './m365ControlPlane/writeActionService';
import { CallerVerificationRequiredError, CallerVerificationValidationError } from './callerVerification/errors';
import type { ToolExecutionContext } from './toolExecutionContext';
import { invokeDelegantTool } from './delegantClient';
import { loadSession, loadConnection } from './m365Helpers';
import { hasDirectM365Connection, invokeDirect } from './m365DirectGraph';
import { executeM365ReadAction, executeM365UserLookupForCallerTarget } from './m365ControlPlane/readActionService';
import {
  m365LookupUserHandler, m365RecentSigninsHandler, m365ListGroupMembershipsHandler,
  m365DisableUserHandler, m365ResetPasswordHandler, m365ToolTiers, registerM365Tools,
  m365RevokeSessionsHandler, m365RemoveLicenseHandler, m365AssignLicenseHandler,
  m365RemoveFromGroupHandler, m365AddToGroupHandler, m365RetireIntuneDeviceHandler,
  m365CreateUserHandler, m365SetAutoReplyHandler, resolveM365CallerTarget,
} from './aiToolsM365';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const auth = { orgId: 'org-A', user: { id: 'tech-1', email: 't@x.com' } } as any;
const activeConn = {
  id: 'c1', orgId: 'org-A', status: 'active', delegantOrgId: 'dorg-1',
  delegantConnectionId: 'dconn-1', m365TenantId: '22222222-2222-4222-8222-222222222222', customerLabel: 'example-dental', customerDisplayName: 'Example Dental',
};

const OID = '77777777-7777-4777-8777-777777777777';
const TENANT = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const INTENT = 'intent-1';
const ctxFor = (): ToolExecutionContext => ({ actionIntentId: INTENT }) as ToolExecutionContext;

/** Queue the pinned intent row + pinned connection a released protected tool reads. */
function pin(
  backend: 'delegant' | 'direct' | 'controlPlane',
  toolName: 'm365_disable_user' | 'm365_reset_password',
  over: Record<string, unknown> = {},
) {
  dbq.rows.push([{
    id: INTENT, orgId: 'org-A', actionName: toolName,
    targetEntraOid: OID, targetEntraTenantId: TENANT, targetConnectionRef: 'c1', ...over,
  }]);
  loadPinned.mockResolvedValue({ backend, connectionId: 'c1', tenantId: TENANT, orgId: 'org-A' });
  (loadConnection as any).mockResolvedValue(activeConn);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbq.rows.length = 0;
  prepareMock.mockReset();
  prepareMock.mockResolvedValue(undefined);
  loadPinned.mockReset();
  (hasDirectM365Connection as any).mockResolvedValue(false);
});

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
    const result = await m365ResetPasswordHandler({ userIdentifier: 'u1' }, auth, 'sess-1', ctxFor());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') throw new Error('expected error');
    expect(JSON.parse(result.llmText).error).toBe('missing_reason');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('dispatches reset_user_password to the pinned oid and carries the temp password out of llmText', async () => {
    pin('delegant', 'm365_reset_password');
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { temporaryPassword: 'Temp123!' } });
    const result = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'forgot' }, auth, 'sess-1', ctxFor());
    expect(invokeDelegantTool).toHaveBeenCalledTimes(1);
    const req = (invokeDelegantTool as any).mock.calls[0][0];
    expect(req.toolName).toBe('reset_user_password');
    expect(req.parameters.userId).toBe(OID);
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.secrets.temporaryPassword).toBe('Temp123!');
    expect(result.llmText).not.toContain('Temp123!');
  });
});

describe('m365ResetPasswordHandler carrier', () => {
  beforeEach(() => { pin('delegant', 'm365_reset_password'); });

  it('keeps the credential out of llmText and carries it in secrets, threading the Delegant toolCallId', async () => {
    (invokeDelegantTool as any).mockResolvedValue({
      kind: 'ok',
      data: { temporaryPassword: 'Xy7#kLp2Qm' },
      toolCallId: 'dtc-9',
    });

    const result = await m365ResetPasswordHandler(
      { userIdentifier: 'a@b.com', reason: 'ticket 5' },
      auth,
      'sess-1',
      ctxFor(),
    );

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.secrets.temporaryPassword).toBe('Xy7#kLp2Qm');
    expect(result.llmText).not.toContain('Xy7#kLp2Qm');
    expect(result.meta?.delegantToolCallId).toBe('dtc-9');
  });

  it('returns an error carrier when the backend reports the user missing', async () => {
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'error', code: 'not_found', message: 'no such user' });

    const result = await m365ResetPasswordHandler(
      { userIdentifier: 'ghost@b.com', reason: 'ticket 6' },
      auth,
      'sess-1',
      ctxFor(),
    );
    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('secrets');
  });

  it('returns an error carrier when the backend reports success but no credential', async () => {
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });

    const result = await m365ResetPasswordHandler(
      { userIdentifier: 'u1', reason: 'ticket 7' },
      auth,
      'sess-1',
      ctxFor(),
    );
    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('secrets');
  });
});

describe('m365_disable_user', () => {
  it('requires a reason, then disables the pinned oid', async () => {
    pin('delegant', 'm365_disable_user');
    const noReason = await m365DisableUserHandler({ userIdentifier: 'u1' }, auth, 'sess-1', ctxFor());
    expect(JSON.parse(noReason).error).toBe('missing_reason');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
    const ok = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'offboarding' }, auth, 'sess-1', ctxFor());
    expect((invokeDelegantTool as any).mock.calls.at(-1)[0].toolName).toBe('disable_user');
    expect(ok).toContain('u1');
  });
});

describe('protected M365 mutations dispatch only to the pinned target (#6354 W05)', () => {
  const REFUSAL = () => new CallerVerificationRequiredError({
    orgId: 'org-A', contactId: null, action: 'disable_user', requiredTier: 2, reason: 'no_fresh_verification', latest: null,
  });

  it.each([
    ['m365_disable_user', (c?: ToolExecutionContext) => m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', c)],
    ['m365_reset_password', (c?: ToolExecutionContext) => m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', c)],
  ])('%s without an intent is a typed refusal and reaches no backend', async (_name, run) => {
    await expect(run(undefined)).rejects.toBeInstanceOf(CallerVerificationRequiredError);
    await expect(run({} as ToolExecutionContext)).rejects.toMatchObject({ payload: { reason: 'no_fresh_verification' } });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(invokeDirect).not.toHaveBeenCalled();
    expect(executeM365WriteActionByOrg).not.toHaveBeenCalled();
    expect(hasDirectM365Connection).not.toHaveBeenCalled();
  });

  it('an unknown intent id is refused', async () => {
    dbq.rows.push([]);
    await expect(m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('an intent for the other tool is refused as target_rebound', async () => {
    pin('delegant', 'm365_reset_password');
    await expect(m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('an unpinned intent is refused as subject_unmatched', async () => {
    pin('delegant', 'm365_disable_user', { targetEntraOid: null });
    await expect(m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toMatchObject({ payload: { reason: 'subject_unmatched' } });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('Delegant: a guard refusal never reaches the broker mutation', async () => {
    pin('delegant', 'm365_disable_user');
    prepareMock.mockRejectedValueOnce(REFUSAL());
    await expect(m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('Delegant: a passed disable sends the pinned OID exactly once and never calls get_user', async () => {
    pin('delegant', 'm365_disable_user');
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
    // The input names a UPN; it is display only.
    const out = await m365DisableUserHandler({ userIdentifier: 'jane@x.com', reason: 'offboarding' }, auth, 'sess-1', ctxFor());
    expect(out).toContain('jane@x.com');
    expect(invokeDelegantTool).toHaveBeenCalledTimes(1);
    const req = (invokeDelegantTool as any).mock.calls[0][0];
    expect(req.toolName).toBe('disable_user');
    expect(req.parameters).toEqual({ userId: OID, reason: 'offboarding' });
    expect(req.connection.id).toBe('c1');
    expect((invokeDelegantTool as any).mock.calls.some((c: any[]) => c[0].toolName === 'get_user')).toBe(false);
    expect(prepareMock).toHaveBeenCalledTimes(1);
    expect(prepareMock.mock.calls[0]![0]).toEqual({
      orgId: 'org-A', intentId: INTENT, action: 'disable_user', connectionId: 'c1', backendTenantId: TENANT, oid: OID,
    });
    expect(prepareMock.mock.invocationCallOrder[0]).toBeLessThan((invokeDelegantTool as any).mock.invocationCallOrder[0]);
    expect(prepareMock.mock.calls[0]![1]).toBe(gateMock);
  });

  it('a renamed UPN in the input does not change the target', async () => {
    for (const upn of ['old@x.com', 'renamed@x.com', 'someone-else@x.com']) {
      vi.clearAllMocks();
      pin('delegant', 'm365_disable_user');
      (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
      await m365DisableUserHandler({ userIdentifier: upn, reason: 'r' }, auth, 'sess-1', ctxFor());
      expect((invokeDelegantTool as any).mock.calls[0][0].parameters.userId).toBe(OID);
    }
  });

  it('Delegant reset: guard refusal reaches no broker call; pass keeps the password out of llmText', async () => {
    pin('delegant', 'm365_reset_password');
    prepareMock.mockRejectedValueOnce(REFUSAL());
    await expect(m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
    expect(invokeDelegantTool).not.toHaveBeenCalled();

    pin('delegant', 'm365_reset_password');
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { temporaryPassword: 'PW-SECRET-1' } });
    const res = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(res.kind).toBe('success');
    if (res.kind !== 'success') throw new Error('expected success');
    expect(res.llmText).not.toContain('PW-SECRET-1');
    expect(prepareMock.mock.calls.at(-1)![0]).toMatchObject({ action: 'reset_password', oid: OID });
  });

  it('a pinned connection that is unavailable is an error string, not a throw', async () => {
    pin('delegant', 'm365_disable_user');
    loadPinned.mockRejectedValueOnce(new CallerVerificationValidationError('connection_not_ready', 'gone'));
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(JSON.parse(out).error).toBe('connection_not_found');

    pin('delegant', 'm365_reset_password');
    loadPinned.mockRejectedValueOnce(new CallerVerificationValidationError('connection_not_ready', 'gone'));
    const res = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(res.kind).toBe('error');
    expect(JSON.parse(res.llmText).error).toBe('connection_not_found');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled();
  });

  it('a Delegant broker connection that is no longer authorised is an error string', async () => {
    pin('delegant', 'm365_disable_user');
    (loadConnection as any).mockResolvedValue({ ...activeConn, status: 'revoked' });
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(JSON.parse(out).error).toBe('connection_not_found');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('a pinned connection whose tenant changed since the pin is refused before dispatch', async () => {
    pin('delegant', 'm365_disable_user');
    loadPinned.mockResolvedValue({ backend: 'delegant', connectionId: 'c1', tenantId: OTHER_TENANT, orgId: 'org-A' });
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(JSON.parse(out).error).toBe('connection_not_found');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('never goes through resolveContext: no session load, no direct-connection probe', async () => {
    pin('delegant', 'm365_disable_user');
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
    await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(loadSession).not.toHaveBeenCalled();
    expect(hasDirectM365Connection).not.toHaveBeenCalled();
  });

  it('direct pin: invokeDirect gets the pinned oid and the intent id; Delegant untouched', async () => {
    pin('direct', 'm365_disable_user');
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { ok: true } });
    await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(invokeDirect).toHaveBeenCalledTimes(1);
    expect(invokeDirect).toHaveBeenCalledWith('org-A', 'disable_user', { userId: OID, reason: 'r' }, { actionIntentId: INTENT });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(prepareMock).not.toHaveBeenCalled(); // invokeDirect owns its own guard
  });

  it('control-plane pin: oid-only write with the intent id as idempotency key', async () => {
    pin('controlPlane', 'm365_disable_user');
    (executeM365WriteActionByOrg as any).mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.disable', userId: OID } });
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(out).toContain('Disabled');
    expect(executeM365WriteActionByOrg).toHaveBeenCalledTimes(1);
    expect(executeM365WriteActionByOrg).toHaveBeenCalledWith(
      'org-A',
      { type: 'm365.user.disable', oid: OID, reason: 'r' },
      { actionIntentId: INTENT, idempotencyKey: INTENT, actorId: 'tech-1' },
    );
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(invokeDirect).not.toHaveBeenCalled();
  });

  it('control-plane pin reset: password carried in secrets; failure outcome becomes an error carrier', async () => {
    pin('controlPlane', 'm365_reset_password');
    (executeM365WriteActionByOrg as any).mockResolvedValue({
      ok: true, result: { success: true, action: 'm365.user.reset_password', userId: OID, temporaryPassword: 'CP-SECRET', forceChangeNextSignIn: true },
    });
    const res = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(res.kind).toBe('success');
    if (res.kind !== 'success') throw new Error('expected success');
    expect(res.secrets.temporaryPassword).toBe('CP-SECRET');
    expect(res.llmText).not.toContain('CP-SECRET');

    pin('controlPlane', 'm365_reset_password');
    (executeM365WriteActionByOrg as any).mockResolvedValue({ ok: false, code: 'connection_not_ready', message: 'no' });
    const fail = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(fail.kind).toBe('error');
    expect(fail).not.toHaveProperty('secrets');
  });

  it('control-plane pin: a guard refusal thrown by the write service propagates', async () => {
    pin('controlPlane', 'm365_disable_user');
    (executeM365WriteActionByOrg as any).mockRejectedValue(REFUSAL());
    await expect(m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor()))
      .rejects.toBeInstanceOf(CallerVerificationRequiredError);
  });
});

describe('resolveM365CallerTarget (#6354 W05)', () => {
  const tech = { orgId: 'org-A', user: { id: 'tech-1' }, canAccessOrg: () => true } as any;
  const resolved = (backend: string, id: string, tenantId = TENANT) => ({ backend, connectionId: id, tenantId, orgId: 'org-A' });

  it('refuses an org the caller cannot access, and an empty identifier, before any lookup', async () => {
    await expect(resolveM365CallerTarget({ ...tech, canAccessOrg: () => false }, 'org-A', 'x')).rejects.toThrow(/not accessible/);
    await expect(resolveM365CallerTarget(tech, 'org-A', '')).rejects.toMatchObject({ code: 'subject_unmatched' });
    expect(loadPinned).not.toHaveBeenCalled();
  });

  it('prefers the direct connection over a session Delegant and a control-plane row', async () => {
    dbq.rows.push([{ id: 'cP', profile: 'customer-graph-actions' }, { id: 'cD', profile: 'legacy-direct' }]);
    loadPinned.mockResolvedValue(resolved('direct', 'cD'));
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { id: OID.toUpperCase() } });
    const r = await resolveM365CallerTarget(tech, 'org-A', 'jane@x.com', 'sess-1');
    expect(loadPinned.mock.calls[0]).toEqual(['org-A', 'cD']);
    expect(invokeDirect).toHaveBeenCalledWith('org-A', 'get_user', { userId: 'jane@x.com' }, {
      expectedConnection: { connectionId: 'cD', tenantId: TENANT },
    });
    expect(loadSession).not.toHaveBeenCalled();
    expect(r).toMatchObject({ backend: 'direct', connectionId: 'cD', tenantId: TENANT, entraOid: OID });
  });

  it('prefers the session Delegant connection over a control-plane row', async () => {
    dbq.rows.push([{ id: 'cP', profile: 'customer-graph-actions' }]);
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', userId: 'tech-1', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
    loadPinned.mockResolvedValue(resolved('delegant', 'c1'));
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: OID } });
    const r = await resolveM365CallerTarget(tech, 'org-A', 'jane@x.com', 'sess-1');
    expect(loadPinned.mock.calls[0]).toEqual(['org-A', 'c1']);
    expect(executeM365UserLookupForCallerTarget).not.toHaveBeenCalled();
    expect((invokeDelegantTool as any).mock.calls[0][0]).toMatchObject({ toolName: 'get_user', parameters: { userId: 'jane@x.com' } });
    expect(r).toMatchObject({ backend: 'delegant', connectionId: 'c1', entraOid: OID });
  });

  it("ignores another user's session Delegant selection", async () => {
    dbq.rows.push([{ id: 'cP', profile: 'customer-graph-actions' }]);
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', userId: 'someone-else', delegantM365ConnectionId: 'c1' });
    loadPinned.mockResolvedValue(resolved('controlPlane', 'cP'));
    (executeM365UserLookupForCallerTarget as any).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: OID } });
    await resolveM365CallerTarget(tech, 'org-A', 'jane@x.com', 'sess-1');
    expect(loadPinned.mock.calls[0]).toEqual(['org-A', 'cP']);
  });

  it('uses the control-plane connection when there is no direct row and no session Delegant', async () => {
    dbq.rows.push([{ id: 'cP', profile: 'customer-graph-actions' }]);
    loadPinned.mockResolvedValue(resolved('controlPlane', 'cP'));
    (executeM365UserLookupForCallerTarget as any).mockResolvedValue({ ok: true, kind: 'resource', resource: { id: OID } });
    const r = await resolveM365CallerTarget(tech, 'org-A', 'jane@x.com');
    expect(executeM365UserLookupForCallerTarget).toHaveBeenCalledWith('org-A', 'jane@x.com', TENANT, 'tech-1');
    expect(r).toMatchObject({ backend: 'controlPlane', connectionId: 'cP', entraOid: OID });
  });

  it('uses the sole active Delegant connection when nothing else exists', async () => {
    dbq.rows.push([], [{ id: 'b1' }]);
    (loadConnection as any).mockResolvedValue({ ...activeConn, id: 'b1' });
    loadPinned.mockResolvedValue(resolved('delegant', 'b1'));
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: OID } });
    const r = await resolveM365CallerTarget(tech, 'org-A', 'jane@x.com');
    expect(loadPinned.mock.calls[0]).toEqual(['org-A', 'b1']);
    expect(r.connectionId).toBe('b1');
  });

  it('two Delegant connections and nothing else is subject_ambiguous (no lookup, no pin)', async () => {
    dbq.rows.push([], [{ id: 'b1' }, { id: 'b2' }]);
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'subject_ambiguous' });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(loadPinned).not.toHaveBeenCalled();
  });

  it('no connection at all is connection_not_ready', async () => {
    dbq.rows.push([], []);
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'connection_not_ready' });
  });

  it.each([
    ['a UPN', 'alex@x.com'],
    ['a non-GUID string', 'not-a-guid'],
    ['a missing id', undefined],
  ])('Graph returning %s as the id is subject_unmatched', async (_l, id) => {
    dbq.rows.push([{ id: 'cD', profile: 'legacy-direct' }]);
    loadPinned.mockResolvedValue(resolved('direct', 'cD'));
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: id === undefined ? {} : { id } });
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'subject_unmatched' });
  });

  it('a not_found lookup is subject_unmatched; other lookup failures are plain errors', async () => {
    dbq.rows.push([{ id: 'cD', profile: 'legacy-direct' }]);
    loadPinned.mockResolvedValue(resolved('direct', 'cD'));
    (invokeDirect as any).mockResolvedValue({ kind: 'error', code: 'not_found', message: 'x' });
    await expect(resolveM365CallerTarget(tech, 'org-A', 'ghost@x.com')).rejects.toMatchObject({ code: 'subject_unmatched' });
    dbq.rows.push([{ id: 'cD', profile: 'legacy-direct' }]);
    (invokeDirect as any).mockResolvedValue({ kind: 'error', code: 'auth_failed', message: 'x' });
    const err = await resolveM365CallerTarget(tech, 'org-A', 'ghost@x.com').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CallerVerificationValidationError);
  });

  it('a connection re-pointed to another tenant during the lookup is tenant_mismatch', async () => {
    dbq.rows.push([{ id: 'cD', profile: 'legacy-direct' }]);
    loadPinned.mockResolvedValueOnce(resolved('direct', 'cD')).mockResolvedValueOnce(resolved('direct', 'cD', OTHER_TENANT));
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { id: OID } });
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'tenant_mismatch' });
  });

  it('a Delegant row whose tenant differs from the pin is tenant_mismatch before the broker is called', async () => {
    dbq.rows.push([], [{ id: 'c1' }]);
    (loadConnection as any).mockResolvedValue({ ...activeConn, m365TenantId: OTHER_TENANT });
    loadPinned.mockResolvedValue(resolved('delegant', 'c1'));
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'tenant_mismatch' });
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('a control-plane tenant_mismatch from the lookup service surfaces as tenant_mismatch', async () => {
    dbq.rows.push([{ id: 'cP', profile: 'customer-graph-actions' }]);
    loadPinned.mockResolvedValue(resolved('controlPlane', 'cP'));
    (executeM365UserLookupForCallerTarget as any).mockResolvedValue({ ok: false, code: 'tenant_mismatch', message: 'x' });
    await expect(resolveM365CallerTarget(tech, 'org-A', 'jane@x.com')).rejects.toMatchObject({ code: 'tenant_mismatch' });
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
    expect(invokeDirect as any).toHaveBeenCalledWith('org-A', 'get_user', { userId: 'jane@x.com' }, { actionIntentId: undefined });
    expect(invokeDelegantTool as any).not.toHaveBeenCalled();
    expect(out).toContain('Jane');
  });

  it('reset_password via the direct backend requires a reason and dispatches reset_user_password to the pinned oid', async () => {
    const missing = await m365ResetPasswordHandler({ userIdentifier: 'jane@x.com' }, auth, 'sess-1', ctxFor());
    expect(missing.kind).toBe('error');
    if (missing.kind !== 'error') throw new Error('expected error');
    expect(JSON.parse(missing.llmText).error).toBe('missing_reason');

    pin('direct', 'm365_reset_password');
    (invokeDirect as any).mockResolvedValue({ kind: 'ok', data: { ok: true, temporaryPassword: 'Tmp!1234' } });
    const result = await m365ResetPasswordHandler({ userIdentifier: 'jane@x.com', reason: 'lockout' }, auth, 'sess-1', ctxFor());
    expect(invokeDirect).toHaveBeenCalledTimes(1);
    expect(invokeDirect).toHaveBeenCalledWith('org-A', 'reset_user_password', { userId: OID, reason: 'lockout' }, { actionIntentId: INTENT });
    expect(invokeDelegantTool as any).not.toHaveBeenCalled();
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('expected success');
    expect(result.secrets.temporaryPassword).toBe('Tmp!1234');
    expect(result.llmText).not.toContain('Tmp!1234');
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

// ────────────────────────────────────────────────────────────────────────────
// Site ceiling on M365 WRITE tools (review #6110). Same reasoning as the
// Google block: these Graph mutations act on the whole customer tenant, so a
// caller carrying any site or exact-device ceiling has nothing to narrow.
// ────────────────────────────────────────────────────────────────────────────
describe('m365 write tools — site ceiling', () => {
  const siteRestricted = { ...auth, scope: 'organization', allowedSiteIds: ['site-1'] } as any;
  const deviceBound = { ...auth, scope: 'organization', allowedDeviceIds: ['dev-1'] } as any;

  beforeEach(() => {
    // An earlier test in this file flips the direct-Graph backend on; clearAllMocks
    // does not reset a mockResolvedValue, so pin the Delegant path explicitly.
    (hasDirectM365Connection as any).mockResolvedValue(false);
    (loadSession as any).mockResolvedValue({ id: 'sess-1', orgId: 'org-A', delegantM365ConnectionId: 'c1' });
    (loadConnection as any).mockResolvedValue(activeConn);
  });

  it('m365_disable_user denies a site-restricted caller before calling Graph', async () => {
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, siteRestricted, 'sess-1');
    expect(out).toContain('Site-restricted');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
    expect(invokeDirect).not.toHaveBeenCalled();
  });

  it('m365_disable_user denies a device-bound run', async () => {
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, deviceBound, 'sess-1');
    expect(out).toContain('Site-restricted');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('m365_reset_password denies a site-restricted caller', async () => {
    const out = await m365ResetPasswordHandler({ userIdentifier: 'u1', reason: 'r' }, siteRestricted, 'sess-1');
    expect(out.kind).toBe('error');
    expect(out.llmText).toContain('Site-restricted');
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it('an unrestricted caller still reaches Graph (no over-blocking)', async () => {
    pin('delegant', 'm365_disable_user');
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: {} });
    const out = await m365DisableUserHandler({ userIdentifier: 'u1', reason: 'r' }, auth, 'sess-1', ctxFor());
    expect(out).toContain('Disabled');
    expect(invokeDelegantTool).toHaveBeenCalled();
  });

  it('READS stay available to a site-restricted caller', async () => {
    (invokeDelegantTool as any).mockResolvedValue({ kind: 'ok', data: { id: 'u1' } });
    const out = await m365LookupUserHandler({ userIdentifier: 'u1' }, siteRestricted, 'sess-1');
    expect(out).toContain('M365 user profile');
    expect(invokeDelegantTool).toHaveBeenCalled();
  });
});

// ============================================
// M1 control-plane identity write tools (Operator Recipe Library)
// ============================================
describe('M1 control-plane identity write handlers', () => {
  const GROUP = '55555555-5555-4555-8555-555555555555';
  const SKU = '66666666-6666-4666-8666-666666666666';
  const DEVICE = '77777777-7777-4777-8777-777777777777';
  const writeAuth = { orgId: 'org-A', user: { id: 'tech-1' } } as any;
  const forAuth = vi.mocked(executeM365WriteActionForAuth);

  type Handler = (i: Record<string, unknown>, a: AuthContext, s: string) => Promise<unknown>;
  const cases: Array<{ tool: string; handler: Handler; input: Record<string, unknown>; action: Record<string, unknown>; missing: Record<string, unknown> }> = [
    { tool: 'm365_revoke_sessions', handler: m365RevokeSessionsHandler as Handler,
      input: { userIdentifier: 'a@b.com', reason: 'r' },
      action: { type: 'm365.user.revoke_sessions', userIdentifier: 'a@b.com', reason: 'r' },
      missing: { userIdentifier: 'a@b.com' } },
    { tool: 'm365_remove_license', handler: m365RemoveLicenseHandler as Handler,
      input: { userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      action: { type: 'm365.user.license.remove', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      missing: { userIdentifier: 'a@b.com', skuIds: [SKU] } },
    { tool: 'm365_assign_license', handler: m365AssignLicenseHandler as Handler,
      input: { userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      action: { type: 'm365.user.license.assign', userIdentifier: 'a@b.com', skuIds: [SKU], reason: 'r' },
      missing: { userIdentifier: 'a@b.com', skuIds: [SKU] } },
    { tool: 'm365_remove_from_group', handler: m365RemoveFromGroupHandler as Handler,
      input: { groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      action: { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      missing: { groupId: GROUP, userIdentifier: 'a@b.com' } },
    { tool: 'm365_add_to_group', handler: m365AddToGroupHandler as Handler,
      input: { groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      action: { type: 'm365.group.membership.add', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'r' },
      missing: { groupId: GROUP, userIdentifier: 'a@b.com' } },
    { tool: 'm365_retire_intune_device', handler: m365RetireIntuneDeviceHandler as Handler,
      input: { managedDeviceId: DEVICE, reason: 'r' },
      action: { type: 'm365.intune.device.retire', managedDeviceId: DEVICE, reason: 'r' },
      missing: { managedDeviceId: DEVICE } },
    { tool: 'm365_set_auto_reply', handler: m365SetAutoReplyHandler as Handler,
      input: { userIdentifier: 'a@b.com', status: 'alwaysEnabled', internalReplyMessage: 'away', reason: 'r' },
      action: { type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@b.com', status: 'alwaysEnabled', internalReplyMessage: 'away', reason: 'r' },
      missing: { userIdentifier: 'a@b.com', status: 'disabled' } },
    { tool: 'm365_create_user', handler: m365CreateUserHandler as Handler,
      input: { userPrincipalName: 'n@b.com', displayName: 'N', mailNickname: 'n', usageLocation: 'US', reason: 'r' },
      action: { type: 'm365.user.create', userPrincipalName: 'n@b.com', displayName: 'N', mailNickname: 'n', usageLocation: 'US', reason: 'r' },
      missing: { userPrincipalName: 'n@b.com', displayName: 'N', mailNickname: 'n', usageLocation: 'US' } },
  ];
  const text = (r: unknown): string => (typeof r === 'string' ? r : (r as { llmText: string }).llmText);

  it('registers all eight at tier 3', () => {
    for (const c of cases) expect(m365ToolTiers[c.tool], c.tool).toBe(3);
  });

  it.each(cases)('$tool: missing reason returns missing_reason and never calls the service', async ({ handler, missing }) => {
    const out = await handler(missing, writeAuth, 'ignored');
    expect(text(out)).toContain('missing_reason');
    expect(forAuth).not.toHaveBeenCalled();
  });

  it.each(cases)('$tool: builds the typed action and passes the input orgId, ignoring the session', async ({ handler, input, action }) => {
    forAuth.mockResolvedValue({ ok: true, result: { success: true, action: action.type, userId: 'u1', temporaryPassword: 'Zq9!hunter2xx' } } as any);
    await handler({ ...input, orgId: 'org-B' }, writeAuth, 'sess-1');
    expect(forAuth).toHaveBeenCalledWith(writeAuth, action, 'org-B');
    expect(loadSession).not.toHaveBeenCalled();
    expect(invokeDelegantTool).not.toHaveBeenCalled();
  });

  it.each(cases)('$tool: a service refusal is surfaced verbatim as an error', async ({ handler, input }) => {
    forAuth.mockResolvedValue({ ok: false, code: 'consent_upgrade_required', message: 'Re-consent needed for this action.' } as any);
    const out = text(await handler(input, writeAuth, 'sess-1'));
    expect(out).toContain('consent_upgrade_required');
    expect(out).toContain('Re-consent needed for this action.');
  });

  it.each(cases)('$tool: schema-invalid input returns invalid_arguments and never calls the service', async ({ handler, input }) => {
    const out = text(await handler({ ...input, reason: 'r'.repeat(501) }, writeAuth, 'sess-1'));
    expect(out).toContain('invalid_arguments');
    expect(forAuth).not.toHaveBeenCalled();
  });

  // Tenant-wide identity writes: the same org-wide governance ceiling as the
  // Delegant pair — a device-bound run or a site-restricted caller (even with
  // an EMPTY allow-list, which still means restricted) never reaches the service.
  it.each(cases)('$tool: denies a device-bound run and a site-restricted caller before the service', async ({ handler, input }) => {
    for (const restricted of [
      { ...writeAuth, scope: 'organization', allowedDeviceIds: ['dev-1'] },
      { ...writeAuth, scope: 'organization', allowedSiteIds: [] },
    ]) {
      const out = text(await handler(input, restricted as AuthContext, 'sess-1'));
      expect(out).toContain('Site-restricted');
    }
    expect(forAuth).not.toHaveBeenCalled();
  });

  it('m365_create_user returns a SecretToolResult: password only in secrets, never in llmText', async () => {
    const PW = 'Zq9!hunter2xx';
    forAuth.mockResolvedValue({
      ok: true,
      result: { success: true, action: 'm365.user.create', userId: 'u1', userPrincipalName: 'n@b.com', temporaryPassword: PW, forceChangeNextSignIn: true },
    } as any);
    const result = await m365CreateUserHandler(cases[7]!.input, writeAuth, 'sess-1');
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('unreachable');
    expect(result.secrets.temporaryPassword).toBe(PW);
    expect(result.llmText).not.toContain(PW);
    expect(result.llmText).toContain('n@b.com');
  });

  it('m365_create_user errors when the service returns no credential', async () => {
    forAuth.mockResolvedValue({ ok: true, result: { success: true, action: 'm365.user.create', userId: 'u1' } } as any);
    const result = await m365CreateUserHandler(cases[7]!.input, writeAuth, 'sess-1');
    expect(result.kind).toBe('error');
  });

  it('m365_set_auto_reply rejects a message over 4000 chars at the schema', async () => {
    const out = text(await m365SetAutoReplyHandler(
      { userIdentifier: 'a@b.com', status: 'alwaysEnabled', internalReplyMessage: 'x'.repeat(4001), reason: 'r' }, writeAuth, 's'));
    expect(out).toContain('invalid_arguments');
  });
});
