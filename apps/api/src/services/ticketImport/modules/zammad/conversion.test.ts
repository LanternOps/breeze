import { afterEach, describe, expect, it } from 'vitest';
import { parseImportedTicket, type ImportedComment, type ImportedTicket } from '../../importedTicket';
import { IMPORT_TEXT_MAX_CHARS, IMPORT_TRUNCATION_MARKER } from '../../importText';
import type { Conversion, ConversionContext } from '../../moduleContract';
import { clampTicketTimes } from '../../runOutcomes';
import { ZAMMAD_FILES_COMMENT, ZAMMAD_RENDER_ERROR_MARKER, convertZammadTicket } from './conversion';
import { clearZammadDirectoryCache } from './directory';
import { FakeZammad, loadZammadFixtures, zammadTestHandle, type FixtureSetName, type ZammadFixtureData } from './fakeZammad.fixtures';
import { isZammadSourceArticleId } from './ids';
import { zammadOptionsSchema, type ZammadOptions } from './options';
import { loadZammad, zammadRow } from './reading';

/**
 * The pure conversion against the synthesized 7.2.2 fixtures (spec
 * 2026-10-19 §6.3–§6.6, §6.8): each fixture ticket is loaded through the
 * real client from the fake, converted, checked against the writer's own
 * schema, snapshotted, and its cases asserted. Times are UTC instants.
 */

const NOW = new Date('2026-10-25T12:00:00.000Z');
const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const CAT_SUPPORT = 'cccccccc-0000-4000-8000-00000000000c';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const DANA = '33333333-3333-4333-8333-333333333333';

afterEach(() => clearZammadDirectoryCache());

function context(options: Partial<ZammadOptions> = {}, over: Partial<ConversionContext<ZammadOptions>> = {}): ConversionContext<ZammadOptions> {
  return {
    orgId: ORG_A,
    orgIdBySourceOrg: new Map([['2', ORG_A], ['3', ORG_B]]),
    fallbackOrgId: ORG_A,
    categoryIdBySourceGroup: new Map([['2', CAT_SUPPORT]]),
    userIdByEmail: new Map([['alice.agent@msp.example.test', ALICE], ['bob.former@msp.example.test', BOB]]),
    contactIdByEmail: new Map([['dana@acme.example.test', DANA]]),
    options: zammadOptionsSchema.parse({ priorityMap: { '4': 'urgent' }, ...options }),
    now: NOW,
    clockSkewMs: 0,
    ...over,
  };
}

async function convert(
  id: number,
  input: { set?: FixtureSetName; data?: ZammadFixtureData; options?: Partial<ZammadOptions>; ctx?: Partial<ConversionContext<ZammadOptions>> } = {},
) {
  const fake = new FakeZammad(input.data ?? loadZammadFixtures(input.set ?? 'base'));
  const src = zammadTestHandle(fake, { options: input.options });
  const loaded = await loadZammad(src, zammadRow(fake.data.tickets.find((t) => t.id === id) as never));
  const conversion = convertZammadTicket(loaded, context(input.options, input.ctx));
  return { loaded, conversion };
}

function ticketOf(conversion: Conversion): { ticket: ImportedTicket; links: Extract<Conversion, { kind: 'ticket' }>['links'] } {
  if (conversion.kind !== 'ticket') throw new Error(`expected a ticket, got a skip (${conversion.code})`);
  return conversion;
}

const byId = (t: ImportedTicket, id: string): ImportedComment => {
  const comment = t.comments.find((c) => c.sourceId === id);
  if (!comment) throw new Error(`no comment ${id}`);
  return comment;
};

const BASE_IDS = loadZammadFixtures('base').tickets.map((t) => t.id);
const DELTA_IDS = loadZammadFixtures('delta').tickets.map((t) => t.id);
const ID_GRAMMAR = /^(article:\d+|article-files:\d+|note:\d+:(owner:\d+|pending:\d+:.+|merged:(\d+|none)|time:[\d.]+))$/;

