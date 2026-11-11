import { afterEach, describe, expect, it } from 'vitest';
import { SourceAuthError, SourceShapeError, SourceUnavailableError } from '../../sourceFetch';
import { clearZammadDirectoryCache, hasZammadDirectory, takeZammadInvalidRows, ZAMMAD_DIRECTORY_TTL_MS, zammadPeople } from './directory';
import { zammadTicketImportModule } from './index';
import { FakeZammad, FAKE_ZAMMAD_BASE_URL, loadZammadFixtures, zammadTestHandle } from './fakeZammad.fixtures';
import { __zammadReadingTestHooks, boundedInOrder, forgetFileLocations, loadZammad, rememberedFileLocation, scanZammad, zammadCursorAfterRow, zammadRow, type ZammadCursor } from './reading';
import { ZammadShapeError, type ZammadLoadedData } from './shapes';

/**
 * Reading a Zammad 7.2.2 source (spec 2026-10-19 §6.2, §6.8 "the client"),
 * through the real source client against the fake's synthesized fixtures.
 */

afterEach(() => {
  clearZammadDirectoryCache();
  forgetFileLocations();
});

function ticketRows(count: number, from = 1) {
  const template = loadZammadFixtures('base').tickets[0]!;
  return Array.from({ length: count }, (_, i) => ({ ...template, id: from + i, number: String(50000 + from + i) }));
}

