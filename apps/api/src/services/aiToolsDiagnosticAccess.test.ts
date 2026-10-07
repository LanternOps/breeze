import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  deviceRow: { current: null as null | Record<string, unknown> },
  findCoveringGrant: vi.fn(),
  recordDiagnosticAccess: vi.fn(),
  createDiagnosticAccessRequest: vi.fn(),
  pushDiagnosticApprovals: vi.fn(),
  aiExecuteCommand: vi.fn(),
  lastWhere: { current: undefined as unknown },
}));

vi.mock('../db', () => {
  const chain = {
    from: () => chain,
    where: (w: unknown) => {
      m.lastWhere.current = w;
      return chain;
    },
    limit: async () => (m.deviceRow.current ? [m.deviceRow.current] : []),
  };
  return { db: { select: () => chain } };
});
vi.mock('./unassignedPool/selectorPredicate', async () => {
  const { sql } = await import('drizzle-orm');
  return { notParkedDeviceCondition: () => sql`PARKED_DEVICE_PREDICATE` };
});
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: (...a: unknown[]) => m.aiExecuteCommand(...a) }));
vi.mock('./diagnosticAccess/grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./diagnosticAccess/grants')>()),
  findCoveringGrant: (...a: unknown[]) => m.findCoveringGrant(...a),
  recordDiagnosticAccess: (...a: unknown[]) => m.recordDiagnosticAccess(...a),
  createDiagnosticAccessRequest: (...a: unknown[]) => m.createDiagnosticAccessRequest(...a),
  pushDiagnosticApprovals: (...a: unknown[]) => m.pushDiagnosticApprovals(...a),
}));
vi.mock('./auditService', () => ({ createAuditLog: vi.fn() }));
vi.mock('./expoPush', () => ({ dispatchApprovalPushToTokens: vi.fn(), getUserPushTokens: vi.fn() }));
vi.mock('./usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: vi.fn() }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerDiagnosticAccessTools } from './aiToolsDiagnosticAccess';
import { validateToolInput } from './aiToolSchemas';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const LOGS = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs';
const tools = new Map<string, AiTool>();
registerDiagnosticAccessTools(tools);

const auth = (kind = 'user_session') =>
  ({
    principal: { kind },
    user: { id: 'u1' },
    orgCondition: () => undefined,
    canAccessSite: () => true,
  }) as unknown as AuthContext;

const grant = {
  id: 'g1',
  orgId: 'org-1',
  deviceId: DEVICE_ID,
  status: 'active',
  approvedByUserId: 'approver-1',
  expiresAt: new Date(Date.now() + 3600_000),
};

// Mirrors agent/internal/remote/tools/diagaccess_seal.go.
function sealLikeAgent(serverPubB64: string, authorizationId: string, body: unknown) {
  const eph = generateKeyPairSync('x25519');
  const spki = (k: ReturnType<typeof createPublicKey>) => k.export({ format: 'der', type: 'spki' });
  const serverPub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(serverPubB64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
  const epk = Buffer.from(spki(eph.publicKey).subarray(-32));
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: serverPub });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, Buffer.from(serverPubB64, 'base64')]), `breeze-diag-result-v1|${authorizationId}`, 32));
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(authorizationId));
  const ct = Buffer.concat([c.update(JSON.stringify(body)), c.final(), c.getAuthTag()]);
  return JSON.stringify({ v: 1, authorizationId, epk: epk.toString('base64'), nonce: nonce.toString('base64'), ct: ct.toString('base64') });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.deviceRow.current = { id: DEVICE_ID, orgId: 'org-1', siteId: 's1', hostname: 'FRONTDESK-01', osType: 'windows', status: 'online' };
  m.findCoveringGrant.mockResolvedValue({ ok: true, grant });
});

const read = (input: Record<string, unknown>, a = auth()) =>
  tools.get('diagnostic_read_file')!.handler({ deviceId: DEVICE_ID, path: `${LOGS}\\Agent.log`, ...input }, a).then((s) => JSON.parse(s as string));