describe('every fixture ticket (§6.8)', () => {
  it.each([...BASE_IDS.map((id) => ['base', id] as const), ...DELTA_IDS.map((id) => ['delta', id] as const)])(
    '%s %i converts to a ticket the writer accepts, with ids in the grammar and times in UTC',
    async (set, id) => {
      const { conversion, loaded } = await convert(id, { set });
      const { ticket } = ticketOf(conversion);
      expect(() => parseImportedTicket(ticket, NOW)).not.toThrow();
      expect(ticket.sourceId).toBe(String(id));
      for (const comment of ticket.comments) {
        expect(comment.sourceId).toMatch(ID_GRAMMAR);
        for (const file of comment.attachments ?? []) expect(file.sourceId).toMatch(/^attachment:\d+$/);
        // A composed note or a files comment is never mistaken for a deleted article.
        if (!comment.sourceId.startsWith('article:')) expect(isZammadSourceArticleId(comment.sourceId, loaded)).toBe(false);
      }
      // Source times are UTC instants, kept to the millisecond.
      const header = loaded.data as { ticket: { created_at: string } };
      expect(ticket.createdAt.toISOString()).toBe(header.ticket.created_at);
    },
  );

  it.each(BASE_IDS)('base %i matches its snapshot', async (id) => {
    const { conversion } = await convert(id);
    expect(conversion).toMatchSnapshot();
  });
});

describe('a plain mail ticket (101)', () => {
  it('maps the header, the description, a reply with To/Cc and an internal note', async () => {
    const { ticket, links } = ticketOf((await convert(101)).conversion);
    expect(ticket).toMatchObject({
      sourceId: '101',
      sourceNumber: '31001',
      sourceUrl: 'https://zammad.example.test/#ticket/zoom/101',
      orgId: ORG_A,
      subject: 'Printer offline on floor 2',
      priority: 'normal',
      categoryId: CAT_SUPPORT,
      tags: ['printer', 'network'],
      source: 'email',
      requester: { contactId: DANA },
      assigneeUserId: ALICE,
      finalStatus: 'open',
    });
    expect(ticket.description).toBe('To: support@msp.example.test\n\nHi,\nthe printer on floor 2 is offline again.\n\nDana');
    expect(ticket.comments.map((c) => c.sourceId)).toEqual(['article:1002', 'article:1003']);
    expect(byId(ticket, 'article:1002')).toMatchObject({
      isPublic: true,
      author: { kind: 'staff', name: 'Alice Agent', email: 'alice.agent@msp.example.test' },
      content: 'To: dana@acme.example.test\nCc: it-lead@acme.example.test\n\nHi Dana,\nwe are on it.\n\nAlice',
    });
    expect(byId(ticket, 'article:1003')).toMatchObject({ isPublic: false, content: 'Toner was empty; ordered more.' });
    expect(byId(ticket, 'article:1002').createdAt.toISOString()).toBe('2026-03-02T10:02:00.000Z');
    expect(links).toEqual([]);
  });
});

