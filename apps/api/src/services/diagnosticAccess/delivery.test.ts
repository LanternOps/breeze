import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signingKey, deviceRows, commandRows, loadGrantMock } = vi.hoisted(() => ({
  signingKey: { current: null as null | { privateKey: import('node:crypto').KeyObject; publicKey: import('node:crypto').KeyObject } },
  deviceRows: { current: [] as Array<{ id: string; orgId: string; osType: string }> },
  commandRows: { current: [{ createdBy: 'u1' }] as Array<{ createdBy: string | null }> },
  loadGrantMock: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => deviceRows.current };
  const cmdChain = { from: () => cmdChain, where: () => cmdChain, limit: async () => commandRows.current };
  return {
    db: { select: (fields?: Record<string, unknown>) => (fields && 'createdBy' in fields ? cmdChain : chain) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../manifestSigning', () => ({
  ensureActiveSigningKey: async () => ({ keyId: 'k-test', publicKeyB64: 'unused' }),
  signBytesWithActiveKey: async (bytes: Uint8Array) => ({
    keyId: 'k-test',
    signature: sign(null, Buffer.from(bytes), signingKey.current!.privateKey).toString('base64'),
  }),
}));
vi.mock('./grants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grants')>()),
  loadGrant: (...a: unknown[]) => loadGrantMock(...a),
}));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock('../auditService', () => ({ createAuditLog: (...a: unknown[]) => auditMock(...a) }));
vi.mock('../expoPush', () => ({ dispatchApprovalPushToTokens: vi.fn(), getUserPushTokens: vi.fn() }));
vi.mock('../usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: vi.fn() }));

import { CommandDeliveryRefusedError } from '../commandDeliveryRefusal';
import { canonicalDiagnosticAuthorizationBytes, DIAGNOSTIC_AUTHORIZATION_LIFETIME_MS, type DiagnosticAuthorizationV1 } from './authorization';
import { prepareDiagnosticDelivery } from './delivery';

const LOGS = 'C:\\Users\\Alice\\AppData\\Local\\Battle.net\\Logs';
const ctx = { commandId: 'cmd-1', deviceId: 'dev-1', type: 'diag_file_read', claimedAt: null };
const payload = () => ({
  grantId: 'g1',
  path: `${LOGS}\\Agent.log`,
  offset: 0,
  maxBytes: 65536,
  encoding: 'text',
  resultPublicKey: Buffer.alloc(32, 3).toString('base64'),
});
const activeGrant = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  status: 'active',
  operations: ['list', 'read'],
  scopes: [{ path: LOGS, recursive: true }],
  sensitiveClasses: [],
  approvedByUserId: 'approver-1',
  beneficiaryKind: 'user',
  beneficiaryId: 'u1',
  requestedByUserId: 'u1',
  approvedAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 3600_000),
  ...over,
});

beforeEach(() => {
  signingKey.current = generateKeyPairSync('ed25519');
  deviceRows.current = [{ id: 'dev-1', orgId: 'org-1', osType: 'windows' }];
  commandRows.current = [{ createdBy: 'u1' }];
  loadGrantMock.mockReset();
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  loadGrantMock.mockResolvedValue(activeGrant());
});

