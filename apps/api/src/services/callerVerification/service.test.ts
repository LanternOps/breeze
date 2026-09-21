import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ref = vi.hoisted(() => ({ db: null as any, policy: vi.fn(), bindings: vi.fn() }));
vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_, key) => ref.db[key] }),
  assertInTransaction: vi.fn(),
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  getCurrentDbAccessContext: () => ({ scope: 'organization' }),
}));
vi.mock('./effects', () => ({ recordEffect: vi.fn() }));
vi.mock('./gate', () => ({ fencedUntil: async () => null }));
vi.mock('./policy', async (original) => ({ ...await original<typeof import('./policy')>(), getEffectivePolicy: ref.policy }));
vi.mock('./subjects', () => ({ bindingsForContact: ref.bindings }));
vi.mock('./destinations', async (original) => ({ ...await original<typeof import('./destinations')>(), currentDestination: async () => null }));

import { makeDbMock } from './testing';
import { resolveEffectivePolicy } from './policy';
import { start, view, challengeSecrets, verificationDetails, decisionStatus } from './service';
import type { VerificationRow, CallerVerificationActor } from './types';

const org = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const actor: CallerVerificationActor = { userId: user, partnerId: null, scope: 'organization', accessibleOrgIds: [org], allowedSiteIds: null, displayName: 'Technician' };
let state: ReturnType<typeof makeDbMock>;

beforeEach(() => {
  state = makeDbMock();
  ref.db = state.db;
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  ref.policy.mockResolvedValue(resolveEffectivePolicy(null, null));
  ref.bindings.mockImplementation(async (_org: string, contactId: string) => [{ id: contactId, contactId, orgId: org, entraOid: contactId, entraTenantId: 'tenant', revokedAt: null }]);
});
afterEach(() => vi.unstubAllEnvs());

it('generates three distinct two-digit choices and four-digit reverse code', () => {
  for (let i = 0; i < 100; i++) {
    const s = challengeSecrets();
    expect(new Set([s.matchValue, ...s.decoyValues]).size).toBe(3);
    expect(s.decoyValues).toHaveLength(2);
    expect([s.matchValue, ...s.decoyValues].every((c) => /^\d{2}$/.test(c))).toBe(true);
    expect(s.reverseCode).toMatch(/^\d{4}$/);
  }
});

it('creator-only secrets are an explicit projection', () => {
  const now = new Date();
  const row = { id: user, orgId: org, contactId: user, createdAt: now, expiresAt: now, decidedAt: null, consumedAt: null, initiatedByUserId: user, matchValue: '42', decoyValues: ['11', '73'], reverseCode: '1234', challengeTokenHash: 'private' } as VerificationRow;
  expect(view(row, user, null).secrets?.matchValue).toBe('42');
  expect(view(row, 'other', null)).not.toHaveProperty('secrets');
  expect(view(row, user, null)).not.toHaveProperty('challengeTokenHash');
});

it('flag-off start fails before database work', async () => {
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  await expect(start(actor, { orgId: org, contactId: user, method: 'callback_attestation', actionScope: 'any' })).rejects.toMatchObject({ code: 'feature_disabled' });
  expect(state.calls).toEqual([]);
});

const contact = { id: user, orgId: org, name: 'Requester', siteId: null, roles: ['admin'], email: null, mobile: null };
const input = { orgId: org, contactId: user, method: 'callback_attestation' as const, actionScope: 'any' as const };

it('counts every attempt under the contact lock and stops at the cap', async () => {
  state.results.push([contact], [contact], [contact], [contact], [contact], [{ count: 3 }]);
  await expect(start(actor, input)).rejects.toMatchObject({ code: 'attempt_cap' });
  expect(state.calls.filter((c) => c.name === 'insert')).toEqual([]);
  expect(state.db.execute).toHaveBeenCalled();
});

it('rejects a ticket belonging to another requester', async () => {
  state.results.push([contact], [contact], [contact], [{ id: user, requesterContactId: '33333333-3333-4333-8333-333333333333', deletedAt: null }]);
  await expect(start(actor, { ...input, ticketId: user })).rejects.toMatchObject({ code: 'not_found' });
  expect(state.calls.filter((c) => c.name === 'insert')).toEqual([]);
});

it('requires a ticket when policy says so', async () => {
  ref.policy.mockResolvedValue({ ...resolveEffectivePolicy(null, null), requireTicket: true });
  state.results.push([contact], [contact], [contact]);
  await expect(start(actor, input)).rejects.toMatchObject({ code: 'ticket_required' });
});

