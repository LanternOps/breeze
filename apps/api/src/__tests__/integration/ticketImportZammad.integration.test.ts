/**
 * The Zammad 7.2.x module end to end (#8313 W5; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §6, §6.8, §8 W5 row): a fake Zammad HTTP server on 127.0.0.1 serving the
 * synthesized fixtures (modules/zammad/__fixtures__, shapes from 7.2.2), the
 * real built-in module, and W4's worker with the real lease (Redis), ledger,
 * writer and window (Postgres, as breeze_app). S3 is faked at its lowest
 * boundary, as in the W4 suites.
 *
 * The source client is the real one, building every URL under the source's
 * https base; only its transport goes to the loopback server
 * (`SourceClientOptions.fetchImpl`, the seam W4's tests use), since
 * loopback stays SSRF-blocked in every mode.
 *
 * Proves: a dry run converts and predicts and writes nothing; an import of
 * the fixture set (statuses, people, categories, tags, notes, inline images
 * and files with their original bytes, skipped files, counters); then a delta
 * pass after the fixture changes loads only the changed tickets and applies a
 * new article and a status change, reports a deleted and a hidden ticket and
 * an edited and a made-internal article, closes a ticket merged between the
 * passes with its note and reports none of its moved articles as deleted.
 */
import './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';

const s3 = vi.hoisted(() => ({ configured: true, objects: new Map<string, Buffer>() }));

vi.mock('../../services/s3Storage', async (orig) => ({
  ...(await orig<typeof import('../../services/s3Storage')>()),
  isS3Configured: () => s3.configured,
  putObjectBuffer: async (key: string, body: Buffer) => { s3.objects.set(key, Buffer.from(body)); },
  deleteObjects: async (keys: readonly string[]) => { for (const key of keys) s3.objects.delete(key); },
}));
vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async () => undefined;
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});

import {
  contacts,
  migrationWindows,
  ticketAttachments,
  ticketCategories,
  ticketComments,
  ticketExternalRefs,
  ticketImportItems,
  ticketImportRunIssues,
  tickets,
} from '../../db/schema';
import { createSourceClient } from '../../services/ticketImport/sourceFetch';
import { normalizeCounters } from '../../services/ticketImport/runReport';
import { clearZammadDirectoryCache } from '../../services/ticketImport/modules/zammad/directory';
import {
  FAKE_ZAMMAD_BASE_URL,
  FAKE_ZAMMAD_TOKEN,
  FakeZammad,
  loadZammadFixtures,
  loopbackFetch,
} from '../../services/ticketImport/modules/zammad/fakeZammad.fixtures';
import { createUser } from './db-utils';
import { drive, ledger, openWindow, runRow, seedImportBase, setMappings, startImportRun, type ImportBase } from './ticketImportFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 240_000;
const ZAMMAD_OPTIONS = { priorityMap: { '4': 'urgent' } };

let fake: FakeZammad;
let server: { origin: string; close: () => Promise<void> };

beforeAll(async () => {
  fake = new FakeZammad(loadZammadFixtures('base'));
  server = await fake.listen();
});
afterAll(async () => { await server.close(); });
beforeEach(() => {
  s3.configured = true;
  s3.objects.clear();
  fake.use('base');
  fake.requests.length = 0;
  clearZammadDirectoryCache();
});

/** The worker's source client, its transport sent to the loopback server. */
const deps = {
  sliceDeps: {
    httpFor: (baseUrl: string) => createSourceClient(baseUrl, {
      timeoutMs: 10_000,
      concurrency: 2,
      fetchImpl: loopbackFetch(server.origin) as never,
      sleep: async () => undefined,
    }),
  },
};

type Fx = ImportBase & { categoryId: string; alice: { id: string }; bob: { id: string }; dana: string };