describe('an HTML mail with inline images (102)', () => {
  it('inline images become placeholders and inline attachments; external ones are dropped; the HTML copy is ignored', async () => {
    const { conversion } = await convert(102);
    const { ticket } = ticketOf(conversion);
    expect(ticket.description).toContain('[image: screenshot.png]');
    expect(ticket.description).toContain('[image]');
    expect(ticket.description).not.toContain('tracker.example.net');
    expect(ticket.description).toContain('Report attached.');
    // The description's files ride on one public comment by its author (F8).
    expect(byId(ticket, 'article-files:1004')).toMatchObject({
      isPublic: true,
      author: { kind: 'requester', name: 'Dana Customer' },
      content: ZAMMAD_FILES_COMMENT,
      attachments: [
        { sourceId: 'attachment:5001', filename: 'screenshot.png', declaredBytes: 70, inline: true },
        { sourceId: 'attachment:5003', filename: 'report.pdf', declaredBytes: 53, inline: false },
      ],
    });
    const reply = byId(ticket, 'article:1005');
    expect(reply.content).toContain('KB 42 <https://kb.example.com/article/42>');
    expect(reply.content).toContain('> see the error below');
    expect(reply.content).toContain('[image: image001.png]');
    expect(reply.attachments).toEqual([
      { sourceId: 'attachment:5004', filename: 'image001.png', declaredBytes: 70, inline: true },
      // Stored inline (Content-Disposition inline + Content-ID) though the body does not show it:
      // inline, with no placeholder (the second rule, after the body reference).
      { sourceId: 'attachment:5007', filename: 'signature-logo.png', declaredBytes: 70, inline: true },
    ]);
    expect(reply.content).not.toContain('signature-logo.png');
    expect(conversion.notes).toContainEqual({ kind: 'attachments_alternative_ignored', count: 1 });
  });

  it('a file with no Content-Disposition, or inline without a Content-ID, is a plain attachment unless the body shows it', async () => {
    const data = loadZammadFixtures('base');
    data.byTicket.set(102, data.byTicket.get(102)!.map((a) => (a.id === 1005
      ? { ...a, attachments: (a.attachments as Array<{ id: number; preferences: Record<string, unknown> }>).map((f) => (f.id === 5007 ? { ...f, preferences: { 'Content-Type': 'image/png', 'Content-Disposition': 'inline' } } : f)) }
      : a)));
    const reply = byId(ticketOf((await convert(102, { data })).conversion).ticket, 'article:1005');
    expect(reply.attachments!.map((f) => [f.sourceId, f.inline])).toEqual([['attachment:5004', true], ['attachment:5007', false]]);
    const files = byId(ticketOf((await convert(102)).conversion).ticket, 'article-files:1004').attachments!;
    expect(files.find((f) => f.sourceId === 'attachment:5003')!.inline).toBe(false);
  });

  it('closes at last_close_at; the deactivated owner matches; the time accounted is one internal note', async () => {
    const { ticket } = ticketOf((await convert(102)).conversion);
    expect(ticket).toMatchObject({ finalStatus: 'closed', assigneeUserId: BOB, priority: 'high' });
    expect(ticket.closedAt!.toISOString()).toBe('2026-03-08T08:30:00.000Z');
    expect(byId(ticket, 'note:102:time:45')).toMatchObject({
      isPublic: false,
      author: { kind: 'staff', name: 'Zammad (system)' },
      content: 'Time accounted in Zammad: 45 minutes',
    });
    expect(byId(ticket, 'note:102:time:45').createdAt.toISOString()).toBe('2026-03-08T08:30:01.000Z');
  });

  it('the time note follows the unit option and can be turned off; it is never a time entry', async () => {
    const hours = ticketOf((await convert(102, { options: { timeUnitLabel: 'hours' } })).conversion).ticket;
    expect(byId(hours, 'note:102:time:45').content).toBe('Time accounted in Zammad: 45 hours');
    const off = ticketOf((await convert(102, { options: { timeAccountingNote: false } })).conversion).ticket;
    expect(off.comments.some((c) => c.sourceId.startsWith('note:102:time:'))).toBe(false);
    expect(Object.keys(off)).not.toContain('timeEntries');
  });
});

describe('an agent phone ticket (103)', () => {
  it('pending reminder with its note; the owner note for an owner with no user; a display-only requester', async () => {
    const { conversion } = await convert(103);
    const { ticket } = ticketOf(conversion);
    expect(ticket).toMatchObject({
      finalStatus: 'pending',
      source: 'manual',
      ticketType: 'incident',
      priority: 'high',
      categoryId: null,
      assigneeUserId: null,
      requester: { name: 'Frank Shared', email: 'frank@globex.example.test' },
    });
    expect(ticket.description).toBe('[phone]\n\nFrank called: VPN drops every hour.');
    expect(byId(ticket, 'article:1008')).toMatchObject({ isPublic: true, author: { kind: 'requester', name: 'Frank Shared' }, content: '[sms]\n\nStill dropping.' });
    expect(byId(ticket, 'note:103:owner:5')).toMatchObject({ isPublic: false, content: 'Owner in Zammad: Carol Gone <carol.gone@former.example.test>' });
    expect(byId(ticket, 'note:103:pending:3:2026-11-20T09:00:00.000Z').content).toBe('Pending reminder in Zammad: 2026-11-20 09:00 UTC');
    // The System trigger note is skipped and counted (#8313 answer 5).
    expect(ticket.comments.map((c) => c.sourceId)).not.toContain('article:1007');
    expect(conversion.notes).toEqual(expect.arrayContaining([
      { kind: 'owner_unmatched', sourceUserKey: '5' },
      { kind: 'requester_without_contact' },
      { kind: 'comments_system_skipped', count: 1 },
    ]));
    // The report carries the source user key, never a name.
    expect(JSON.stringify(conversion.notes)).not.toContain('Carol');
  });

  it('keeps System articles as internal notes by Zammad (system) when the option says so', async () => {
    const { conversion } = await convert(103, { options: { systemArticles: 'internal_note' } });
    const { ticket } = ticketOf(conversion);
    expect(byId(ticket, 'article:1007')).toMatchObject({
      isPublic: false,
      author: { kind: 'staff', name: 'Zammad (system)' },
      content: 'Reminder: call Frank back tomorrow.',
    });
    expect(conversion.notes.some((n) => n.kind === 'comments_system_skipped')).toBe(false);
  });
});