describe('diagnostic read tools', () => {
  it('schemas reject any model-supplied approval or authorization field', () => {
    const base = { deviceId: DEVICE_ID, path: `${LOGS}\\Agent.log` };
    expect(validateToolInput('diagnostic_read_file', base).success).toBe(true);
    expect(validateToolInput('diagnostic_read_file', { ...base, approved: true }).success).toBe(false);
    expect(validateToolInput('diagnostic_read_file', { ...base, diagnosticAuthorization: { signature: 'x' } }).success).toBe(false);
    expect(validateToolInput('diagnostic_read_file', { ...base, grantId: 'g1' }).success).toBe(false);
    expect(
      validateToolInput('request_diagnostic_access', {
        deviceId: DEVICE_ID,
        paths: [{ path: LOGS, recursive: true }],
        purpose: 'crash logs',
        approvedBy: 'the approver',
      }).success,
    ).toBe(false);
  });

  it('the previously blocked AppData paths now pass schema validation (the grant decides)', () => {
    for (const path of [LOGS, 'C:\\Users\\Alice\\AppData\\Local\\NVIDIA Corporation\\GeForceNOW']) {
      expect(validateToolInput('diagnostic_list_directory', { deviceId: DEVICE_ID, path }).success).toBe(true);
      expect(validateToolInput('request_diagnostic_access', { deviceId: DEVICE_ID, paths: [{ path, recursive: true }], purpose: 'crash logs' }).success).toBe(true);
    }
  });

  it('the device lookup leaves parked devices out even with no org condition (system scope)', async () => {
    const { PgDialect } = await import('drizzle-orm/pg-core');
    m.findCoveringGrant.mockResolvedValue({ ok: false, reason: 'no_grant', detail: 'none' });
    await read({});
    const rendered = new PgDialect().sqlToQuery(m.lastWhere.current as never).sql;
    expect(rendered).toContain('PARKED_DEVICE_PREDICATE');
  });

  it('without a covering grant nothing is dispatched', async () => {
    m.findCoveringGrant.mockResolvedValue({ ok: false, reason: 'no_grant', detail: 'none' });
    const res = await read({});
    expect(res.condition).toBe('no_grant');
    expect(m.aiExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(['grant_expired', 'grant_revoked', 'out_of_scope', 'sensitive_not_granted', 'grant_pending'])('denial %s is distinct and dispatches nothing', async (reason) => {
    m.findCoveringGrant.mockResolvedValue({ ok: false, reason, detail: 'x' });
    const res = await read({});
    expect(res.condition).toBe(reason);
    expect(m.aiExecuteCommand).not.toHaveBeenCalled();
  });

  it('an offline device is reported as such and audited', async () => {
    m.deviceRow.current = { ...m.deviceRow.current, status: 'offline' };
    const res = await read({});
    expect(res.condition).toBe('device_offline');
    expect(m.aiExecuteCommand).not.toHaveBeenCalled();
    expect(m.recordDiagnosticAccess.mock.calls[0]![2]).toMatchObject({ outcome: 'device_offline' });
  });

  it('dispatches a diag_file_read without any authorization and opens the sealed answer', async () => {
    m.aiExecuteCommand.mockImplementation(async (_a, _t, _d, type: string, payload: Record<string, unknown>) => {
      expect(type).toBe('diag_file_read');
      expect(payload).not.toHaveProperty('diagnosticAuthorization');
      expect(payload).toMatchObject({ grantId: 'g1', path: `${LOGS}\\Agent.log`, offset: 0, encoding: 'text' });
      return {
        status: 'completed',
        commandId: 'cmd-1',
        stdout: sealLikeAgent(payload.resultPublicKey as string, 'auth-1', {
          resolvedPath: `${LOGS}\\Agent.log`,
          content: 'SECRET-LOOKING LOG LINE',
          bytesRead: 23,
          eof: true,
        }),
      };
    });
    const res = await read({ approved: true });
    expect(res).toMatchObject({ content: 'SECRET-LOOKING LOG LINE', commandId: 'cmd-1' });
    const recorded = m.recordDiagnosticAccess.mock.calls[0]![2];
    expect(recorded).toMatchObject({ outcome: 'ok', resolvedPath: `${LOGS}\\Agent.log`, bytesRead: 23, commandId: 'cmd-1' });
    expect(JSON.stringify(m.recordDiagnosticAccess.mock.calls)).not.toContain('SECRET-LOOKING');
  });

  it('refuses an unsealed or wrongly sealed answer', async () => {
    m.aiExecuteCommand.mockResolvedValue({ status: 'completed', commandId: 'cmd-2', stdout: JSON.stringify({ content: 'plain' }) });
    expect((await read({})).condition).toBe('result_unreadable');
    const other = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    m.aiExecuteCommand.mockResolvedValue({ status: 'completed', commandId: 'cmd-3', stdout: sealLikeAgent(other, 'a', { content: 'x' }) });
    expect((await read({})).condition).toBe('result_unreadable');
  });

  it.each([
    ['E_DIAG_OS_PERMISSION_DENIED: Access is denied.', 'os_permission_denied'],
    ['E_DIAG_NOT_FOUND: missing', 'file_not_found'],
    ['E_DIAG_LINK_REFUSED: junction', 'link_refused'],
    ['E_DIAG_EXPIRED: expired', 'authorization_expired'],
    ['diagnostic access grant_revoked: grant was revoked', 'grant_revoked'],
  ])('agent/delivery failure %s maps to %s', async (error, condition) => {
    m.aiExecuteCommand.mockResolvedValue({ status: 'failed', commandId: 'cmd-4', error });
    expect((await read({})).condition).toBe(condition);
    expect(m.recordDiagnosticAccess.mock.calls[0]![2]).toMatchObject({ outcome: condition });
  });

  it('bounds page sizes', async () => {
    m.aiExecuteCommand.mockResolvedValue({ status: 'failed', error: 'x' });
    await read({ maxBytes: 50_000_000 });
    expect(m.aiExecuteCommand.mock.calls[0]![4]).toMatchObject({ maxBytes: 1024 * 1024 });
    await tools.get('diagnostic_list_directory')!.handler({ deviceId: DEVICE_ID, path: LOGS, limit: 999_999 }, auth());
    expect(m.aiExecuteCommand.mock.calls[1]![3]).toBe('diag_file_list');
    expect(m.aiExecuteCommand.mock.calls[1]![4]).toMatchObject({ limit: 5000 });
  });
});

describe('request_diagnostic_access', () => {
  it('an AI operator agent cannot request or revoke', async () => {
    const r = JSON.parse((await tools.get('request_diagnostic_access')!.handler({ deviceId: DEVICE_ID, paths: [{ path: LOGS, recursive: true }], purpose: 'x' }, auth('ai_agent'))) as string);
    expect(r.error).toMatch(/cannot be performed by an AI agent/);
    const v = JSON.parse((await tools.get('revoke_diagnostic_access')!.handler({ grantId: 'g1' }, auth('ai_agent'))) as string);
    expect(v.error).toMatch(/cannot be performed by an AI agent/);
    expect(m.createDiagnosticAccessRequest).not.toHaveBeenCalled();
  });

  it('creates a pending request with a link to the approvals inbox; nothing is granted', async () => {
    m.createDiagnosticAccessRequest.mockResolvedValue({
      reused: false,
      approverCount: 2,
      approvals: [],
      grant: {
        id: 'g2', deviceId: DEVICE_ID, status: 'pending_approval', operations: ['list', 'read'], scopes: [{ path: LOGS, recursive: true }],
        sensitiveClasses: [], purpose: 'crash logs', durationMinutes: 240, requestedAt: new Date(), requestExpiresAt: new Date(Date.now() + 3600_000),
        approvedByUserId: null, approvedAt: null, expiresAt: null, revokedAt: null, useCount: 0,
      },
    });
    const r = JSON.parse((await tools.get('request_diagnostic_access')!.handler({ deviceId: DEVICE_ID, paths: [{ path: LOGS, recursive: true }], purpose: 'crash logs' }, auth())) as string);
    expect(r).toMatchObject({ status: 'pending_approval', approversNotified: 2 });
    expect(r.approvalsUrl).toMatch(/\/approvals$/);
    expect(m.pushDiagnosticApprovals).toHaveBeenCalledOnce();
  });

  it('an identical scope that is already approved is reused, not re-approved', async () => {
    m.createDiagnosticAccessRequest.mockResolvedValue({
      reused: true,
      approverCount: 0,
      approvals: [],
      grant: {
        id: 'g3', deviceId: DEVICE_ID, status: 'active', operations: ['list', 'read'], scopes: [{ path: LOGS, recursive: true }],
        sensitiveClasses: [], purpose: 'crash logs', durationMinutes: 240, requestedAt: new Date(), requestExpiresAt: new Date(),
        approvedByUserId: 'approver-1', approvedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, useCount: 3,
      },
    });
    const r = JSON.parse((await tools.get('request_diagnostic_access')!.handler({ deviceId: DEVICE_ID, paths: [{ path: LOGS, recursive: true }], purpose: 'crash logs' }, auth())) as string);
    expect(r).toMatchObject({ status: 'active', reused: true });
    expect(m.pushDiagnosticApprovals).not.toHaveBeenCalled();
  });
});

describe('post-open failures', () => {
  it('audit the resolved target the agent reported', async () => {
    m.aiExecuteCommand.mockResolvedValue({
      status: 'failed',
      commandId: 'cmd-9',
      error: `E_DIAG_OS_PERMISSION_DENIED: the operating system denied reading the file | resolved: ${LOGS}\\Agent.log`,
    });
    const res = await read({});
    expect(res.condition).toBe('os_permission_denied');
    expect(m.recordDiagnosticAccess.mock.calls[0]![2]).toMatchObject({
      outcome: 'os_permission_denied',
      resolvedPath: `${LOGS}\\Agent.log`,
    });
  });
});