describe('scan (Z2: id ASC, 100 a page, a short page ends it)', () => {
  it('lists the fixture set in one short page, keyed by id with updated_at as version', async () => {
    const fake = new FakeZammad();
    const page = await scanZammad(zammadTestHandle(fake), null);
    expect(page.next).toBeNull();
    expect(page.rows.map((r) => r.key)).toEqual(['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '111', '112', '113', '114', '115', '116', '117', '118', '119']);
    expect(page.rows[0]).toMatchObject({ key: '101', version: '2026-03-03T16:40:12.345Z', orgKey: '2', number: '31001' });
    expect(page.rows.find((r) => r.key === '110')!.orgKey).toBeNull();
    expect(fake.requestedPaths()).toEqual(['/api/v1/tickets?page=1&per_page=100']);
    // Token auth on every request (Z11).
    expect(fake.requests.every((r) => r.authorization === 'Token token=zammad-fixture-token')).toBe(true);
  });

  it('pages until a page shorter than 100, carrying the page number and the last id', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(230);
    const src = zammadTestHandle(fake);
    const first = await scanZammad(src, null);
    expect(first.rows).toHaveLength(100);
    expect(first.next).toEqual({ page: 2, lastId: 100 });
    const second = await scanZammad(src, first.next);
    expect(second.next).toEqual({ page: 3, lastId: 200 });
    const third = await scanZammad(src, second.next);
    expect(third.rows.map((r) => r.key)).toEqual(Array.from({ length: 30 }, (_, i) => String(201 + i)));
    expect(third.next).toBeNull();
  });

  it('a full last page is followed by an empty one that ends the scan', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(100);
    const src = zammadTestHandle(fake);
    const first = await scanZammad(src, null);
    expect(first.next).toEqual({ page: 2, lastId: 100 });
    expect(await scanZammad(src, first.next)).toEqual({ rows: [], next: null });
  });

  it('drops a row listed again after an earlier ticket reappeared (offset shift right)', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(150, 10);
    const src = zammadTestHandle(fake);
    const first = await scanZammad(src, null);
    // A ticket on page 1 becomes visible again: every later row moves right by one.
    fake.data.tickets = [...ticketRows(1, 5), ...ticketRows(150, 10)];
    const second = await scanZammad(src, first.next);
    expect(second.rows[0]!.key).toBe('110');
    expect(second.rows.map((r) => r.key)).not.toContain('109');
    expect(second.rows).toHaveLength(50);
  });

  it('a deletion on an earlier page while scanning: the row that shifted into it is still returned (review 8)', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(230);
    const src = zammadTestHandle(fake);
    const first = await scanZammad(src, null);
    expect(first.next).toEqual({ page: 2, lastId: 100 });
    // Ticket 50 is deleted: 101 moves to the end of page 1.
    fake.data.tickets = fake.data.tickets.filter((t) => t.id !== 50);
    const second = await scanZammad(src, first.next);
    expect(second.rows[0]!.key).toBe('101');
    expect(second.rows.map((r) => Number(r.key))).toEqual(Array.from({ length: 101 }, (_, i) => 101 + i));
    // The previous page is read again as the overlap.
    expect(fake.requestedPaths().slice(-2)).toEqual(['/api/v1/tickets?page=1&per_page=100', '/api/v1/tickets?page=2&per_page=100']);
  });

  it('a mid-page yield followed by a shift: the re-read page resumes after the last row handled, skipping none (review 8)', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(150);
    const src = zammadTestHandle(fake);
    const page = await scanZammad(src, null);
    // The runner handles rows 1..40, saving the cursor past each one, then yields.
    let cursor: ZammadCursor | null = null;
    for (const row of page.rows.slice(0, 40)) cursor = zammadCursorAfterRow(cursor, row.key);
    expect(cursor).toEqual({ page: 1, lastId: 40, stale: 0 });
    // Before the next slice, ticket 10 (already handled) is deleted: the page shifts left.
    fake.data.tickets = fake.data.tickets.filter((t) => t.id !== 10);
    const again = await scanZammad(src, cursor);
    // A position (40) would now skip ticket 41; the key does not.
    expect(again.rows[0]!.key).toBe('41');
    expect(again.rows.map((r) => Number(r.key))).toEqual(Array.from({ length: 61 }, (_, i) => 41 + i));
  });

  it('ends a scan whose pages bring no new id (a server ignoring `page`)', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = ticketRows(100);
    const src = zammadTestHandle(fake);
    // A server that answers page 1 whatever is asked.
    const original = fake.handle.bind(fake);
    fake.handle = (method, url, auth) => {
      url.searchParams.set('page', '1');
      return original(method, url, auth);
    };
    let cursor = (await scanZammad(src, null)).next;
    let calls = 1;
    while (cursor && calls < 10) {
      const next = await scanZammad(src, cursor);
      expect(next.rows).toEqual([]);
      cursor = next.next;
      calls += 1;
    }
    expect(cursor).toBeNull();
    expect(calls).toBe(4);
  });

  it('a malformed cursor starts at page 1', async () => {
    const fake = new FakeZammad();
    const rows = await scanZammad(zammadTestHandle(fake), { page: -3, lastId: 'x' } as never);
    expect(rows.rows).toHaveLength(19);
  });

  it('a malformed row with an id fails as its own ticket; the rest of the page is read (review 2)', async () => {
    const fake = new FakeZammad();
    const good = fake.data.tickets.find((t) => t.id === 101)!;
    fake.data.tickets = [
      good,
      { ...good, id: 150, customer_id: 'not a user', organization_id: 3, updated_at: '2026-08-01T00:00:00.000Z', number: '31050' },
      { ...good, id: 151, created_at: null },
    ] as never;
    const page = await scanZammad(zammadTestHandle(fake), null);
    expect(page.rows.map((r) => [r.key, r.failure?.code ?? null])).toEqual([
      ['101', null], ['150', 'source_shape_invalid'], ['151', 'source_shape_invalid'],
    ]);
    // Keyed from what the row has: the ledger and the report still name it.
    expect(page.rows[1]).toMatchObject({ version: '2026-08-01T00:00:00.000Z', orgKey: '3', number: '31050', summary: null });
  });

  it('a row with no id, or an answer that is not a list, cannot be split per row: a shape error, not an outage', async () => {
    const fake = new FakeZammad();
    fake.data.tickets = [{ id: 101, title: 'x' }, { title: 'no id' }] as never;
    const noId = await scanZammad(zammadTestHandle(fake), null).catch((e: unknown) => e);
    expect(noId).toBeInstanceOf(ZammadShapeError);
    expect(noId).toBeInstanceOf(SourceShapeError);
    expect(noId).not.toBeInstanceOf(SourceUnavailableError);
    const original = fake.handle.bind(fake);
    fake.handle = (method, url, auth) => (url.pathname === '/api/v1/tickets'
      ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"maintenance"}') }
      : original(method, url, auth));
    await expect(scanZammad(zammadTestHandle(fake), null)).rejects.toBeInstanceOf(SourceShapeError);
  });

  it('retries a 503, honours a long Retry-After as a deferral, and stops on a refused token', async () => {
    const fake = new FakeZammad();
    fake.failNext({ pathPrefix: '/api/v1/tickets', status: 503 });
    expect((await scanZammad(zammadTestHandle(fake), null)).rows).toHaveLength(19);

    fake.failNext({ pathPrefix: '/api/v1/tickets', status: 429, headers: { 'retry-after': '120' }, times: 5 });
    const deferred = await scanZammad(zammadTestHandle(fake), null).catch((e: unknown) => e);
    expect(deferred).toBeInstanceOf(SourceUnavailableError);
    expect((deferred as SourceUnavailableError).retryAfterMs).toBe(120_000);

    await expect(scanZammad(zammadTestHandle(new FakeZammad(), { token: 'wrong-token' }), null)).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('never sends a request outside the base URL, and refuses a token that is not a header value', async () => {
    const fake = new FakeZammad();
    await scanZammad(zammadTestHandle(fake, { baseUrl: `${FAKE_ZAMMAD_BASE_URL}/zammad` }), null);
    expect(fake.requests[0]!.path).toBe('/zammad/api/v1/tickets');
    await expect(scanZammad(zammadTestHandle(fake, { token: 'bad\r\ntoken' }), null)).rejects.toBeInstanceOf(SourceAuthError);
  });
});