async function seedZammad(): Promise<Fx> {
  const fx = await seedImportBase({
    module: 'zammad',
    label: 'Zammad',
    baseUrl: FAKE_ZAMMAD_BASE_URL,
    credentials: { token: FAKE_ZAMMAD_TOKEN },
    options: ZAMMAD_OPTIONS,
  });
  const db = getTestDb();
  const [category] = await db.insert(ticketCategories).values({ partnerId: fx.partner.id, name: 'Support' }).returning();
  // Owners: Alice active; Bob deactivated in Zammad and disabled here (still eligible, F16); Carol has no user.
  const alice = await createUser({ partnerId: fx.partner.id, orgId: null, email: 'alice.agent@msp.example.test', name: 'Alice Agent' });
  const bob = await createUser({ partnerId: fx.partner.id, orgId: null, email: 'bob.former@msp.example.test', name: 'Bob Former', status: 'disabled' });
  // Requesters: Dana is one contact of Acme; Frank's address two Globex contacts share.
  const [dana] = await db.insert(contacts).values({ orgId: fx.orgA.id, name: 'Dana Customer', email: 'dana@acme.example.test' }).returning();
  await db.insert(contacts).values([
    { orgId: fx.orgB.id, name: 'Frank Shared', email: 'frank@globex.example.test' },
    { orgId: fx.orgB.id, name: 'Globex front desk', email: 'frank@globex.example.test' },
  ]);
  // Zammad org 2 (Acme) and 3 (Globex); org 1 and tickets with no org have no mapping yet.
  await setMappings(fx, {
    orgs: [
      { sourceOrgKey: '2', sourceOrgName: 'Acme Ltd', orgId: fx.orgA.id },
      { sourceOrgKey: '3', sourceOrgName: 'Globex Inc', orgId: fx.orgB.id },
    ],
    categories: [{ sourceGroupKey: '2', sourceGroupName: 'Support', categoryId: category!.id }],
  }, ZAMMAD_OPTIONS);
  return { ...fx, categoryId: category!.id, alice, bob, dana: dana!.id };
}

async function importedTickets(fx: Fx) {
  const rows = await getTestDb()
    .select({
      key: ticketExternalRefs.externalId,
      id: tickets.id,
      orgId: tickets.orgId,
      status: tickets.status,
      priority: tickets.priority,
      assignedTo: tickets.assignedTo,
      requesterContactId: tickets.requesterContactId,
      submitterEmail: tickets.submitterEmail,
      submitterName: tickets.submitterName,
      categoryId: tickets.categoryId,
      tags: tickets.tags,
      description: tickets.description,
      closedAt: tickets.closedAt,
      deletedAt: tickets.deletedAt,
    })
    .from(tickets)
    .innerJoin(ticketExternalRefs, eq(ticketExternalRefs.ticketId, tickets.id))
    .where(eq(ticketExternalRefs.partnerServicePrincipalId, fx.principal.id));
  return new Map(rows.map((r) => [r.key, r]));
}

async function commentsOf(ticketId: string) {
  return getTestDb()
    .select({ id: ticketComments.id, sourceId: ticketComments.importSourceId, content: ticketComments.content, isPublic: ticketComments.isPublic, authorName: ticketComments.authorName })
    .from(ticketComments)
    .where(and(eq(ticketComments.ticketId, ticketId), isNotNull(ticketComments.importSourceId)));
}

async function issuesOf(runId: string) {
  const rows = await getTestDb().select().from(ticketImportRunIssues).where(eq(ticketImportRunIssues.runId, runId));
  return rows.map((i) => `${i.kind}:${i.sourceTicketKey ?? ''}:${i.code ?? ''}`).sort();
}

const requested = (prefix: string) => fake.requestedPaths().filter((p) => p.startsWith(prefix));

