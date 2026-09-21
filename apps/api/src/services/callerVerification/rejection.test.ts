import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ status: 'expired', calls: [] as string[] }));
const ID = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const row = () => ({ id: ID, orgId: ORG, contactId: CONTACT, status: state.status, requesterBindingId: null, targetBindingId: null });

vi.mock('./effects', () => ({ recordEffect: async () => { state.calls.push('audit-ticket'); } }));
vi.mock('../actionIntents/revokeIntentsForSubject', () => ({
  revokeIntentsForSubject: async () => { state.calls.push('revoke-intents'); return { cancelled: [], alreadyExecuting: ['e'], alreadyDispatched: ['d'] }; },
}));
vi.mock('./policy', () => ({ getEffectivePolicy: async () => ({ coolingOffHours: 24 }) }));
vi.mock('./locks', () => ({
  lockContact: async () => { state.calls.push('lock-contact'); },
  withSubjectLocks: async (_db: unknown, _ids: unknown, fn: () => unknown) => { state.calls.push('lock-subjects'); return fn(); },
}));
vi.mock('../../db', () => ({
  assertInTransaction: vi.fn(),
  db: {
    execute: async () => { state.calls.push('execute'); return []; },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row()], then: (f: (v: unknown) => unknown) => Promise.resolve([]).then(f) }) }) }),
    update: () => ({
      set: (v: { status?: string }) => {
        state.calls.push(v.status === 'rejected_by_user' ? 'fence' : 'revoke-grants');
        if (v.status === 'rejected_by_user') state.status = v.status;
        return { where: () => ({ returning: async () => [row()], then: (f: (v: unknown) => unknown) => Promise.resolve([]).then(f) }) };
      },
    }),
    insert: () => ({ values: () => { state.calls.push('incident'); return { onConflictDoNothing: async () => [] }; } }),
  },
}));

import { handleRejection } from './rejection';

it('fences before incident/revocation and retries without duplicate effects', async () => {
  await handleRejection(ID);
  expect(state.calls.slice(0, 2)).toEqual(['lock-contact', 'lock-subjects']);
  expect(state.calls.slice(2, 8)).toEqual(['fence', 'incident', 'revoke-grants', 'revoke-intents', 'audit-ticket', 'execute']);
  const n = state.calls.length;
  await handleRejection(ID);
  // Only the locks are re-taken; the CAS is the idempotency boundary.
  expect(state.calls.slice(n)).toEqual(['lock-contact', 'lock-subjects']);
});
