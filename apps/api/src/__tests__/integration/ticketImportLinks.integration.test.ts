/**
 * Links in import mode (#8313 W2; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.3 item 4, §6.6) against real Postgres and Redis, as `breeze_app`.
 *
 * Proves:
 *   - an imported link carries the window id and the historic time, its two
 *     feed rows too, and it queues no event and writes no audit row or
 *     outbox row; it charges the window one unit;
 *   - a second pass answers `already` (ALREADY_LINKED, and a duplicate_of
 *     already pointing at this target);
 *   - each known-impossible refusal is `not_written` with its code and is
 *     final; a ticket not imported yet is worth another try;
 *   - a chain formed between passes reports `duplicate_elsewhere`;
 *   - the window's orgs bound the link (an org outside it, a cross-org pair);
 *   - a time before either ticket's creation is refused;
 *   - a live link is unchanged: no window id, its event and audit row.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, or } from 'drizzle-orm';

const queued = vi.hoisted(() => [] as Array<{ type: string; ticketId: string }>);
const audited = vi.hoisted(() => [] as Array<{ action: string; resourceId?: string | null }>);

vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async (input: { type: string; ticketId: string }) => { queued.push({ type: input.type, ticketId: input.ticketId }); };
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});
vi.mock('../../services/auditService', async (orig) => {
  const actual = await orig<typeof import('../../services/auditService')>();
  return {
    ...actual,
    createAuditLogAsync: async (params: Parameters<typeof actual.createAuditLogAsync>[0]) => {
      audited.push({ action: params.action, resourceId: params.resourceId });
      return actual.createAuditLogAsync(params);
    },
  };
});

import { withDbAccessContext } from '../../db';
import { ticketComments, ticketLinks, ticketOutbox } from '../../db/schema';
import { getRedis } from '../../services/redis';
import { importTicketLink } from '../../services/ticketImport/importLinks';
import { importTicket } from '../../services/ticketImport/importWriter';
import type { ImportedTicket } from '../../services/ticketImport/importedTicket';
import { migrationWindowRateKey } from '../../services/ticketImport/throughput';
import { addTicketLink } from '../../services/ticketLinkService';
import { closeWindow, minutes, openWindow, seedImport, T0, uniq, type ImportFx } from './ticketImportFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 60_000;

function ticket(fx: ImportFx, key: string, overrides: Partial<ImportedTicket> = {}): ImportedTicket {
  return {
    sourceId: key,
    sourceNumber: key,
    orgId: fx.orgA.id,
    createdAt: T0,
    updatedAt: minutes(60),
    subject: `Ticket ${key}`,
    description: 'Imported.',
    priority: 'normal',
    tags: [],
    source: 'email',
    requester: { name: 'Maya Customer', email: 'maya@customer.example' },
    assigneeUserId: null,
    finalStatus: 'closed',
    resolvedAt: minutes(50),
    closedAt: minutes(55),
    comments: [],
    ...overrides,
  };
}

/** Imports one ticket per key into `windowId`; the keys are made unique per case. */
async function importAll(fx: ImportFx, windowId: string, keys: string[], overrides: Record<string, Partial<ImportedTicket>> = {}) {
  const ids: Record<string, string> = {};
  for (const key of keys) {
    const result = await importTicket(windowId, ticket(fx, key, overrides[key]), { partnerId: fx.partner.id });
    ids[key] = result.ticketId;
  }
  return ids;
}

const link = (sourceKey: string, targetKey: string, at = minutes(70), linkType: 'duplicate_of' | 'related' = 'duplicate_of') =>
  ({ sourceKey, targetKey, linkType, at });

async function linksBetween(a: string, b: string) {
  return getTestDb().select().from(ticketLinks).where(or(
    and(eq(ticketLinks.sourceTicketId, a), eq(ticketLinks.targetTicketId, b)),
    and(eq(ticketLinks.sourceTicketId, b), eq(ticketLinks.targetTicketId, a)),
  ));
}

async function linkFeedRows(ticketIds: string[]) {
  return getTestDb().select().from(ticketComments).where(and(
    inArray(ticketComments.ticketId, ticketIds),
    eq(ticketComments.commentType, 'system'),
  ));
}

async function bucketSize(windowId: string): Promise<number> {
  return Number(await getRedis()!.zcard(migrationWindowRateKey(windowId)));
}

