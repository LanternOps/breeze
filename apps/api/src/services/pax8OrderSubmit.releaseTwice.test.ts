import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ select: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: mocks.select, update: mocks.update },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
}));

import { createPax8OrderSubmitService } from './pax8OrderSubmit';
import { pax8OrderSubmitRepository } from './pax8OrderSubmitRepository';

describe('Pax8 repeated release with the real claim repository', () => {
  it('refuses a completed order before constructing a client or attempting another write', async () => {
    const completed = { id: 'order-1', partnerId: 'partner-1', orgId: 'org-1', status: 'completed' };
    const chain = {
      from: vi.fn(() => chain), where: vi.fn(() => chain), limit: vi.fn(async () => [completed]),
    };
    mocks.select.mockReturnValue(chain);
    const createClient = vi.fn();
    const service = createPax8OrderSubmitService({
      repository: { ...pax8OrderSubmitRepository, createClient },
      runOutsideDbContext: fn => fn(),
    });

    await expect(service.submitOrder({
      partnerId: completed.partnerId, orderId: completed.id, actorUserId: 'actor-1', mode: { kind: 'rest' },
    })).rejects.toMatchObject({ status: 409, phase: 'claim' });

    expect(mocks.select).toHaveBeenCalledTimes(2); // scoped discovery, then authoritative claim read
    expect(createClient).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
