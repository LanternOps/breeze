import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  values: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => mocks.selectResult()) })) })) })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        mocks.values(v);
        return { onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(() => mocks.insertReturning()) })) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => {
        mocks.set(v);
        return { where: vi.fn(() => ({ returning: vi.fn(() => mocks.updateReturning()) })) };
      }),
    })),
  },
}));

import {
  claimIdempotency,
  findIdempotencyReplay,
  linkIdempotencyResource,
  requestFingerprint,
  validateIdempotencyHeader,
} from './idempotency';

const principal = {
  partnerServicePrincipalId: '66666666-6666-4666-8666-666666666666',
  keyId: '77777777-7777-4777-8777-777777777777',
  partnerId: '33333333-3333-4333-8333-333333333333',
  name: 'PSA Bridge',
  scopes: ['tickets:write' as const],
  accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  rateLimit: 600,
};
const TICKET_A = '44444444-4444-4444-8444-444444444444';
const TICKET_B = '55555555-5555-4555-8555-555555555555';

function ctx(header: string | undefined) {
  return {
    req: { header: (name: string) => (name === 'X-Idempotency-Key' ? header : undefined) },
    json: (body: unknown, status: number) => new Response(JSON.stringify(body), { status }),
  } as any;
}

describe('partner API idempotency helpers', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('validates the header: absent is fine, 1..128 printable ASCII otherwise', () => {
    expect(validateIdempotencyHeader(ctx(undefined), 'bad')).toEqual({ ok: true, key: null });
    expect(validateIdempotencyHeader(ctx('psa-1'), 'bad')).toEqual({ ok: true, key: 'psa-1' });
    for (const bad of ['', 'x'.repeat(129), 'tab\there', 'ünïcode']) {
      const result = validateIdempotencyHeader(ctx(bad), 'bad_code');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    }
  });

  it('fingerprints are key-order independent, and bound to the route AND the ticket', () => {
    const a = requestFingerprint('tickets.create', null, { orgId: 'o', subject: 's', priority: 'high' });
    const b = requestFingerprint('tickets.create', null, { priority: 'high', subject: 's', orgId: 'o' });
    const c = requestFingerprint('tickets.comment', null, { orgId: 'o', subject: 's', priority: 'high' });
    const d = requestFingerprint('tickets.create', null, { orgId: 'o', subject: 'different', priority: 'high' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    // The same comment body against two tickets is two fingerprints: a key
    // reused on another ticket is a mismatch, never a replay of the first.
    const onA = requestFingerprint('tickets.comment', TICKET_A, { content: 'note', isPublic: false });
    const onB = requestFingerprint('tickets.comment', TICKET_B, { content: 'note', isPublic: false });
    expect(onA).not.toBe(onB);
    expect(onA).toBe(requestFingerprint('tickets.comment', TICKET_A, { isPublic: false, content: 'note' }));
    // A zod-coerced Date (dueDate) must not throw and must equal its ISO form.
    const withDate = requestFingerprint('tickets.create', null, { orgId: 'o', subject: 's', dueDate: new Date('2026-10-01T00:00:00.000Z') });
    expect(withDate).toBe(requestFingerprint('tickets.create', null, { orgId: 'o', subject: 's', dueDate: '2026-10-01T00:00:00.000Z' }));
  });

  it('classifies the replay lookup: none / mismatch / replay — a committed claim without a resource is an invariant violation', async () => {
    mocks.selectResult.mockResolvedValueOnce([]);
    expect(await findIdempotencyReplay(principal, 'tickets.create', 'k', 'fp')).toEqual({ kind: 'none' });
    mocks.selectResult.mockResolvedValueOnce([{ id: 'c', requestFingerprint: 'other', resourceId: 'r' }]);
    expect(await findIdempotencyReplay(principal, 'tickets.create', 'k', 'fp')).toEqual({ kind: 'mismatch' });
    mocks.selectResult.mockResolvedValueOnce([{ id: 'c', requestFingerprint: 'fp', resourceId: 'r' }]);
    expect(await findIdempotencyReplay(principal, 'tickets.create', 'k', 'fp')).toEqual({ kind: 'replay', resourceId: 'r' });
    // Claim and link commit together, so this state is unreachable through
    // the routes; it must surface loudly rather than as a second create.
    mocks.selectResult.mockResolvedValueOnce([{ id: 'c', requestFingerprint: 'fp', resourceId: null }]);
    await expect(findIdempotencyReplay(principal, 'tickets.create', 'k', 'fp')).rejects.toThrow(/committed without a resource/);
  });

  it('claims with onConflictDoNothing (null on a lost race), bound to the ticket, and links the resource (+ ticket for a create)', async () => {
    mocks.insertReturning.mockResolvedValueOnce([{ id: 'claim-1' }]);
    const claim = await claimIdempotency({ principal, orgId: principal.accessibleOrgIds[0]!, ticketId: TICKET_A, route: 'tickets.comment', key: 'k', fingerprint: 'fp' });
    expect(claim).toEqual({ id: 'claim-1' });
    expect(mocks.values).toHaveBeenCalledWith({
      partnerId: principal.partnerId,
      partnerServicePrincipalId: principal.partnerServicePrincipalId,
      orgId: principal.accessibleOrgIds[0],
      ticketId: TICKET_A,
      route: 'tickets.comment',
      idempotencyKey: 'k',
      requestFingerprint: 'fp',
    });

    mocks.insertReturning.mockResolvedValueOnce([]);
    expect(await claimIdempotency({ principal, orgId: 'o', ticketId: null, route: 'tickets.create', key: 'k', fingerprint: 'fp' })).toBeNull();
    expect(mocks.values).toHaveBeenLastCalledWith(expect.objectContaining({ ticketId: null, route: 'tickets.create' }));

    mocks.updateReturning.mockResolvedValueOnce([{ id: 'claim-1' }]);
    await expect(linkIdempotencyResource('claim-1', 'r')).resolves.toBeUndefined();
    expect(mocks.set).toHaveBeenLastCalledWith({ resourceId: 'r' });
    mocks.updateReturning.mockResolvedValueOnce([{ id: 'claim-1' }]);
    await expect(linkIdempotencyResource('claim-1', TICKET_A, TICKET_A)).resolves.toBeUndefined();
    expect(mocks.set).toHaveBeenLastCalledWith({ resourceId: TICKET_A, ticketId: TICKET_A });
    mocks.updateReturning.mockResolvedValueOnce([]);
    await expect(linkIdempotencyResource('claim-1', 'r')).rejects.toThrow('idempotency claim link failed');
  });
});
