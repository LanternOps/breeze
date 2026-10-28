import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const SITE = '00000000-0000-4000-8000-0000000000a1';
const DEV = '00000000-0000-4000-8000-0000000000f2';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const VAR = '00000000-0000-4000-8000-0000000000b5';
const SESSION = '00000000-0000-4000-8000-0000000000b6';
const SECRET = 'w13-secret-plaintext-marker';

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[]): unknown {
  const target: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({
  select: vi.fn(),
  verify: vi.fn(),
  exec: vi.fn(),
  auditAsync: vi.fn(),
  listVars: vi.fn(),
  createVar: vi.fn(),
  updateVar: vi.fn(),
  deleteVar: vi.fn(),
  endSession: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: h.verify }));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: h.exec }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync }));
vi.mock('./tenantVariables', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listTenantVariables: h.listVars,
  createTenantVariable: h.createVar,
  updateTenantVariable: h.updateVar,
  deleteTenantVariable: h.deleteVar,
}));
vi.mock('./quickSupportEnd', () => ({ endSupportSession: h.endSession }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerDeviceEventLogTools } from './aiToolsDeviceEventLog';
import { registerTenantVariableTools } from './aiToolsTenantVariables';
import { registerSupportSessionTools } from './aiToolsSupportSessions';

const tools = new Map<string, AiTool>();
for (const register of [registerDeviceEventLogTools, registerTenantVariableTools, registerSupportSessionTools]) register(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: PARTNER,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  canAccessSite: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const noMfa = () => makeAuth({ token: {} });
const partner = (over: Record<string, unknown> = {}) => makeAuth({ scope: 'partner', orgId: null, ...over });

const raw = (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) => tools.get(name)!.handler(input, auth);
const run = async (name: string, input: Record<string, unknown>, auth?: AuthContext) =>
  JSON.parse(await raw(name, input, auth)) as Record<string, any>;

const device = { id: DEV, orgId: ORG, siteId: SITE, hostname: 'host-1', osType: 'windows', status: 'online' };
const varRow = (over: Record<string, unknown> = {}) => ({
  id: VAR, orgId: ORG, partnerId: null, key: 'api_base', value: 'enc', isSecret: false, description: null, version: 1,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.verify.mockResolvedValue({ device });
  h.select.mockImplementation(() => chain([]));
});

describe('browse_device_event_log', () => {
  it('every action needs an MFA session; nothing is dispatched without one', async () => {
    for (const action of ['list_logs', 'query', 'get_event']) {
      expect((await run('browse_device_event_log', { action, deviceId: DEV, logName: 'System', recordId: 1 }, noMfa())).code).toBe('MFA_REQUIRED');
    }
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('query never returns the raw XML and clips long messages', async () => {
    h.exec.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ events: [{ recordId: 7, level: 'Error', source: 'Outlook', message: 'x'.repeat(5000), rawXml: '<Event>secret</Event>' }], total: 1 }),
    });
    const out = await run('browse_device_event_log', { action: 'query', deviceId: DEV, logName: 'Application', limit: 500 });
    expect(JSON.stringify(out)).not.toContain('<Event>');
    expect(out.events[0]).toMatchObject({ recordId: 7, level: 'error', source: 'Outlook', messageTruncated: true });
    expect(String(out.events[0].message).length).toBeLessThanOrEqual(2001);
    expect(h.exec).toHaveBeenCalledWith(expect.anything(), 'browse_device_event_log', DEV, 'event_logs_query',
      expect.objectContaining({ logName: 'Application', limit: 100, page: 1 }), expect.objectContaining({ timeoutMs: 30000 }));
  });

  it('query and get_event need a logName; get_event needs a recordId', async () => {
    expect((await run('browse_device_event_log', { action: 'query', deviceId: DEV })).code).toBe('VALIDATION_ERROR');
    expect((await run('browse_device_event_log', { action: 'get_event', deviceId: DEV, logName: 'System' })).code).toBe('VALIDATION_ERROR');
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('an offline device is DEVICE_OFFLINE, an unreachable one NOT_FOUND; a failed command is COMMAND_FAILED', async () => {
    h.verify.mockResolvedValueOnce({ error: 'Device host-1 is not online (status: offline). This tool needs a live connection.' });
    expect((await run('browse_device_event_log', { action: 'list_logs', deviceId: DEV })).code).toBe('DEVICE_OFFLINE');
    h.verify.mockResolvedValueOnce({ error: 'Device not found or access denied' });
    expect((await run('browse_device_event_log', { action: 'list_logs', deviceId: DEV })).code).toBe('NOT_FOUND');
    h.exec.mockResolvedValue({ status: 'timeout', error: 'Command timed out' });
    expect((await run('browse_device_event_log', { action: 'list_logs', deviceId: DEV })).code).toBe('COMMAND_FAILED');
    expect(h.verify).toHaveBeenCalledWith(DEV, expect.anything(), true);
  });
});

describe('manage_tenant_variables (W13-D7: never a secret value)', () => {
  it('list never returns a secret value, even if the service handed one back', async () => {
    h.listVars.mockResolvedValue([
      { id: VAR, key: 'db_password', isSecret: true, value: SECRET, ownerScope: 'organization', orgId: ORG },
      { id: 'v2', key: 'api_base', isSecret: false, value: 'https://example.test', ownerScope: 'organization', orgId: ORG },
    ]);
    const text = await raw('manage_tenant_variables', { action: 'list' });
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text).variables.map((v: { value: unknown }) => v.value)).toEqual([null, 'https://example.test']);
  });

  it('control: the same marker on a PLAIN row does reach the output, so the grep above can go red', async () => {
    h.listVars.mockResolvedValue([
      { id: VAR, key: 'api_base', isSecret: false, value: SECRET, ownerScope: 'organization', orgId: ORG },
    ]);
    expect(await raw('manage_tenant_variables', { action: 'list' })).toContain(SECRET);
  });

  it('the update/delete row lookup selects only id, owner and the secret flag — never the stored value', async () => {
    h.select.mockImplementation(() => chain([varRow({ isSecret: true })]));
    await run('manage_tenant_variables', { action: 'delete', variableId: VAR });
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.select.mock.calls[0]![0] as object).sort()).toEqual(['id', 'isSecret', 'orgId']);
  });

  it('a device-bound session cannot list org-wide variables', async () => {
    expect((await run('manage_tenant_variables', { action: 'list' }, makeAuth({ allowedDeviceIds: [DEV] }))).code).toBe('ACCESS_DENIED');
    expect(h.listVars).not.toHaveBeenCalled();
  });

  it('create always makes a plain variable and audits the binding, never the value', async () => {
    h.createVar.mockResolvedValue(varRow());
    await run('manage_tenant_variables', { action: 'create', key: 'api_base', value: 'https://example.test' });
    expect(h.createVar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ isSecret: false, ownerScope: 'organization' }));
    const audit = JSON.stringify(h.auditAsync.mock.calls);
    expect(audit).toContain('tenant_variable.create');
    expect(audit).not.toContain('https://example.test');
  });

  it('update refuses a secret row before the service is called', async () => {
    h.select.mockImplementation(() => chain([varRow({ isSecret: true })]));
    const text = await raw('manage_tenant_variables', { action: 'update', variableId: VAR, value: SECRET });
    expect(JSON.parse(text).code).toBe('ACCESS_DENIED');
    expect(h.updateVar).not.toHaveBeenCalled();
    expect(text).not.toContain(SECRET);
  });

  it('update and delete refuse an existing partner-wide row', async () => {
    h.select.mockImplementation(() => chain([varRow({ orgId: null, partnerId: PARTNER })]));
    for (const action of ['update', 'delete']) {
      expect((await run('manage_tenant_variables', { action, variableId: VAR, value: 'x' })).code).toBe('ACCESS_DENIED');
    }
    expect(h.updateVar).not.toHaveBeenCalled();
    expect(h.deleteVar).not.toHaveBeenCalled();
  });

  it('deleting a secret row is allowed and its output and audit carry no value', async () => {
    h.select.mockImplementation(() => chain([varRow({ isSecret: true, value: SECRET })]));
    h.deleteVar.mockResolvedValue(varRow({ isSecret: true, value: SECRET }));
    const text = await raw('manage_tenant_variables', { action: 'delete', variableId: VAR });
    expect(JSON.parse(text)).toMatchObject({ deleted: true, variableId: VAR });
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(h.auditAsync.mock.calls)).not.toContain(SECRET);
  });

  it('a site-restricted session cannot write; a write without MFA is refused', async () => {
    const restricted = makeAuth({ allowedSiteIds: [SITE], canAccessSite: (s: string) => s === SITE });
    expect((await run('manage_tenant_variables', { action: 'create', key: 'k', value: 'v' }, restricted)).code).toBe('ACCESS_DENIED');
    expect((await run('manage_tenant_variables', { action: 'create', key: 'k', value: 'v' }, noMfa())).code).toBe('MFA_REQUIRED');
    expect(h.createVar).not.toHaveBeenCalled();
  });
});