describe('ticket links in import mode (real Postgres, as breeze_app)', () => {
  beforeEach(() => {
    queued.length = 0;
    audited.length = 0;
  });

  runDb('writes the link and its feed rows at the source time with the window id, and no event, audit or outbox row', async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const m = uniq('m'), s = uniq('s');
    const ids = await importAll(fx, window.id, [m, s]);
    queued.length = 0;
    audited.length = 0;
    const before = await bucketSize(window.id);

    expect(await importTicketLink(window.id, link(m, s), { partnerId: fx.partner.id })).toEqual({ outcome: 'written' });

    const [row] = await linksBetween(ids[m]!, ids[s]!);
    expect(row).toMatchObject({ sourceTicketId: ids[m], targetTicketId: ids[s], linkType: 'duplicate_of', migrationWindowId: window.id, createdBy: null });
    expect(row!.createdAt.getTime()).toBe(minutes(70).getTime());
    const feed = (await linkFeedRows([ids[m]!, ids[s]!])).filter((c) => c.content?.startsWith('Linked:'));
    expect(feed).toHaveLength(2);
    for (const c of feed) {
      expect(c).toMatchObject({ migrationWindowId: window.id, originPrincipalId: fx.principal.id, isPublic: false });
      expect(c.createdAt.getTime()).toBe(minutes(70).getTime());
    }
    expect(queued).toEqual([]);
    expect(audited).toEqual([]);
    expect(await getTestDb().select().from(ticketOutbox).where(inArray(ticketOutbox.ticketId, [ids[m]!, ids[s]!]))
      .then((rows) => rows.filter((r) => r.eventType.includes('link')))).toEqual([]);
    expect(await bucketSize(window.id)).toBe(before + 1);

    // A second pass: the same link is done, and nothing is written twice.
    expect(await importTicketLink(window.id, link(m, s), { partnerId: fx.partner.id })).toEqual({ outcome: 'already' });
    expect(await linksBetween(ids[m]!, ids[s]!)).toHaveLength(1);
  }, CASE_TIMEOUT);

  runDb('a ticket not imported yet is worth another try; another org or partner is final', async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const a = uniq('a'), b = uniq('b');
    await importAll(fx, window.id, [a, b], { [b]: { orgId: fx.orgB.id } });

    expect(await importTicketLink(window.id, link(a, uniq('missing')), { partnerId: fx.partner.id }))
      .toEqual({ outcome: 'not_written', code: 'not_imported', retry: true });
    // The survivor lives in another Breeze org: the merged ticket keeps its note (§6.6).
    expect(await importTicketLink(window.id, link(a, b), { partnerId: fx.partner.id }))
      .toEqual({ outcome: 'not_written', code: 'cross_org' });
    // Another partner's window is not found, whatever its state.
    await expect(importTicketLink(window.id, link(a, b), { partnerId: (await seedImport()).partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN' });
  }, CASE_TIMEOUT);

  runDb('a ticket in an org the window does not cover is final, and a closed window throws', async () => {
    const fx = await seedImport();
    const first = await openWindow(fx);
    const a = uniq('a'), b = uniq('b');
    await importAll(fx, first.id, [a, b]);
    await closeWindow(fx, first.id);
    // The next window covers orgB only: orgA's tickets are hidden by its RLS.
    const second = await openWindow(fx, [fx.orgB.id]);
    expect(await importTicketLink(second.id, link(a, b), { partnerId: fx.partner.id }))
      .toEqual({ outcome: 'not_written', code: 'org_outside_window' });
    await closeWindow(fx, second.id);
    await expect(importTicketLink(second.id, link(a, b), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_WINDOW_NOT_OPEN' });
  }, CASE_TIMEOUT);

  runDb('a time before either ticket was created is refused, and final', async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const a = uniq('a'), b = uniq('b');
    const ids = await importAll(fx, window.id, [a, b], { [b]: { createdAt: minutes(30) } });
    expect(await importTicketLink(window.id, link(a, b, minutes(10)), { partnerId: fx.partner.id }))
      .toEqual({ outcome: 'not_written', code: 'import_time_invalid' });
    expect(await linksBetween(ids[a]!, ids[b]!)).toEqual([]);
  }, CASE_TIMEOUT);

  runDb("Breeze's duplicate rules: a chain formed between passes is duplicate_elsewhere, the rest known impossible", async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const m0 = uniq('m0'), m1 = uniq('m1'), s = uniq('s'), x = uniq('x');
    await importAll(fx, window.id, [m0, m1, s, x]);
    const write = (l: ReturnType<typeof link>) => importTicketLink(window.id, l, { partnerId: fx.partner.id });

    // The bulk pass linked m0 duplicate_of m1; the delta finds m1 merged into s.
    expect(await write(link(m0, m1))).toEqual({ outcome: 'written' });
    expect(await write(link(m1, s))).toEqual({ outcome: 'not_written', code: 'source_has_duplicates' });
    expect(await write(link(m0, s))).toEqual({ outcome: 'not_written', code: 'duplicate_elsewhere' });
    // A duplicate of a ticket that is itself a duplicate.
    expect(await write(link(x, m0))).toEqual({ outcome: 'not_written', code: 'duplicate_target_is_duplicate' });
    // A related link is not a duplicate and is written.
    expect(await write(link(x, s, minutes(70), 'related'))).toEqual({ outcome: 'written' });
  }, CASE_TIMEOUT);

  runDb('a live link is unchanged: no window id, now, with its events and audit row', async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const a = uniq('a'), b = uniq('b');
    const ids = await importAll(fx, window.id, [a, b]);
    await closeWindow(fx, window.id);
    queued.length = 0;
    audited.length = 0;
    const startedAt = Date.now();
    await withDbAccessContext(fx.ownerContext(), () => addTicketLink(
      { source: { id: ids[a]!, orgId: fx.orgA.id }, target: { id: ids[b]!, orgId: fx.orgA.id }, linkType: 'related' },
      { kind: 'user', userId: fx.owner.id, name: 'Owner' },
    ));
    const [row] = await linksBetween(ids[a]!, ids[b]!);
    expect(row!.migrationWindowId).toBeNull();
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt - 5_000);
    const feed = (await linkFeedRows([ids[a]!, ids[b]!])).filter((c) => c.content?.startsWith('Linked:'));
    expect(feed.every((c) => c.migrationWindowId === null)).toBe(true);
    expect(queued.filter((q) => q.type === 'ticket.link_added')).toHaveLength(2);
    expect(audited.map((x) => x.action)).toContain('ticket.link_add');
  }, CASE_TIMEOUT);
});
