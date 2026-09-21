import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ policy: vi.fn(), resolve: vi.fn(), destination: vi.fn(), mailboxes: vi.fn(), eligible: vi.fn(), results: [] as unknown[][] }));
vi.mock('./policy', () => ({ getEffectivePolicy: m.policy }));
vi.mock('./subjects', () => ({ resolveTargetBinding: m.resolve }));
vi.mock('./locks', () => ({ withSubjectLocks: (_db: unknown, _ids: unknown, f: () => unknown) => f() }));
vi.mock('./ports', () => ({ callerVerificationPorts: { mailboxes: m.mailboxes, administrativeEligible: m.eligible } }));
vi.mock('./destinations', async (original) => ({
  ...await original<typeof import('./destinations')>(),
  currentDestination: m.destination,
  isEstablished: () => true,
}));
vi.mock('../../db', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  for (const name of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning']) chain[name] = () => chain;
  chain.then = (f: (v: unknown) => unknown) => Promise.resolve(m.results.shift() ?? []).then(f);
  return { runOutsideDbContext: (f: () => unknown) => f(), withSystemDbAccessContext: (f: () => unknown) => f(), db: chain };
});

import { requireCallerVerification } from './gate';
import { destinationHash } from './destinations';

const input = {
  orgId: '11111111-1111-4111-8111-111111111111', action: 'reset_password' as const,
  target: { entraTenantId: 'tenant', entraOid: 'oid' }, backendTenantId: 'wrong',
  technicianUserId: '22222222-2222-4222-8222-222222222222', intentId: '33333333-3333-4333-8333-333333333333', mode: 'consume' as const,
};

afterEach(() => vi.unstubAllEnvs());

it('checks flag, then tier zero, then backend tenant, before resolving subject', async () => {
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  await expect(requireCallerVerification(input)).rejects.toMatchObject({ payload: { reason: 'feature_disabled' } });
  expect(m.policy).not.toHaveBeenCalled();
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  m.policy.mockResolvedValue({ requiredTierResetPassword: 0 });
  expect(await requireCallerVerification(input)).toEqual({ verificationId: '', tier: 0 });
  expect(m.resolve).not.toHaveBeenCalled();
  m.policy.mockResolvedValue({ requiredTierResetPassword: 2 });
  await expect(requireCallerVerification(input)).rejects.toMatchObject({ payload: { reason: 'tenant_mismatch', requiredTier: 2 } });
  expect(m.resolve).not.toHaveBeenCalled();
});

const policy = {
  requiredTierResetPassword: 1, requiredTierDisableUser: 1, verificationTtlMinutes: 30, coolingOffHours: 24,
  allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'], allowCrossTechnicianUse: false,
  allowAdministrativeDisable: true, disableUserAuthorizerRoles: ['admin'], destinationMinAgeDays: 7, requireAttestedDestination: false,
};
const binding = {
  id: '44444444-4444-4444-8444-444444444444', orgId: input.orgId, contactId: '55555555-5555-4555-8555-555555555555',
  entraTenantId: 'tenant', entraOid: 'oid', osPrincipal: 'sid', revokedAt: null,
};
function candidate(patch: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666', orgId: input.orgId, contactId: binding.contactId,
    requesterBindingId: binding.id, targetBindingId: binding.id, targetEntraTenantId: 'tenant', targetEntraOid: 'oid',
    status: 'verified', method: 'callback_attestation', actionScope: 'reset_password', initiatedByUserId: input.technicianUserId,
    decidedAt: new Date(), consumedAt: null, consumedIntentRef: null, destinationId: 'destination',
    workstationDeviceRef: '77777777-7777-4777-8777-777777777777', ...patch,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.results.length = 0;
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  m.policy.mockResolvedValue({ ...policy });
  m.resolve.mockResolvedValue(binding);
  m.eligible.mockResolvedValue(true);
  m.mailboxes.mockResolvedValue(['other@example.com']);
  m.destination.mockResolvedValue({ id: 'destination', valueHash: destinationHash('caller@example.com') });
});
// Query order: [candidates], fence(target), fence(row contact) | consume: fence, [row], fence, [requester], [contact], (device), [consumed]
function seed(row: ReturnType<typeof candidate>, devicePresent = true) {
  m.results.push([row], [], ...(row.status === 'verified' ? [[]] : []), [], [row], [], [binding], [{ id: binding.contactId, siteId: null, roles: ['admin'] }],
    ...(row.method === 'workstation' ? [devicePresent ? [{ id: row.workstationDeviceRef }] : []] : []), [{ id: row.id }]);
}
const ok = { ...input, backendTenantId: 'tenant' };

it.each([
  [{ consumedAt: new Date(), consumedIntentRef: 'other' }, 'grant_consumed'],
  [{ targetEntraOid: 'substituted' }, 'target_rebound'],
  [{ initiatedByUserId: 'other' }, 'technician_mismatch'],
  [{ decidedAt: new Date(0) }, 'no_fresh_verification'],
  [{ status: 'revoked' }, 'target_rebound'],
  [{ actionScope: 'disable_user' }, 'no_fresh_verification'],
] as const)('refuses changed candidate %j without consuming', async (patch, reason) => {
  seed(candidate(patch));
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason, contactId: binding.contactId } });
});

it('does not elevate unbound workstation even if its stored tier was 3', async () => {
  m.policy.mockResolvedValue({ ...policy, requiredTierResetPassword: 2 });
  seed(candidate({ method: 'workstation', tier: 3, osPrincipalObserved: null }));
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'no_fresh_verification' } });
});

it('refuses a moved workstation even for same-intent consumed retry', async () => {
  seed(candidate({ method: 'workstation', consumedAt: new Date(), consumedIntentRef: input.intentId }), false);
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
});

it('email mailbox uncertainty refuses while callback needs no mailbox read', async () => {
  m.mailboxes.mockRejectedValue(new Error('offline'));
  seed(candidate({ method: 'email' }));
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'subject_mailboxes_unknown' } });
  m.results.length = 0;
  m.mailboxes.mockClear();
  const row = candidate();
  seed(row);
  expect(await requireCallerVerification(ok)).toEqual({ verificationId: row.id, tier: 1 });
  expect(m.mailboxes).not.toHaveBeenCalled();
});

it('same mailbox aliases and removed methods cannot supply assurance', async () => {
  m.mailboxes.mockResolvedValue(['SMTP:Caller@example.com']);
  seed(candidate({ method: 'email' }));
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'no_fresh_verification' } });
  m.results.length = 0;
  m.policy.mockResolvedValue({ ...policy, allowedMethods: [] });
  seed(candidate());
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'no_fresh_verification' } });
});

it('invalidated administrative proof refuses before any consume', async () => {
  const row = candidate({ method: 'administrative_stepup', actionScope: 'disable_user', requesterBindingId: null, stepupVerifiedAt: new Date() });
  seed(row);
  m.eligible.mockResolvedValue(false);
  await expect(requireCallerVerification({ ...ok, action: 'disable_user' })).rejects.toMatchObject({ payload: { reason: 'stepup_invalidated' } });
});

it('reports a fenced target even when no grant exists', async () => {
  m.results.push([], [{ status: 'rejected_by_user', decidedAt: new Date(), fenceOverrideUntil: null }]);
  await expect(requireCallerVerification(ok)).rejects.toMatchObject({ payload: { reason: 'contact_fenced' } });
});
