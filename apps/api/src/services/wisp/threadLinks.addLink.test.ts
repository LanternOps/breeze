import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispThreadLinkRow } from '../../db/schema/wispThreadLinks';
import type { EntityResolveContext } from './entityRefs';

const h = vi.hoisted(() => ({
  select: vi.fn(), update: vi.fn(), insert: vi.fn(), transaction: vi.fn(), resolve: vi.fn(),
}));
vi.mock('../../db', () => ({ db: { transaction: h.transaction } }));
vi.mock('./grantAuthority', () => ({ inSystemContext: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('./entityRefs', () => ({
  resolveEntityRef: h.resolve,
  isResolveFailure: (value: object) => 'reason' in value,
}));

import { addLink } from './threadLinks';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const THREAD = uuid(1), PARTNER = uuid(2), TICKET = uuid(3), ORG = uuid(4), USER = uuid(5);
const ctx = { ceiling: { partnerId: PARTNER, grantorUserId: USER } } as EntityResolveContext;
const ref = { kind: 'ticket' as const, id: TICKET };
const resolved = { ref: { ...ref, orgId: ORG }, orgId: ORG, label: 'Fresh ticket', status: 'open', href: '/ticket' };
const row = (source: WispThreadLinkRow['source']): WispThreadLinkRow => ({
  id: uuid(6), threadId: THREAD, partnerId: PARTNER, orgId: ORG,
  entityKind: 'ticket', entityId: TICKET, label: resolved.label,
  source, addedByUserId: USER, addedByGrantId: null, touchCount: 1,
  lastTouchedAt: new Date('2026-10-31T00:00:00Z'), createdAt: new Date('2026-10-30T00:00:00Z'),
});

function selectResult(rows: object[]) {
  const chain = {
    from: () => chain, where: () => chain, for: () => chain,
    limit: () => Promise.resolve(rows),
    then: (onfulfilled: (rows: object[]) => unknown) => Promise.resolve(rows).then(onfulfilled),
  };
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.resolve.mockResolvedValue(resolved);
  h.transaction.mockImplementation((fn: (tx: typeof h) => Promise<unknown>) => fn(h));
  h.select.mockReturnValueOnce(selectResult([{ id: THREAD }])).mockReturnValue(selectResult([{ n: 0 }]));
  h.update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [] }) }) });
  h.insert.mockReturnValue({ values: () => ({ returning: async () => [row('auto')] }) });
});

describe('addLink insertion outcome', () => {
  it('reports a newly inserted auto link after resolving with the call authority', async () => {
    const outcome = await addLink(ctx, THREAD, ref, { source: 'auto', reportInsertion: true });
    expect(outcome).toEqual({ link: expect.objectContaining({ id: uuid(6), ref: resolved.ref, source: 'auto' }), inserted: true });
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith(ctx, ref);
    expect(h.insert).toHaveBeenCalledTimes(1);
  });

  it.each(['auto', 'user_pin', 'wisp_pin'] as const)('reports a re-touch of an existing %s without insertion, retaining its real source', async (source) => {
    h.update.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [row(source)] }) }) });
    const outcome = await addLink(ctx, THREAD, ref, { source: 'auto', reportInsertion: true });
    expect(outcome).toEqual({ link: expect.objectContaining({ id: uuid(6), ref: resolved.ref, source }), inserted: false });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('preserves the unwrapped W04 pin-route return shape by default', async () => {
    h.select.mockReset().mockReturnValueOnce(selectResult([{ id: THREAD }])).mockReturnValue(selectResult([]));
    h.insert.mockReturnValue({ values: () => ({ returning: async () => [row('user_pin')] }) });
    const link = await addLink(ctx, THREAD, ref, { source: 'user_pin' });
    expect(link).toEqual({
      id: uuid(6), ref: resolved.ref, label: resolved.label, status: resolved.status,
      href: resolved.href, source: 'user_pin', lastTouchedAt: row('user_pin').lastTouchedAt.toISOString(),
      createdAt: row('user_pin').createdAt.toISOString(),
    });
    expect(link).not.toHaveProperty('inserted');
    expect(link).not.toHaveProperty('link');
  });
});