async function load(fake: FakeZammad, ticketId: number) {
  const src = zammadTestHandle(fake);
  const row = zammadRow(fake.data.tickets.find((t) => t.id === ticketId) as never);
  const loaded = await loadZammad(src, row);
  return { src, loaded, data: loaded.data as ZammadLoadedData };
}

describe('load (§6.2: by_ticket, tags, the survivor of a merge, people)', () => {
  it('reads articles with by_ticket and tags, never all=true, and names what the conversion needs', async () => {
    const fake = new FakeZammad();
    const { data, loaded } = await load(fake, 101);
    expect(data.articles.map((a) => a.id)).toEqual([1001, 1002, 1003]);
    expect(data.tags).toEqual(['printer', 'network']);
    expect(data.state).toEqual({ id: 2, name: 'open', type: 'open', nextStateType: null });
    expect(data.priorityName).toBe('2 normal');
    expect(data.merge).toBeNull();
    expect(Object.keys(data.people).sort()).toEqual(['10', '3']);
    expect(loaded.needs).toEqual({ userEmails: ['alice.agent@msp.example.test'], contactEmails: ['dana@acme.example.test'] });
    const paths = fake.requestedPaths();
    expect(paths).toContain('/api/v1/ticket_articles/by_ticket/101');
    expect(paths).toContain('/api/v1/tags?object=Ticket&o_id=101');
    expect(paths.some((p) => p.includes('all=true') || p.startsWith('/api/v1/links'))).toBe(false);
    // The header came from the list row: the ticket itself is not read again.
    expect(paths).not.toContain('/api/v1/tickets/101');
  });

  it('reads the survivor of a merged ticket from its parent link, final along a chain (Z9)', async () => {
    const fake = new FakeZammad();
    expect((await load(fake, 105)).data.merge).toEqual({ survivorId: 106, survivorNumber: '31006', survivorCreatedAt: '2026-05-01T11:00:00.000Z' });
    expect((await load(fake, 107)).data.merge).toMatchObject({ survivorId: 109, survivorNumber: '31009' });
    expect(fake.requestedPaths()).toContain('/api/v1/links?link_object=Ticket&link_object_value=105');
  });

  it('reads the survivor itself when the link assets do not carry its number, and survives one it cannot see', async () => {
    const fake = new FakeZammad();
    fake.data.links.set(105, { links: [{ link_type: 'parent', link_object: 'Ticket', link_object_value: 106 }], assets: {} });
    expect((await load(fake, 105)).data.merge).toEqual({ survivorId: 106, survivorNumber: '31006', survivorCreatedAt: '2026-05-01T11:00:00.000Z' });
    fake.data.hidden.add(106);
    expect((await load(fake, 105)).data.merge).toEqual({ survivorId: 106, survivorNumber: null, survivorCreatedAt: null });
    fake.data.links.set(105, { links: [], assets: {} });
    expect((await load(fake, 105)).data.merge).toEqual({ survivorId: null, survivorNumber: null, survivorCreatedAt: null });
  });

  it('decides the path from the total article count, System articles included (review 12)', async () => {
    const fake = new FakeZammad();
    // 114: article_count (non-System) is 3, the total 6. With the threshold at 5 it is read article by article.
    __zammadReadingTestHooks.setBigTicketArticles(5);
    try {
      const { data } = await load(fake, 114);
      expect(data.ticket.article_count).toBe(3);
      expect(data.articles.map((a) => a.id)).toEqual([1027, 1037, 1028, 1038, 1029, 1039]);
      const paths = fake.requestedPaths();
      expect(paths).toContain('/api/v1/tickets/114?expand=true');
      expect(paths.filter((p) => /^\/api\/v1\/ticket_articles\/\d+$/.test(p))).toHaveLength(6);
      expect(paths).not.toContain('/api/v1/ticket_articles/by_ticket/114');
      // At the default threshold the same ticket is one by_ticket read.
      __zammadReadingTestHooks.setBigTicketArticles(null);
      fake.requests.length = 0;
      await load(fake, 114);
      expect(fake.requestedPaths()).toContain('/api/v1/ticket_articles/by_ticket/114');
    } finally {
      __zammadReadingTestHooks.setBigTicketArticles(null);
    }
  });

  it('an expand answer without article_ids reads by_ticket, as before the count was read', async () => {
    const fake = new FakeZammad();
    fake.data.ticketsExpand.set(101, { ...fake.data.tickets.find((t) => t.id === 101)! });
    const { data } = await load(fake, 101);
    expect(data.articles.map((a) => a.id)).toEqual([1001, 1002, 1003]);
    expect(fake.requestedPaths()).toContain('/api/v1/ticket_articles/by_ticket/101');
  });

  it('the per-article read stops starting requests at the first failure (review 4)', async () => {
    const fake = new FakeZammad();
    const template = fake.data.byTicket.get(114)![0]!;
    // 40 articles; the second one is gone (404).
    fake.data.byTicket.set(114, Array.from({ length: 40 }, (_, i) => ({ ...template, id: 3000 + i, created_at: `2026-07-05T08:${String(i).padStart(2, '0')}:00.000Z` })));
    const original = fake.handle.bind(fake);
    fake.handle = (method, url, auth) => (url.pathname === '/api/v1/ticket_articles/3001'
      ? { status: 404, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"error":"gone"}') }
      : original(method, url, auth));
    __zammadReadingTestHooks.setBigTicketArticles(5);
    try {
      const error = await load(fake, 114).catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'SourceHttpError', status: 404 });
      // Two in flight when 3001 failed; none started after it (was: all 40 at once).
      const reads = fake.requestedPaths().filter((p) => /^\/api\/v1\/ticket_articles\/\d+$/.test(p));
      expect(reads.length).toBeLessThanOrEqual(3);
    } finally {
      __zammadReadingTestHooks.setBigTicketArticles(null);
    }
  });

  it('falls back to one article at a time when by_ticket passes the JSON cap', async () => {
    const fake = new FakeZammad();
    // Two articles of 9 MiB each: together over the 16 MiB JSON cap, each under it.
    const big = 'x'.repeat(9 * 1024 * 1024);
    fake.data.byTicket.set(113, fake.data.byTicket.get(113)!.map((a) => ({ ...a, body: big })));
    const { data } = await load(fake, 113);
    expect(data.articles.map((a) => a.id)).toEqual([1025, 1026]);
    expect(fake.requestedPaths()).toContain('/api/v1/tickets/113?expand=true');
  });

  it('remembers where each file lives, for the download right after the load', async () => {
    const fake = new FakeZammad();
    const { src } = await load(fake, 102);
    expect(rememberedFileLocation(src, '102', 5004)).toEqual({ ticketId: 102, articleId: 1005 });
    expect(rememberedFileLocation(src, '102', 9999)).toBeNull();
    expect(rememberedFileLocation(zammadTestHandle(fake), '102', 5004)).toBeNull();
  });

  it('a row that is not the ticket it names is a shape error', async () => {
    const fake = new FakeZammad();
    const row = { ...zammadRow(fake.data.tickets[0] as never), key: '999' };
    await expect(loadZammad(zammadTestHandle(fake), row)).rejects.toBeInstanceOf(ZammadShapeError);
  });
});