describe('pending close and custom fields (104)', () => {
  it('pending close is resolved (decision 10), with the auto-close time in a note', async () => {
    const { conversion } = await convert(104);
    const { ticket } = ticketOf(conversion);
    expect(ticket).toMatchObject({ finalStatus: 'resolved', source: 'portal', priority: 'urgent', assigneeUserId: null });
    expect(ticket.resolvedAt!.toISOString()).toBe('2026-04-21T07:30:00.000Z');
    expect(byId(ticket, 'note:104:pending:6:2026-04-25T00:00:00.000Z').content).toBe('Zammad would have closed this at 2026-04-25 00:00 UTC');
    // Unassigned in Zammad: no owner note.
    expect(ticket.comments.some((c) => c.sourceId.includes(':owner:'))).toBe(false);
    // Custom attributes are counted by name, never imported (§6.5).
    expect(conversion.notes).toContainEqual({ kind: 'custom_attribute', name: 'cf_customer_reference' });
    expect(JSON.stringify(ticket)).not.toContain('PO-7788');
  });

  it('a custom priority with no mapping is normal', async () => {
    const { ticket } = ticketOf((await convert(104, { options: { priorityMap: {} } })).conversion);
    expect(ticket.priority).toBe('normal');
  });
});

describe('a custom pending-action state with no next state (117, as a live 7.2.0 has)', () => {
  it('is on hold, with its pending time in a note', async () => {
    const { ticket } = ticketOf((await convert(117)).conversion);
    expect(ticket.finalStatus).toBe('on_hold');
    expect(ticket.resolvedAt).toBeUndefined();
    expect(byId(ticket, 'note:117:pending:8:2026-08-01T09:00:00.000Z')).toMatchObject({
      isPublic: false,
      content: 'Pending in Zammad (Paused) until 2026-08-01 09:00 UTC',
    });
  });

  it('follows the operator\'s per-state map, keeping the note', async () => {
    const { ticket } = ticketOf((await convert(117, { options: { stateMap: { '8': { status: 'pending', name: 'Paused' } } } })).conversion);
    expect(ticket.finalStatus).toBe('pending');
    expect(byId(ticket, 'note:117:pending:8:2026-08-01T09:00:00.000Z').content).toBe('Pending in Zammad (Paused) until 2026-08-01 09:00 UTC');
    const resolved = ticketOf((await convert(117, { options: { stateMap: { '8': { status: 'resolved' } } } })).conversion).ticket;
    expect(resolved.finalStatus).toBe('resolved');
    expect(resolved.resolvedAt!.toISOString()).toBe('2026-07-08T09:00:00.000Z');
  });

  it('pending close keeps resolved when the state list names its closed next state', async () => {
    const { loaded, conversion } = await convert(104);
    expect((loaded.data as { state: unknown }).state).toEqual({ id: 6, name: 'pending close', type: 'pending action', nextStateType: 'closed' });
    expect(ticketOf(conversion).ticket.finalStatus).toBe('resolved');
  });
});