describe('the Zammad 7.2.x module through the import worker (fake Zammad over HTTP)', () => {
  runDb('a dry run converts and predicts the fixture set, downloads nothing and writes no ticket or ledger row', async () => {
    const fx = await seedZammad();
    const windowsBefore = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.partnerId, fx.partner.id));
    const run = await startImportRun(fx, 'dry_run');
    const steps = await drive(fx, run.id, { deps });
    expect(steps.at(-1)).toMatchObject({ outcome: 'finished' });

    const row = await runRow(run.id);
    expect(row).toMatchObject({ state: 'completed', kind: 'dry_run', stopReason: null });
    const counters = normalizeCounters(row.counters);
    // 19 tickets; 110 (no org) and 116 (Zammad org 1) have no mapping and no fallback.
    expect(counters.tickets).toMatchObject({ seen: 19, skipped: 2, failed: 0, created: 0 });
    expect(counters.predicted).toMatchObject({
      creates: 17, resumes: 0, invalid: 0,
      // 102's four files; 111's oversized and empty ones are skipped by their declared size.
      attachments: 4, attachmentBytes: 70 + 53 + 70 + 70, attachmentsSkipped: 2,
    });
    expect(counters.comments.systemSkipped).toBe(1);
    expect(counters.attachments.alternativesIgnored).toBe(1);
    expect(counters.customAttributes).toEqual({ cf_billable: 1, cf_customer_reference: 1 });
    // Raised: 1011 and 1012 on 106, 1018 and 1019 on 109 (moved in, older than their survivor).
    expect(counters.moduleCounts).toEqual({ article_time_raised: 4, body_rendering_error: 1, state_removed: 1 });
    // The merged pair and the chain: three links, notes until W2 writes links.
    expect(counters.linksAsNotes).toBe(3);
    expect(counters.ownersUnmatched).toBe(1);
    expect(await issuesOf(run.id)).toEqual(['owner_unmatched:103:5', 'skipped_no_org:110:', 'skipped_no_org:116:']);

    // Unmapped tickets are decided from the list row, never loaded; nothing is downloaded.
    expect(requested('/api/v1/ticket_articles/by_ticket/110')).toEqual([]);
    expect(requested('/api/v1/ticket_attachment/')).toEqual([]);
    expect(requested('/api/v1/ticket_articles/by_ticket/114')).toEqual([]);
    expect(requested('/api/v1/tickets/114?expand=true')).toHaveLength(1);
    expect(await importedTickets(fx)).toEqual(new Map());
    expect(await getTestDb().select().from(ticketImportItems).where(eq(ticketImportItems.sourceId, fx.sourceId))).toEqual([]);
    expect(await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.partnerId, fx.partner.id))).toEqual(windowsBefore);
    expect(s3.objects.size).toBe(0);
  }, CASE_TIMEOUT);

  runDb('an import, then a delta pass after the source changed', async () => {
    const fx = await seedZammad();
    // The fallback org takes the tickets with no org or an unmapped one.
    await setMappings(fx, {
      orgs: [
        { sourceOrgKey: '2', sourceOrgName: 'Acme Ltd', orgId: fx.orgA.id },
        { sourceOrgKey: '3', sourceOrgName: 'Globex Inc', orgId: fx.orgB.id },
        { sourceOrgKey: null, sourceOrgName: null, orgId: fx.orgA.id },
      ],
      categories: [{ sourceGroupKey: '2', sourceGroupName: 'Support', categoryId: fx.categoryId }],
    }, ZAMMAD_OPTIONS);
    const window = await openWindow(fx);

    // ------------------------------------------------------------ bulk
    const bulk = await startImportRun(fx, 'import', window.id);
    await drive(fx, bulk.id, { deps });
    const bulkRow = await runRow(bulk.id);
    expect(bulkRow).toMatchObject({ state: 'completed', stopReason: null });
    const c1 = normalizeCounters(bulkRow.counters);
    expect(c1.tickets).toMatchObject({ seen: 19, created: 19, failed: 0, skipped: 0 });
    expect(c1.attachments).toMatchObject({ written: 4, skipped: 2, bytes: 70 + 53 + 70 + 70, alternativesIgnored: 1 });
    expect(c1.comments.systemSkipped).toBe(1);
    expect(c1.linksAsNotes).toBe(3);

    const t = await importedTickets(fx);
    expect([...t.keys()].sort()).toEqual(Array.from({ length: 19 }, (_, i) => String(101 + i)));
    const status = Object.fromEntries([...t].map(([k, v]) => [k, v.status]));
    expect(status).toEqual({
      101: 'open', 102: 'closed', 103: 'pending', 104: 'resolved', 105: 'closed', 106: 'open', 107: 'closed',
      108: 'closed', 109: 'open', 110: 'new', 111: 'open', 112: 'closed', 113: 'open', 114: 'open', 115: 'closed',
      116: 'open', 117: 'on_hold', 118: 'open', 119: 'open',
    });
    expect(t.get('101')).toMatchObject({
      orgId: fx.orgA.id, assignedTo: fx.alice.id, requesterContactId: fx.dana, categoryId: fx.categoryId, tags: ['printer', 'network'], priority: 'normal',
    });
    // A deactivated owner is still an eligible assignee; an owner with no user leaves the ticket unassigned.
    expect(t.get('102')).toMatchObject({ assignedTo: fx.bob.id, priority: 'high' });
    expect(t.get('103')).toMatchObject({ orgId: fx.orgB.id, assignedTo: null, requesterContactId: null, submitterEmail: 'frank@globex.example.test', categoryId: null });
    expect(t.get('104')!.priority).toBe('urgent');
    expect(t.get('110')!.orgId).toBe(fx.orgA.id);
    expect(t.get('111')).toMatchObject({ requesterContactId: null, submitterEmail: null, submitterName: 'Eve Nomail' });

    const c103 = await commentsOf(t.get('103')!.id);
    expect(c103.find((c) => c.sourceId === 'note:103:owner:5')).toMatchObject({ isPublic: false, content: 'Owner in Zammad: Carol Gone <carol.gone@former.example.test>' });
    expect(c103.find((c) => c.sourceId === 'note:103:pending:3:2026-11-20T09:00:00.000Z')?.content).toBe('Pending reminder in Zammad: 2026-11-20 09:00 UTC');
    expect(c103.map((c) => c.sourceId)).not.toContain('article:1007');
    const c105 = await commentsOf(t.get('105')!.id);
    expect(c105.map((c) => [c.sourceId, c.content]).sort()).toEqual([
      ['note:105:merged:106', 'Merged into Zammad #31006.'],
      ['note:105:time:10', 'Time accounted in Zammad: 10 minutes'],
    ]);

    // Files: originals (never the view=inline copy), on the right comments; an inline image is a
    // placeholder in the text and a file of its comment (decision 4).
    const files = await getTestDb()
      .select({ sourceId: ticketAttachments.importSourceId, key: ticketAttachments.storageKey, commentId: ticketAttachments.commentId })
      .from(ticketAttachments)
      .where(eq(ticketAttachments.ticketId, t.get('102')!.id));
    expect(files.map((f) => f.sourceId).sort()).toEqual(['attachment:5001', 'attachment:5003', 'attachment:5004', 'attachment:5007']);
    expect(t.get('102')!.description).toContain('[image: screenshot.png]');
    expect(t.get('102')!.description).not.toContain('tracker.example.net');
    const original = loadZammadFixtures('base').files.get(5001)!;
    expect(s3.objects.get(files.find((f) => f.sourceId === 'attachment:5001')!.key!)!.equals(original)).toBe(true);
    expect(requested('/api/v1/ticket_attachment/').sort()).toEqual([
      '/api/v1/ticket_attachment/102/1004/5001', '/api/v1/ticket_attachment/102/1004/5003',
      '/api/v1/ticket_attachment/102/1005/5004', '/api/v1/ticket_attachment/102/1005/5007',
    ]);
    const c102 = await commentsOf(t.get('102')!.id);
    const filesComment = c102.find((c) => c.sourceId === 'article-files:1004')!;
    expect(filesComment.content).toBe('Attachments from the original message.');
    expect(files.filter((f) => f.commentId === filesComment.id).map((f) => f.sourceId).sort()).toEqual(['attachment:5001', 'attachment:5003']);
    expect(await issuesOf(bulk.id)).toEqual(expect.arrayContaining(['attachments_skipped:111:empty', 'attachments_skipped:111:too_large', 'owner_unmatched:103:5']));

    const ledgerAfterBulk = await ledger(fx.sourceId);
    expect([...ledgerAfterBulk.values()].every((i) => i.state === 'imported' && i.importedVersion === i.seenVersion)).toBe(true);

    // ----------------------------------------------------------- delta
    fake.use('delta');
    fake.requests.length = 0;
    const delta = await startImportRun(fx, 'import', window.id);
    await drive(fx, delta.id, { deps });
    const deltaRow = await runRow(delta.id);
    expect(deltaRow).toMatchObject({ state: 'completed', stopReason: null });
    const c2 = normalizeCounters(deltaRow.counters);
    // 112 is deleted and 115 hidden: the list shows 17; seven of them changed.
    expect(c2.tickets).toMatchObject({ seen: 17, unchanged: 10, resumed: 7, created: 0, failed: 0 });
    expect(c2).toMatchObject({ deletedInSource: 1, hiddenInSource: 1, commentsMissingInSource: 0, commentsChangedInSource: 2 });
    expect(c2.linksAsNotes).toBe(2);
    // Only the changed tickets were loaded; the rest cost their list row.
    expect(requested('/api/v1/ticket_articles/by_ticket/').sort()).toEqual([
      '/api/v1/ticket_articles/by_ticket/101', '/api/v1/ticket_articles/by_ticket/102', '/api/v1/ticket_articles/by_ticket/104',
      '/api/v1/ticket_articles/by_ticket/106', '/api/v1/ticket_articles/by_ticket/113', '/api/v1/ticket_articles/by_ticket/118', '/api/v1/ticket_articles/by_ticket/119',
    ]);
    expect(requested('/api/v1/tickets/').sort()).toEqual(['/api/v1/tickets/112', '/api/v1/tickets/115']);

    expect(await issuesOf(delta.id)).toEqual([
      'comments_changed:101:made_internal',
      'comments_changed:102:changed',
      'deleted_in_source:112:',
      'hidden_in_source:115:',
    ]);

    const t2 = await importedTickets(fx);
    // A new article on 101; a status change on 104 (Zammad closed it).
    expect((await commentsOf(t2.get('101')!.id)).map((c) => c.sourceId)).toContain('article:1040');
    expect(t2.get('104')!.status).toBe('closed');
    // 113, merged into 106 between the passes: closed with its note; its
    // articles moved to 106 are neither reported deleted nor written twice.
    expect(t2.get('113')).toMatchObject({ status: 'closed', assignedTo: null });
    const c113 = await commentsOf(t2.get('113')!.id);
    expect(c113.map((c) => c.sourceId).sort()).toEqual(['article:1026', 'note:113:merged:106']);
    expect(c113.find((c) => c.sourceId === 'note:113:merged:106')!.content).toBe('Merged into Zammad #31006.');
    const moved = await getTestDb().select({ ticketId: ticketComments.ticketId, sourceId: ticketComments.importSourceId }).from(ticketComments)
      .where(inArray(ticketComments.importSourceId, ['article:1025', 'article:1026']));
    // 1026 was a comment on 113: the survivor's resume skips it (present elsewhere).
    // 1025 was 113's description, never a comment: it joins 106's thread, as in Zammad,
    // and 113's description converges with the source, which now has none.
    expect(moved.map((m) => [m.sourceId, m.ticketId]).sort()).toEqual([
      ['article:1025', t2.get('106')!.id],
      ['article:1026', t2.get('113')!.id],
    ]);
    expect(t2.get('113')!.description).toBe('');

    // 118, OLDER than 119, merged into the already-imported 119 between the
    // passes: the survivor keeps its own description and its comments, and
    // nothing is written twice. 1044 was a comment on 118 (skipped on 119);
    // 1043 was 118's description, never a comment: it joins 119's thread
    // once, at 119's creation, and 118 is handled like 113.
    expect(t2.get('119')!.description).toBe(t.get('119')!.description);
    expect(t2.get('119')!.description).toBe('To: support@msp.example.test\n\nJammed again, second ticket.');
    const c119Before = await commentsOf(t.get('119')!.id);
    const c119 = await commentsOf(t2.get('119')!.id);
    expect(c119.map((c) => c.sourceId).sort()).toEqual(['article:1043', 'article:1046']);
    expect(c119.find((c) => c.sourceId === 'article:1046')!.content).toBe(c119Before.find((c) => c.sourceId === 'article:1046')!.content);
    expect(t2.get('118')).toMatchObject({ status: 'closed', description: '' });
    expect((await commentsOf(t2.get('118')!.id)).map((c) => c.sourceId).sort()).toEqual(['article:1044', 'note:118:merged:119']);
    const once = await getTestDb().select({ sourceId: ticketComments.importSourceId }).from(ticketComments)
      .where(inArray(ticketComments.importSourceId, ['article:1043', 'article:1044', 'article:1045', 'article:1046']));
    expect(once.map((r) => r.sourceId).sort()).toEqual(['article:1043', 'article:1044', 'article:1046']);
    // Nothing is ever deleted in Breeze.
    expect([...t2.values()].every((x) => x.deletedAt === null)).toBe(true);
    const items = await ledger(fx.sourceId);
    expect(items.get('112')).toMatchObject({ state: 'deleted_in_source' });
    expect(items.get('115')).toMatchObject({ state: 'hidden_in_source' });
    expect(items.get('113')).toMatchObject({ state: 'imported', importedVersion: '2026-09-03T10:00:00.000Z' });
    // No file was downloaded again.
    expect(requested('/api/v1/ticket_attachment/')).toEqual([]);
  }, CASE_TIMEOUT);
});