describe('manage_support_sessions (W13-D8)', () => {
  const session = {
    id: SESSION, orgId: ORG, status: 'ready', deviceId: null, codeHash: 'HASH-MARKER', claimedFromIp: '192.0.2.77',
    attributedOrgId: null, attributionLabel: 'Front desk', createdAt: new Date(), codeExpiresAt: new Date(), hardExpiresAt: new Date(),
    claimedAt: null, endedAt: null, endedReason: null, createdByUserId: 'user-1',
  };

  it('org scope and restricted sessions are refused before any read', async () => {
    expect((await run('manage_support_sessions', { action: 'list' })).code).toBe('ACCESS_DENIED');
    expect((await run('manage_support_sessions', { action: 'list' }, partner({ allowedSiteIds: [SITE] }))).code).toBe('ACCESS_DENIED');
    expect((await run('manage_support_sessions', { action: 'list' }, partner({ allowedDeviceIds: [DEV] }))).code).toBe('ACCESS_DENIED');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('get never returns the code hash or the claiming IP', async () => {
    h.select.mockImplementation(() => chain([{ session }]));
    const text = await raw('manage_support_sessions', { action: 'get', sessionId: SESSION }, partner());
    expect(text).not.toContain('HASH-MARKER');
    expect(text).not.toContain('192.0.2.77');
    expect(JSON.parse(text).session).toMatchObject({ id: SESSION, attributionLabel: 'Front desk' });
  });

  it('end needs MFA, refuses an ended session, and ends + audits a live one', async () => {
    h.select.mockImplementation(() => chain([{ session }]));
    expect((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner({ token: {} }))).code).toBe('MFA_REQUIRED');
    h.endSession.mockResolvedValue({ ended: true, disconnect: 'closed', commandDelivered: true });
    expect(await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).toMatchObject({ ended: true, sessionId: SESSION });
    expect(h.endSession).toHaveBeenCalledWith(SESSION, 'tech');
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'support_session_ended' }));

    h.endSession.mockClear();
    h.select.mockImplementation(() => chain([{ session: { ...session, status: 'ended' } }]));
    expect((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).code).toBe('CONFLICT');
    expect(h.endSession).not.toHaveBeenCalled();
  });

  it('a session the caller\'s partner does not own is NOT_FOUND and never ended', async () => {
    h.select.mockImplementation(() => chain([]));
    expect((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).code).toBe('NOT_FOUND');
    expect(h.endSession).not.toHaveBeenCalled();
  });
});