describe('merges (§6.6)', () => {
  it('a merged ticket is closed, with the merge note and a duplicate_of link to its survivor; the marker is skipped', async () => {
    const { conversion } = await convert(105);
    const { ticket, links } = ticketOf(conversion);
    expect(ticket).toMatchObject({ finalStatus: 'closed', description: '', tags: ['duplicate'], requester: { name: 'Eve Nomail' } });
    expect(ticket.closedAt!.toISOString()).toBe('2026-05-02T09:00:00.000Z');
    expect(ticket.comments.map((c) => [c.sourceId, c.content])).toEqual([
      ['note:105:merged:106', 'Merged into Zammad #31006.'],
      ['note:105:time:10', 'Time accounted in Zammad: 10 minutes'],
    ]);
    expect(links).toEqual([{ sourceKey: '105', targetKey: '106', linkType: 'duplicate_of', at: new Date('2026-05-02T09:00:00.000Z') }]);
  });

  it('a chain links every merged ticket to the final survivor, at the later of the merge and the survivor creation', async () => {
    for (const id of [107, 108]) {
      const { ticket, links } = ticketOf((await convert(id)).conversion);
      expect(byId(ticket, `note:${id}:merged:109`).content).toBe('Merged into Zammad #31009.');
      expect(links.map((l) => [l.targetKey, l.at.toISOString()])).toEqual([['109', id === 107 ? '2026-06-03T10:00:00.000Z' : '2026-06-04T10:00:00.000Z']]);
    }
  });

  it('the survivor keeps the moved articles, raised to its creation and counted', async () => {
    const { conversion } = await convert(106);
    const { ticket } = ticketOf(conversion);
    // The oldest public article (moved from 105) is the description.
    expect(ticket.description).toBe('To: support@msp.example.test\n\nThe VPN is broken.');
    expect(ticket.comments.map((c) => c.sourceId)).toEqual(['article:1012', 'article:1014', 'article:1015']);
    expect(byId(ticket, 'article:1012').createdAt.toISOString()).toBe('2026-05-01T11:00:00.000Z');
    expect(conversion.notes).toContainEqual({ kind: 'module_count', name: 'article_time_raised', count: 1 });
  });

  it('a merged ticket whose survivor the token cannot see keeps only the note', async () => {
    const data = loadZammadFixtures('base');
    data.links.set(105, { links: [], assets: {} });
    const { ticket, links } = ticketOf((await convert(105, { data })).conversion);
    expect(byId(ticket, 'note:105:merged:none').content).toBe('Merged in Zammad into a ticket the import cannot see.');
    expect(links).toEqual([]);
  });

  it('a ticket merged between passes reports none of its moved articles as deleted (delta 113)', async () => {
    const { loaded, conversion } = await convert(113, { set: 'delta' });
    const { ticket } = ticketOf(conversion);
    expect(ticket.finalStatus).toBe('closed');
    expect(ticket.assigneeUserId).toBeNull();
    expect(ticket.comments.map((c) => c.sourceId)).toEqual(['note:113:merged:106']);
    // The writer asks about the stored articles the input no longer has.
    expect(isZammadSourceArticleId('article:1025', loaded)).toBe(false);
    expect(isZammadSourceArticleId('article:1026', loaded)).toBe(false);
  });
});

