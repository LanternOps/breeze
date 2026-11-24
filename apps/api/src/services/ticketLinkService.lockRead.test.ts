/**
 * #8313 W2 review: the ticket read under the link lock never falls back. A
 * locked row the read cannot see used to get createdAt = epoch, which an
 * import link's "not before the ticket's creation" check would always pass.
 */
import { describe, expect, it, vi } from 'vitest';

const { reads } = vi.hoisted(() => ({ reads: { current: [] as unknown[] } }));

vi.mock('../db', () => {
  const node: Record<string, unknown> = {};
  const pass = () => node;
  Object.assign(node, { from: pass, where: () => Promise.resolve(reads.current) });
  const tx = { select: () => node };
  return {
    db: { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) },
    withSystemDbAccessContext: vi.fn(),
    runOutsideDbContext: vi.fn(),
  };
});
vi.mock('./ticketLinkLock', () => ({ lockOrgTicketLinks: vi.fn(async () => undefined) }));
vi.mock('./ticketMerge/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./ticketMerge/errors')>()),
  assertTicketsNotMerged: vi.fn(),
}));
vi.mock('./ticketRowLock', () => ({
  lockTicketsForWrite: vi.fn(async (_tx: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, {
    id, orgId: 'org-1', partnerId: 'partner-1', deletedAt: null,
  }]))),
}));

import { addTicketLink } from './ticketLinkService';

const actor = { type: 'user', userId: 'user-1' } as never;
const input = {
  source: { id: 'a0000000-0000-4000-8000-000000000001', orgId: 'org-1' },
  target: { id: 'b0000000-0000-4000-8000-000000000002', orgId: 'org-1' },
  linkType: 'related',
} as never;

describe('addTicketLink: the read under the ticket lock', () => {
  it('refuses when a locked ticket cannot be read, instead of assuming an epoch createdAt', async () => {
    reads.current = [{ id: 'a0000000-0000-4000-8000-000000000001', internalNumber: 1, ticketNumber: 'T-1', createdAt: new Date() }];
    await expect(addTicketLink(input, actor)).rejects.toThrow(
      'ticket b0000000-0000-4000-8000-000000000002 is locked but its read under the lock returned nothing',
    );
  });
});