describe('review fixes (#10352)', () => {
  it('event-log browse refuses a non-Windows device before dispatch', async () => {
    h.verify.mockResolvedValue({ device: { ...device, osType: 'macos' } });
    expect((await run('browse_device_event_log', { action: 'list_logs', deviceId: DEV })).code).toBe('NOT_SUPPORTED');
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('a completed command with the wrong payload shape is INVALID_AGENT_RESPONSE, never an empty success', async () => {
    h.exec.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ error: 'wevtapi unavailable' }) });
    const out = await run('browse_device_event_log', { action: 'query', deviceId: DEV, logName: 'System' });
    expect(out.code).toBe('INVALID_AGENT_RESPONSE');
    expect(String(out.error)).toMatch(/wevtapi unavailable/);
    h.exec.mockResolvedValue({ status: 'completed', stdout: '' });
    expect((await run('browse_device_event_log', { action: 'list_logs', deviceId: DEV })).code).toBe('INVALID_AGENT_RESPONSE');
  });

  it('get_event returns the projected event (route-identical level, numeric-string id, no XML) or INVALID_AGENT_RESPONSE', async () => {
    h.exec.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ recordId: '42', level: 'Fehler', message: 'boom', rawXml: '<Event/>', userId: 'S-1-5-18' }) });
    const out = await run('browse_device_event_log', { action: 'get_event', deviceId: DEV, logName: 'System', recordId: 42 });
    expect(out.event).toMatchObject({ recordId: 42, level: 'information', message: 'boom', user: 'S-1-5-18' });
    expect(JSON.stringify(out)).not.toContain('<Event');
    h.exec.mockResolvedValue({ status: 'completed', stdout: 'not json' });
    expect((await run('browse_device_event_log', { action: 'get_event', deviceId: DEV, logName: 'System', recordId: 42 })).code).toBe('INVALID_AGENT_RESPONSE');
  });

  it('a malformed event in a query result is counted, not silently lost', async () => {
    h.exec.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ events: [{ recordId: 1, message: 'ok' }, { message: 'no id' }], total: 2 }) });
    const out = await run('browse_device_event_log', { action: 'query', deviceId: DEV, logName: 'System' });
    expect(out.events).toHaveLength(1);
    expect(out.droppedMalformed).toBe(1);
  });

  it('tenant-variable update asks the service to write only a still-plain row, and drops isSecret', async () => {
    h.select.mockImplementation(() => chain([varRow()]));
    h.updateVar.mockResolvedValue(varRow({ version: 2 }));
    await run('manage_tenant_variables', { action: 'update', variableId: VAR, value: 'x', isSecret: true });
    expect(h.updateVar).toHaveBeenCalledWith(expect.anything(), VAR, { value: 'x' }, { requirePlain: true });
  });

  it('a description-only update on a secret row is refused too', async () => {
    h.select.mockImplementation(() => chain([varRow({ isSecret: true })]));
    expect((await run('manage_tenant_variables', { action: 'update', variableId: VAR, description: 'new' })).code).toBe('ACCESS_DENIED');
    expect(h.updateVar).not.toHaveBeenCalled();
  });

  it('a service 500 is not reported as a validation error', async () => {
    const { TenantVariableError } = await import('./tenantVariables');
    h.createVar.mockRejectedValue(new TenantVariableError('Failed to create variable', 500));
    const out = await run('manage_tenant_variables', { action: 'create', key: 'k', value: 'v' });
    expect(out.code).not.toBe('VALIDATION_ERROR');
    h.createVar.mockRejectedValue(new TenantVariableError('A variable named "k" already exists in this scope', 409));
    expect((await run('manage_tenant_variables', { action: 'create', key: 'k', value: 'v' })).code).toBe('CONFLICT');
  });

  it('support-session end: an expired session and a lost race are CONFLICT with no audit', async () => {
    const base = { id: SESSION, orgId: ORG, status: 'expired', deviceId: null, codeHash: 'h', createdAt: new Date() };
    h.select.mockImplementation(() => chain([{ session: base }]));
    expect((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).code).toBe('CONFLICT');
    expect(h.endSession).not.toHaveBeenCalled();

    h.select.mockImplementation(() => chain([{ session: { ...base, status: 'pending' } }]));
    h.endSession.mockResolvedValue({ ended: false, disconnect: null, commandDelivered: false });
    expect((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).code).toBe('CONFLICT');
    expect(h.auditAsync).not.toHaveBeenCalled();
  });

  it('support-session end notes match what happened to the client', async () => {
    h.select.mockImplementation(() => chain([{ session: { id: SESSION, orgId: ORG, status: 'claimed', deviceId: DEV, createdAt: new Date() } }]));
    h.endSession.mockResolvedValue({ ended: true, disconnect: 'not-connected', commandDelivered: false });
    expect(String((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).note)).toMatch(/not connected right now/);
    h.endSession.mockResolvedValue({ ended: true, disconnect: 'close-failed', commandDelivered: true });
    expect(String((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).note)).toMatch(/did not close cleanly/);
    h.select.mockImplementation(() => chain([{ session: { id: SESSION, orgId: ORG, status: 'pending', deviceId: null, createdAt: new Date() } }]));
    h.endSession.mockResolvedValue({ ended: true, disconnect: null, commandDelivered: false });
    expect(String((await run('manage_support_sessions', { action: 'end', sessionId: SESSION }, partner())).note)).toMatch(/No client had joined/);
  });
});