describe('prepareDiagnosticDelivery', () => {
  it('mints an authorization bound to this command, device, path and arguments', async () => {
    const out = await prepareDiagnosticDelivery('read', payload(), ctx);
    const auth = out.diagnosticAuthorization as DiagnosticAuthorizationV1;
    expect(auth).toMatchObject({
      commandId: 'cmd-1',
      deviceId: 'dev-1',
      orgId: 'org-1',
      grantId: 'g1',
      operation: 'read',
      requestPath: `${LOGS}\\Agent.log`,
      maxBytes: 65536,
      approvedBy: 'approver-1',
      roots: [{ path: LOGS, recursive: true }],
    });
    const lifetime = Date.parse(auth.expiresAt) - Date.parse(auth.issuedAt);
    expect(lifetime).toBe(DIAGNOSTIC_AUTHORIZATION_LIFETIME_MS);
    expect(DIAGNOSTIC_AUTHORIZATION_LIFETIME_MS).toBe(2 * 60_000);
    const { signature, ...unsigned } = auth;
    expect(verify(null, canonicalDiagnosticAuthorizationBytes(unsigned), signingKey.current!.publicKey, Buffer.from(signature, 'base64'))).toBe(true);
  });

  it('never names a sensitive class, even for a grant row that recorded one', async () => {
    loadGrantMock.mockResolvedValue(activeGrant({ sensitiveClasses: ['browser_secrets', 'private_keys'] }));
    const out = await prepareDiagnosticDelivery('read', payload(), ctx);
    expect((out.diagnosticAuthorization as DiagnosticAuthorizationV1).sensitiveClasses).toEqual([]);
  });

  it('refuses to deliver a read of credential material', async () => {
    await expect(
      prepareDiagnosticDelivery('read', { ...payload(), path: `${LOGS}\\server.pem` }, ctx),
    ).rejects.toThrow(/credential_material/);
  });

  it('never outlives the grant', async () => {
    const grantExpiry = new Date(Date.now() + 90_000);
    loadGrantMock.mockResolvedValue(activeGrant({ expiresAt: grantExpiry }));
    const out = await prepareDiagnosticDelivery('read', payload(), ctx);
    expect(Date.parse((out.diagnosticAuthorization as DiagnosticAuthorizationV1).expiresAt)).toBeLessThanOrEqual(grantExpiry.getTime());
  });

  it('refuses a payload that already carries an authorization (forged or model-supplied)', async () => {
    await expect(prepareDiagnosticDelivery('read', { ...payload(), diagnosticAuthorization: { approved: true } }, ctx)).rejects.toBeInstanceOf(
      CommandDeliveryRefusedError,
    );
    await expect(prepareDiagnosticDelivery('read', { ...payload(), diagnosticAuthorization: false }, ctx)).rejects.toBeInstanceOf(
      CommandDeliveryRefusedError,
    );
  });

  it.each([
    ['revoked while queued', activeGrant({ status: 'revoked' }), /grant_revoked/],
    ['expired while queued', activeGrant({ expiresAt: new Date(Date.now() - 1000) }), /grant_expired/],
    ['still pending', activeGrant({ status: 'pending_approval', approvedByUserId: null, expiresAt: null }), /grant_pending/],
    ['issued for another device', activeGrant({ deviceId: 'dev-2' }), /no_grant/],
    ['issued for another org', activeGrant({ orgId: 'org-2' }), /no_grant/],
    ['read not granted', activeGrant({ operations: ['list'] }), /operation_not_granted/],
    ['path outside scope', activeGrant({ scopes: [{ path: 'C:\\ProgramData\\Vendor', recursive: true }] }), /out_of_scope/],
  ])('refuses delivery: %s', async (_l, grant, msg) => {
    loadGrantMock.mockResolvedValue(grant);
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(msg);
  });

  it('refuses a grant that no longer exists or a device that moved', async () => {
    loadGrantMock.mockResolvedValue(null);
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/no longer exists/);
    loadGrantMock.mockResolvedValue(activeGrant());
    deviceRows.current = [{ id: 'dev-1', orgId: 'org-9', osType: 'windows' }];
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/no_grant/);
  });

  it('refuses a command not queued by the grant\'s requesting user', async () => {
    commandRows.current = [{ createdBy: 'someone-else' }];
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/not queued by the grant's requesting user/);
    commandRows.current = [{ createdBy: null }];
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/not queued by the grant's requesting user/);
    commandRows.current = [];
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/not queued by the grant's requesting user/);
  });

  it('refuses incomplete or malformed arguments', async () => {
    await expect(prepareDiagnosticDelivery('read', { ...payload(), resultPublicKey: undefined }, ctx)).rejects.toThrow(/incomplete/);
    await expect(prepareDiagnosticDelivery('read', { ...payload(), offset: -5 }, ctx)).rejects.toThrow(/incomplete/);
    await expect(prepareDiagnosticDelivery('read', { ...payload(), path: `${LOGS}\\..\\..\\x` }, ctx)).rejects.toThrow(/invalid_path/);
  });

  it('records the authorization durably before the agent can read, without content', async () => {
    const out = await prepareDiagnosticDelivery('read', payload(), ctx);
    expect(auditMock).toHaveBeenCalledOnce();
    const entry = auditMock.mock.calls[0]![0];
    expect(entry).toMatchObject({
      action: 'diagnostic_access.file_read_authorized',
      resourceId: 'dev-1',
      details: { grantId: 'g1', approvedBy: 'approver-1', commandId: 'cmd-1', path: `${LOGS}\\Agent.log` },
    });
    expect(entry.details.authorizationId).toBe((out.diagnosticAuthorization as DiagnosticAuthorizationV1).authorizationId);
    expect(JSON.stringify(entry)).not.toMatch(/signature|resultPublicKey/);
  });

  it('refuses delivery when the audit record cannot be written', async () => {
    auditMock.mockRejectedValue(new Error('db down'));
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/audit could not be recorded/);
  });

  it('a revocation that commits while delivery is signing wins', async () => {
    loadGrantMock.mockResolvedValueOnce(activeGrant()).mockResolvedValueOnce(activeGrant({ status: 'revoked' }));
    await expect(prepareDiagnosticDelivery('read', payload(), ctx)).rejects.toThrow(/grant_revoked: grant changed during delivery/);
  });
});
