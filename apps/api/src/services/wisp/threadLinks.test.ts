import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Concern, WispEntityKind } from '@breeze/shared';
import type { WispThreadLinkRow } from '../../db/schema/wispThreadLinks';
import type { EntityResolveContext } from './entityRefs';

const h = vi.hoisted(() => ({
  rows: [] as WispThreadLinkRow[],
  orderBy: vi.fn(),
  resolve: vi.fn(),
  createResolver: vi.fn(),
  inSystemContext: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where']) chain[m] = () => chain;
  chain.orderBy = (...args: unknown[]) => { h.orderBy(...args); return chain; };
  chain.limit = (n: number) => Promise.resolve(h.rows.slice(0, n));
  return { db: { select: () => chain, insert: h.insert, update: h.update, delete: h.delete } };
});
vi.mock('../../db/partnerAxisRead', () => ({
  readOwnPartnerAxisRows: <T>(_partner: string, fn: () => Promise<T>) => fn(),
}));
vi.mock('./grantAuthority', () => ({ inSystemContext: h.inSystemContext }));
vi.mock('./entityRefs', () => ({
  createEntityResolver: h.createResolver,
  resolveEntityRef: h.resolve,
  isResolveFailure: (r: object) => 'reason' in r,
}));
const { listLinks, listWorkingSet } = await import('./threadLinks');
const ctx = { ceiling: { partnerId: 'partner' } } as EntityResolveContext;
const date = (day: number) => new Date(Date.UTC(2026, 9, day));
function row(id: string, source: WispThreadLinkRow['source'], day: number): WispThreadLinkRow {
  return {
    id: 'link-' + id, threadId: 'thread', partnerId: 'partner', orgId: 'org',
    entityKind: 'ticket', entityId: id, label: id, addedByUserId: 'user',
    addedByGrantId: null, source, touchCount: 1, lastTouchedAt: date(day), createdAt: date(1),
  };
}
function concern(id: string, kind: Concern['subject']['kind'] = 'ticket', status: Concern['status'] = 'open'): Concern {
  return {
    id: 'concern-' + id, partnerId: 'partner', orgId: 'org', subject: { kind, id },
    summary: 'Untrusted summary', severity: 'high', status, evidence: {}, outcome: null,
    signature: null, childConcernIds: [], approvalIntentId: null,
    createdAt: date(1).toISOString(), updatedAt: date(8).toISOString(), resolvedAt: null,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.rows = [];
  h.inSystemContext.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  h.createResolver.mockReturnValue(h.resolve);
  h.resolve.mockImplementation(async (ref: { kind: WispEntityKind; id: string }) => ({
    ref: { ...ref, orgId: 'org' }, orgId: 'org', label: ref.id, status: 'open', href: '/' + ref.id,
  }));
});

describe('listWorkingSet', () => {
  it('considers only the first 50 of 60 distinct open concerns in caller order', async () => {
    const concerns = Array.from({ length: 60 }, (_, i) => concern('subject-' + (60 - i)));
    const links = await listWorkingSet(ctx, 'thread', { concerns });
    expect(links).toHaveLength(50);
    expect(links.every((link) => link.source === 'concern')).toBe(true);
    expect(links.map((link) => link.ref.id)).toEqual(concerns.slice(0, 50).map((c) => c.subject.id));
    expect(h.resolve).toHaveBeenCalledTimes(50);
  });

  it('caps active concerns before mapping or deduplicating their subjects', async () => {
    const concerns = [
      concern('resolved', 'ticket', 'resolved'), concern('dismissed', 'ticket', 'dismissed'),
      concern('unmapped', 'integration'),
      ...Array.from({ length: 49 }, () => concern('duplicate', 'ticket', 'snoozed')),
      concern('beyond-cap'),
    ];
    const links = await listWorkingSet(ctx, 'thread', { concerns });
    expect(links.map((link) => link.ref.id)).toEqual(['duplicate']);
    expect(h.resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'empty', concerns: [] },
    { name: 'resolved only', concerns: [concern('resolved', 'ticket', 'resolved')] },
  ])(
    'skips the concern system context when concerns are $name', async ({ concerns }) => {
      h.rows = [row('auto', 'auto', 9), row('pin', 'user_pin', 5)];
      const links = await listWorkingSet(ctx, 'thread', { concerns });
      expect(links.map((link) => link.ref.id)).toEqual(['pin', 'auto']);
      expect(h.resolve).toHaveBeenCalledTimes(2);
      // Only the existing stored-row read enters system context.
      expect(h.inSystemContext).toHaveBeenCalledTimes(1);
    },
  );

  it('orders pins, then concern subjects, then autos', async () => {
    // Rows arrive in database last_touched_at order, interleaving source classes.
    h.rows = [row('auto-new', 'auto', 9), row('wisp', 'wisp_pin', 7), row('user', 'user_pin', 5), row('auto-old', 'auto', 3)];
    const c = concern('subject');
    const links = await listWorkingSet(ctx, 'thread', { concerns: [c] });
    expect(links.map((l) => l.ref.id)).toEqual(['wisp', 'user', 'subject', 'auto-new', 'auto-old']);
    expect(links[2]).toEqual({
      id: null, ref: { kind: 'ticket', id: 'subject', orgId: 'org' }, label: 'subject',
      status: 'open', href: '/subject', source: 'concern', lastTouchedAt: c.updatedAt, createdAt: c.createdAt,
    });
    expect(h.createResolver).toHaveBeenCalledWith(ctx);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
  });

  it('a concern subject that is also a stored link appears once as the stored link', async () => {
    h.rows = [row('auto', 'auto', 9), row('pin', 'user_pin', 5)];
    const links = await listWorkingSet(ctx, 'thread', { concerns: [concern('auto'), concern('pin'), concern('new'), concern('new')] });
    expect(links.map((l) => [l.ref.id, l.source, l.id])).toEqual([
      ['pin', 'user_pin', 'link-pin'], ['new', 'concern', null], ['auto', 'auto', 'link-auto'],
    ]);
    expect(h.resolve).toHaveBeenCalledTimes(3);
  });

  it("a resolved concern's subject leaves the working set", async () => {
    expect(await listWorkingSet(ctx, 'thread', { concerns: [concern('a')] })).toHaveLength(1);
    expect(await listWorkingSet(ctx, 'thread', { concerns: [concern('a', 'ticket', 'resolved')] })).toEqual([]);
    expect(await listWorkingSet(ctx, 'thread', { concerns: [] })).toEqual([]);
  });

  it.each(['integration', 'incident'] as const)('an %s concern adds nothing', async (kind) => {
    expect(await listWorkingSet(ctx, 'thread', { concerns: [concern('a', kind)] })).toEqual([]);
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it.each(['outside_ceiling', 'not_found', 'forbidden', 'outside_token_scope'])('a concern subject refused with %s is omitted', async (reason) => {
    h.resolve.mockResolvedValueOnce({ reason });
    expect(await listWorkingSet(ctx, 'thread', { concerns: [concern('a')] })).toEqual([]);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.delete).not.toHaveBeenCalled();
  });

  it('maps org to organization, includes snoozed and skips dismissed concerns', async () => {
    const links = await listWorkingSet(ctx, 'thread', { concerns: [
      concern('org', 'org', 'snoozed'), concern('dismissed', 'ticket', 'dismissed'),
      concern('org', 'ticket'),
    ] });
    expect(links.map((l) => l.ref.kind)).toEqual(['organization', 'ticket']);
  });

  it('retains all 50 pins and 20 autos with optional concerns omitted', async () => {
    h.rows = [
      ...Array.from({ length: 20 }, (_, i) => row('auto-' + i, 'auto', 9)),
      ...Array.from({ length: 50 }, (_, i) => row('pin-' + i, 'user_pin', 5)),
    ];
    const links = await listWorkingSet(ctx, 'thread');
    expect(links).toHaveLength(70);
    expect(links.slice(0, 50).every((l) => l.source === 'user_pin')).toBe(true);
  });
});

describe('listLinks', () => {
  it.each(['forbidden', 'outside_ceiling', 'outside_token_scope'])(
    'logs omitted %s rows at most once per minute without changing them', async (reason) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
      h.rows = [row('refused-' + reason, 'auto', 9)];
      h.resolve.mockResolvedValue({ reason });
      try {
        expect(await listLinks(ctx, 'thread')).toEqual([]);
        expect(await listLinks(ctx, 'thread')).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('[wisp.threadLinks] stored link omitted', {
          partnerId: 'partner', threadId: 'thread', linkId: 'link-refused-' + reason,
          kind: 'ticket', entityId: 'refused-' + reason, reason,
        });
        now.mockReturnValue(1_900_000_060_000);
        await listLinks(ctx, 'thread');
        expect(warn).toHaveBeenCalledTimes(2);
        expect(h.delete).not.toHaveBeenCalled();
        expect(h.update).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        now.mockRestore();
      }
    },
  );

  it('reads stored rows only, ordered by last_touched_at descending', async () => {
    h.rows = [row('stored', 'auto', 9)];
    expect((await listLinks(ctx, 'thread')).map((l) => l.id)).toEqual(['link-stored']);
    const order = h.orderBy.mock.calls[0]!;
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(order[0]).sql).toBe('"wisp_thread_links"."last_touched_at" desc');
  });
});