describe('the directory (users cached 30 min per source; one read per missing user)', () => {
  it('every access sweeps the expired entries of any source; dispose drops a source at once (review 11)', async () => {
    const fake = new FakeZammad();
    const a = zammadTestHandle(fake, { sourceId: 'sweep-a' });
    const b = zammadTestHandle(fake, { sourceId: 'sweep-b' });
    await zammadPeople(a, [3], 1_000);
    await zammadPeople(b, [3], 2_000);
    expect(hasZammadDirectory('sweep-a')).toBe(true);
    // B's access 30 minutes after A's read sweeps A, whose people go with it.
    await zammadPeople(b, [3], 1_000 + ZAMMAD_DIRECTORY_TTL_MS);
    expect(hasZammadDirectory('sweep-a')).toBe(false);
    expect(hasZammadDirectory('sweep-b')).toBe(true);
    // A run of B ends here: its directory and its file locations go too.
    const row = zammadRow(fake.data.tickets.find((t) => t.id === 102) as never);
    await loadZammad(b, row);
    expect(rememberedFileLocation(b, '102', 5004)).not.toBeNull();
    zammadTicketImportModule.dispose!('sweep-b');
    expect(hasZammadDirectory('sweep-b')).toBe(false);
    expect(rememberedFileLocation(b, '102', 5004)).toBeNull();
  });

  it('skips and counts an unreadable user row, never failing the load (review 2)', async () => {
    const fake = new FakeZammad();
    fake.data.users = [...fake.data.users, { id: 'x', login: 7 }, { id: 40, email: 12 }] as never;
    // A user missing from the index whose own record is unreadable.
    const original = fake.handle.bind(fake);
    fake.handle = (method, url, auth) => (url.pathname === '/api/v1/users/41'
      ? { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"id":41,"email":["not","text"]}') }
      : original(method, url, auth));
    const src = zammadTestHandle(fake, { sourceId: 'dir-invalid' });
    const people = await zammadPeople(src, [3, 40, 41]);
    expect(people.get(3)).toMatchObject({ firstname: 'Alice' });
    expect(people.get(40)).toBeNull();
    expect(people.get(41)).toBeNull();
    // Two unreadable index rows, then 40 and 41 read on their own, both unreadable.
    expect(takeZammadInvalidRows(src)).toEqual({ users: 4 });
    // Reported once.
    expect(takeZammadInvalidRows(src)).toEqual({});
    // A load hands the rows its own directory read skipped to its conversion.
    const { data } = await load(fake, 101);
    expect(data.invalidRows).toEqual({ users: 2 });
  });

  it('pages the users once, reads a user created since on its own, and caches one the source no longer has', async () => {
    const fake = new FakeZammad();
    const src = zammadTestHandle(fake, { sourceId: 'dir-1' });
    fake.data.users = fake.data.users.filter((u) => u.id !== 13);
    const first = await zammadPeople(src, [3, 10], 1_000);
    expect(first.get(3)).toMatchObject({ firstname: 'Alice', email: 'alice.agent@msp.example.test', active: true });
    // A user the index did not hold: GET /users/:id; the source answers 404 for 999.
    fake.data.users.push({ ...loadZammadFixtures().users.find((u) => u.id === 13)! });
    const second = await zammadPeople(src, [13, 999], 2_000);
    expect(second.get(13)).toMatchObject({ firstname: 'Grace' });
    expect(second.get(999)).toBeNull();
    await zammadPeople(src, [999, 13, 3], 3_000);
    expect(fake.requestedPaths().filter((p) => p.startsWith('/api/v1/users'))).toEqual([
      // The index, two pages at a time (the second is past its end), then two users on their own.
      '/api/v1/users?page=1&per_page=1000', '/api/v1/users?page=2&per_page=1000', '/api/v1/users/13', '/api/v1/users/999',
    ]);
    // After 30 minutes the index is read again.
    await zammadPeople(src, [3], 1_000 + 30 * 60_000);
    expect(fake.requestedPaths().filter((p) => p === '/api/v1/users?page=1&per_page=1000')).toHaveLength(2);
    // Another source never shares the entry.
    await zammadPeople(zammadTestHandle(fake, { sourceId: 'dir-2' }), [3], 1_000);
    expect(fake.requestedPaths().filter((p) => p === '/api/v1/users?page=1&per_page=1000')).toHaveLength(3);
  });
});

describe('boundedInOrder', () => {
  it('keeps the order, never runs more than the limit at once, and stops starting work after the first failure', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const slow = async (n: number) => {
      started.push(n);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (n === 4) throw new Error(`failed ${n}`);
      return n * 10;
    };
    expect(await boundedInOrder([1, 2, 3], 2, slow)).toEqual([10, 20, 30]);
    expect(peak).toBe(2);
    started.length = 0;
    await expect(boundedInOrder(Array.from({ length: 20 }, (_, i) => i), 2, slow)).rejects.toThrow('failed 4');
    expect(Math.max(...started)).toBeLessThanOrEqual(5);
    expect(await boundedInOrder([], 2, slow)).toEqual([]);
  });
});
