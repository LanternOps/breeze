import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  resolveRestoreIntegrity: vi.fn(),
  userCanStepUp: vi.fn(),
  phrase: vi.fn(),
  getUserEpochs: vi.fn(),
  mintStepUpGrant: vi.fn(),
  audit: vi.fn(),
  enable2fa: { value: true },
}));

vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withDbAccessContext: async (_c: unknown, fn: () => unknown) => fn() }));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('./resilienceAuthorization', () => ({ authorizeRouteResilienceResources: mocks.authorize }));
vi.mock('../../services/backupRestoreIntegrity', () => ({ resolveRestoreIntegrity: mocks.resolveRestoreIntegrity }));
vi.mock('./restoreIntegrityGate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./restoreIntegrityGate')>()),
  userCanStepUp: mocks.userCanStepUp,
  restoreConfirmationPhrase: mocks.phrase,
}));
vi.mock('../../services/authEpochs', () => ({ getUserEpochs: mocks.getUserEpochs }));
vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/mfaStepUpGrant')>()),
  mintStepUpGrant: mocks.mintStepUpGrant,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../auth/schemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/schemas')>()),
  get ENABLE_2FA() {
    return mocks.enable2fa.value;
  },
}));
vi.mock('../auth/helpers', () => ({ userIsMfaProtected: vi.fn() }));

import { restoreConfirmationRoutes } from './restoreConfirmations';
import { unattestedRestoreResourceDigest } from '../../services/mfaStepUpGrant';

const ORG = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const GRANT = '66666666-6666-4666-8666-666666666666';

const legacy = { mode: 'unattested', snapshotId: 'snap', reason: 'unattested_legacy' };

function app(auth: Record<string, unknown> = {}) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: USER, email: 'tech@example.com' },
      scope: 'organization',
      orgId: ORG,
      partnerId: null,
      accessibleOrgIds: [ORG],
      canAccessOrg: (id: string) => id === ORG,
      token: { sid: 'sid-1' },
      ...auth,
    } as any);
    await next();
  });
  a.route('/backup', restoreConfirmationRoutes);
  return a;
}

const post = (body: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) =>
  app(auth).request('/backup/restore-confirmations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      snapshotId: SNAPSHOT,
      targetDeviceId: DEVICE,
      commandType: 'backup_restore',
      confirmationText: 'Front Desk PC',
      ...body,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enable2fa.value = true;
  mocks.authorize.mockResolvedValue({ ok: true });
  mocks.resolveRestoreIntegrity.mockResolvedValue(legacy);
  mocks.userCanStepUp.mockResolvedValue(false);
  mocks.phrase.mockResolvedValue('Front Desk PC');
  mocks.getUserEpochs.mockResolvedValue({ authEpoch: 3, mfaEpoch: 5 });
  mocks.mintStepUpGrant.mockResolvedValue(GRANT);
});

describe('POST /backup/restore-confirmations', () => {
  it('mints a single-use typed-confirmation grant bound to the exact restore, and audits it', async () => {
    const res = await post({ confirmationText: '  front desk pc ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ stepUpGrant: GRANT });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), ORG, [
      { kind: 'snapshot', id: SNAPSHOT, role: 'source' },
      { kind: 'device', id: DEVICE, role: 'target' },
    ], 'restore');
    expect(mocks.phrase).toHaveBeenCalledWith(ORG, DEVICE);
    expect(mocks.mintStepUpGrant).toHaveBeenCalledWith({
      userId: USER,
      operation: 'backup_unattested_restore_typed',
      authEpoch: 3,
      mfaEpoch: 5,
      sid: 'sid-1',
      resourceDigest: unattestedRestoreResourceDigest({ snapshotDbId: SNAPSHOT, targetDeviceId: DEVICE, commandType: 'backup_restore' }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG,
      action: 'backup.restore.typed_confirmation',
      resourceType: 'backup_snapshot',
      resourceId: SNAPSHOT,
      result: 'success',
    }));
  });

  it('refuses a phrase that does not match the device name, minting nothing', async () => {
    const res = await post({ confirmationText: 'Other PC' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'confirmation_mismatch' });
    expect(mocks.mintStepUpGrant).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure' }));
  });

  it('a user with a second factor must use the two-factor step-up', async () => {
    mocks.userCanStepUp.mockResolvedValue(true);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'typed_confirmation_not_applicable' });
    expect(mocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['a snapshot that has no attestation for another reason', { mode: 'unattested', snapshotId: 'snap', reason: 'unattested' }, DEVICE],
    ['a device-local snapshot restored onto another device', { mode: 'attested', trust: 'producer_only', snapshotId: 'snap', sourceDeviceId: DEVICE, objects: [] }, OTHER],
    ['an attested snapshot', { mode: 'attested', trust: 'server_verified', snapshotId: 'snap', sourceDeviceId: DEVICE, objects: [] }, DEVICE],
  ])('%s: not applicable', async (_name, integrity, target) => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(integrity);
    const res = await post({ targetDeviceId: target });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'typed_confirmation_not_applicable' });
    expect(mocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it.each([
    ['failed its check', { mode: 'unattested', snapshotId: 'snap', reason: 'attestation_failed' }, 'snapshot_integrity_failed'],
    ['still being checked', { mode: 'unattested', snapshotId: 'snap', reason: 'pending' }, 'attestation_pending'],
    ['cannot be resolved', null, 'snapshot_unresolved'],
  ])('a snapshot that %s is refused, no override', async (_name, integrity, code) => {
    mocks.resolveRestoreIntegrity.mockResolvedValue(integrity);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
    expect(mocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('a caller without an interactive session cannot confirm', async () => {
    const res = await post({}, { token: {} });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'snapshot_integrity_unavailable' });
    expect(mocks.resolveRestoreIntegrity).not.toHaveBeenCalled();
  });

  it('is not used while two-factor authentication is disabled on the deployment', async () => {
    mocks.enable2fa.value = false;
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'typed_confirmation_not_applicable' });
  });

  it('passes an authorization refusal through', async () => {
    mocks.authorize.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 404 }) });
    const res = await post();
    expect(res.status).toBe(404);
    expect(mocks.mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('fails closed when the grant cannot be stored', async () => {
    mocks.mintStepUpGrant.mockResolvedValue(null);
    expect((await post()).status).toBe(503);
  });

  it('rejects a read-only command type', async () => {
    expect((await post({ commandType: 'backup_verify' })).status).toBe(400);
  });
});