it('denies foreign org and sibling-site targets before creating an attempt', async () => {
  await expect(start(actor, { ...input, orgId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'not_found' });
  state.results.push([contact], [{ ...contact, siteId: '44444444-4444-4444-8444-444444444444' }]);
  await expect(start({ ...actor, allowedSiteIds: [] }, input)).rejects.toMatchObject({ code: 'not_found' });
  expect(state.calls.filter((c) => c.name === 'insert')).toEqual([]);
});

it('a site-level manager cannot authorize another account at initiation', async () => {
  const target = '33333333-3333-4333-8333-333333333333';
  state.results.push([{ ...contact, siteId: '44444444-4444-4444-8444-444444444444' }], [{ ...contact, id: target }]);
  await expect(start(actor, { ...input, targetContactId: target, actionScope: 'disable_user' })).rejects.toMatchObject({ code: 'requester_not_authorized' });
});

it('does not advertise or start a workstation without its adapter', async () => {
  state.results.push([contact], [contact], [contact]);
  await expect(start(actor, { ...input, method: 'workstation', deviceId: user, username: 'caller' })).rejects.toMatchObject({ code: 'helper_outdated' });
  expect(state.calls.filter((c) => c.name === 'insert')).toEqual([]);
});

it('creates a callback row and returns its initiator secrets', async () => {
  const now = new Date();
  const row = { id: user, ...input, initiatedByUserId: user, createdAt: now, expiresAt: now, decidedAt: null, consumedAt: null, matchValue: '42', decoyValues: ['11', '73'], reverseCode: '1234' };
  state.results.push([contact], [contact], [contact], [contact], [contact], [{ count: 0 }], [row], [{ count: 1 }], []);
  const result = await start(actor, input);
  expect(result.secrets).toEqual({ matchValue: '42', decoyValues: ['11', '73'], reverseCode: '1234' });
  expect(result.remainingAttempts).toBe(2);
  expect(state.calls.filter((c) => c.name === 'insert')).toHaveLength(1);
  const inserted = state.calls.find((c) => c.name === 'values')!.args[0] as Record<string, unknown>;
  expect(inserted).toMatchObject({ orgId: org, contactId: user, method: 'callback_attestation', status: 'pending', attemptNo: 1, tier: 1, tierReason: 'attestation' });
  expect(inserted.challengeTokenHash).toBeNull();
});

it('projects required fields without secrets or guessing consumed any-scope action', () => {
  const at = new Date('2026-09-19T12:00:00Z');
  const p = resolveEffectivePolicy(null, null);
  const row = { id: user, orgId: org, contactId: user, initiatedByUserId: user, method: 'callback_attestation', status: 'verified', createdAt: at, expiresAt: at, decidedAt: at, consumedAt: at, actionScope: 'any', reason: null } as VerificationRow;
  const result = verificationDetails(row, 'another-user', null, p, 4, 'incident', 'm365_disable_user');
  expect(result).toMatchObject({ remainingAttempts: 0, usableUntil: '2026-09-19T12:30:00.000Z', incidentId: 'incident', consumedAction: 'disable_user', undeliverableReason: null });
  expect(result).not.toHaveProperty('secrets');
  expect(verificationDetails(row, null, null, p, 0, null, null).consumedAction).toBeNull();
  expect(verificationDetails({ ...row, method: 'administrative_stepup', stepupVerifiedAt: new Date('2026-09-19T11:59:00Z') }, null, null, p, 0, null, null).usableUntil).toBe('2026-09-19T12:29:00.000Z');
});

it.each(['no_session_for_user', 'session_not_console', 'helper_outdated', 'sms_failed', 'email_failed'] as const)('projects persisted delivery reason %s', (reason) => {
  const at = new Date();
  const row = { id: user, orgId: org, contactId: user, createdAt: at, expiresAt: at, decidedAt: at, consumedAt: null, status: 'undeliverable', reason } as VerificationRow;
  expect(verificationDetails(row, null, null, resolveEffectivePolicy(null, null), 1, null, null)).toMatchObject({ remainingAttempts: 2, usableUntil: null, undeliverableReason: reason });
  expect(verificationDetails({ ...row, reason: 'provider said something private' }, null, null, resolveEffectivePolicy(null, null), 1, null, null).undeliverableReason).toBeNull();
});

it.each(['pending', 'verified', 'wrong_choice', 'expired', 'undeliverable', 'cancelled', 'revoked'] as const)('accepts late not_me from %s', (status) => {
  expect(decisionStatus(status, new Date(0), { kind: 'not_me' }, '42')).toBe('rejected_by_user');
});

it('only a live pending number choice verifies; timeout never approves', () => {
  expect(decisionStatus('pending', new Date(Date.now() + 60000), { kind: 'choice', value: '42' }, '42')).toBe('verified');
  expect(decisionStatus('pending', new Date(Date.now() + 60000), { kind: 'choice', value: '11' }, '42')).toBe('wrong_choice');
  expect(decisionStatus('pending', new Date(0), { kind: 'choice', value: '42' }, '42')).toBe('expired');
  expect(decisionStatus('pending', new Date(Date.now() + 60000), { kind: 'undeliverable', reason: 'helper_outdated' }, '42')).toBe('undeliverable');
  expect(decisionStatus('verified', new Date(0), { kind: 'timeout' }, '42')).toBeNull();
  expect(decisionStatus('rejected_by_user', new Date(0), { kind: 'not_me' }, '42')).toBeNull();
});