describe('content and edge cases', () => {
  it('a customer without email, an oversized and an empty file, a body Zammad could not render (111)', async () => {
    const { conversion } = await convert(111);
    const { ticket } = ticketOf(conversion);
    expect(ticket.requester).toEqual({ name: 'Eve Nomail' });
    expect(ticket.description.startsWith(`To: support@msp.example.test\n${ZAMMAD_RENDER_ERROR_MARKER}\n\n`)).toBe(true);
    // Declared sizes only: the writer skips both without fetching them (§4).
    expect(byId(ticket, 'article-files:1022').attachments).toEqual([
      { sourceId: 'attachment:5005', filename: 'backup.zip', declaredBytes: 20 * 1024 * 1024, inline: false },
      { sourceId: 'attachment:5006', filename: 'empty.txt', declaredBytes: 0, inline: false },
    ]);
    expect(conversion.notes).toEqual(expect.arrayContaining([
      { kind: 'requester_without_contact' },
      { kind: 'module_count', name: 'body_rendering_error', count: 1 },
    ]));
  });

  it('a legacy removed state is closed and counted (112)', async () => {
    const { conversion } = await convert(112);
    expect(ticketOf(conversion).ticket.finalStatus).toBe('closed');
    expect(conversion.notes).toContainEqual({ kind: 'module_count', name: 'state_removed' });
  });

  it('a ticket without organization converts into the org the framework chose (110)', async () => {
    const { ticket } = ticketOf((await convert(110, { ctx: { orgId: ORG_B } })).conversion);
    expect(ticket).toMatchObject({ orgId: ORG_B, finalStatus: 'new', source: 'portal', requester: { name: 'Grace Solo', email: 'grace@solo.example.org' } });
  });

  it('a body over 200,000 characters is clamped with the visible marker and counted', async () => {
    const data = loadZammadFixtures('base');
    data.byTicket.set(113, data.byTicket.get(113)!.map((a) => (a.id === 1026 ? { ...a, body: 'long line\n'.repeat(25_000) } : a)));
    const { conversion } = await convert(113, { data });
    const reply = byId(ticketOf(conversion).ticket, 'article:1026');
    expect(reply.content.length).toBeLessThanOrEqual(IMPORT_TEXT_MAX_CHARS);
    expect(reply.content.endsWith(IMPORT_TRUNCATION_MARKER)).toBe(true);
    expect(conversion.notes).toContainEqual({ kind: 'content_truncated', count: 1 });
  });

  it('an empty title is (no subject); control characters the writer refuses are stripped', async () => {
    const data = loadZammadFixtures('base');
    data.tickets = data.tickets.map((t) => (t.id === 113 ? { ...t, title: '' } : t));
    data.byTicket.set(113, data.byTicket.get(113)!.map((a) => (a.id === 1026 ? { ...a, body: 'bell\u0007 and nul\u0000 gone' } : a)));
    const { ticket } = ticketOf((await convert(113, { data })).conversion);
    expect(ticket.subject).toBe('(no subject)');
    expect(byId(ticket, 'article:1026').content).toBe('To: dana@acme.example.test\n\nbell and nul gone');
  });

  it('refuses loudly a later Zammad that moves inline images to inline_attachments (Z6, §11)', async () => {
    const data = loadZammadFixtures('base');
    data.byTicket.set(101, data.byTicket.get(101)!.map((a) => (a.id === 1001 ? { ...a, inline_attachments: [{ id: 1 }] } : a)));
    expect((await convert(101, { data })).conversion).toEqual({ kind: 'skip', code: 'unsupported', notes: [] });
  });

  it('a state type 7.2.2 does not have is unsupported', async () => {
    const data = loadZammadFixtures('base');
    data.states = data.states.map((s) => (s.id === 2 ? { ...s, state_type: 'escalated' } : s));
    expect((await convert(101, { data })).conversion).toMatchObject({ kind: 'skip', code: 'unsupported' });
  });
});

describe('clock skew (§5.2): the framework clamps what the conversion keeps exact', () => {
  it('a source time up to the skew limit ahead is clamped to now and counted; beyond, the ticket fails clock_skew', async () => {
    const data = loadZammadFixtures('base');
    // The source clock runs 2 minutes ahead: the ticket was "updated" after Breeze's now.
    data.tickets = data.tickets.map((t) => (t.id === 101 ? { ...t, updated_at: '2026-10-25T12:02:00.000Z' } : t));
    const { ticket } = ticketOf((await convert(101, { data })).conversion);
    expect(ticket.updatedAt.toISOString()).toBe('2026-10-25T12:02:00.000Z');
    const clamped = clampTicketTimes(ticket, NOW, 5 * 60_000);
    expect(clamped).toMatchObject({ kind: 'ok', clamped: true });
    expect(clamped.kind === 'ok' && clamped.ticket.updatedAt.toISOString()).toBe(NOW.toISOString());
    expect(clampTicketTimes(ticket, NOW, 60_000)).toEqual({ kind: 'clock_skew' });
  });
});
