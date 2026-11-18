import { afterEach, describe, expect, it } from 'vitest';
import { SourceAuthError, SourceHttpError, SourceResponseTooLargeError, SourceUnavailableError } from '../../sourceFetch';
import { fetchZammadAttachment, probeZammad } from './attachments';
import { clearZammadDirectoryCache } from './directory';
import { FakeZammad, loadZammadFixtures, RESIZED_COPY, zammadTestHandle } from './fakeZammad.fixtures';
import { ZAMMAD_ATTACHMENT_INDEX_LIMITS } from '../../importLimits';
import { __zammadReadingTestHooks, forgetFileLocations, indexedFileLocationCount, loadZammad, rememberedFileLocation, rememberFileLocations, ZAMMAD_FILE_LOCATION_TICKETS, zammadRow } from './reading';
import type { ZammadArticle } from './shapes';

/** Files and probes (spec 2026-10-19 §4.3, §5.9 deletions, §6.2; Z6, Z8, Z10). */

afterEach(() => {
  clearZammadDirectoryCache();
  forgetFileLocations();
});

async function loaded(fake: FakeZammad, ticketId: number) {
  const src = zammadTestHandle(fake);
  await loadZammad(src, zammadRow(fake.data.tickets.find((t) => t.id === ticketId) as never));
  return src;
}

describe('fetchAttachment', () => {
  it('downloads the original bytes with no view, from the article\'s ticket', async () => {
    const fake = new FakeZammad();
    const src = await loaded(fake, 102);
    const bytes = await fetchZammadAttachment(src, { sourceId: 'attachment:5001', ticketKey: '102' }, 10 * 1024 * 1024);
    expect(Buffer.from(bytes).equals(fake.data.files.get(5001)!)).toBe(true);
    expect(Buffer.from(bytes).equals(RESIZED_COPY)).toBe(false);
    const download = fake.requests.at(-1)!;
    expect(download.path).toBe('/api/v1/ticket_attachment/102/1004/5001');
    expect(download.query).toEqual({});
    expect(download.authorization).toBe('Token token=zammad-fixture-token');
  });

  it('finds where a file lives when its ticket was not loaded by this handle', async () => {
    const fake = new FakeZammad();
    const bytes = await fetchZammadAttachment(zammadTestHandle(fake), { sourceId: 'attachment:5004', ticketKey: '102' }, 1024);
    expect(Buffer.from(bytes).equals(fake.data.files.get(5004)!)).toBe(true);
    expect(fake.requestedPaths()).toEqual([
      '/api/v1/tickets/102?expand=true', '/api/v1/ticket_articles/by_ticket/102', '/api/v1/ticket_attachment/102/1005/5004',
    ]);
  });

  it('a location miss re-reads the way a load does: article by article for a big ticket, never by_ticket (review 7)', async () => {
    const data = loadZammadFixtures('base');
    data.byTicket.set(114, data.byTicket.get(114)!.map((a) => (a.id === 1028
      ? { ...a, attachments: [{ id: 5003, store_file_id: 9003, filename: 'report.pdf', size: '53', preferences: {} }] }
      : a)));
    const fake = new FakeZammad(data);
    __zammadReadingTestHooks.setBigTicketArticles(5);
    try {
      await fetchZammadAttachment(zammadTestHandle(fake), { sourceId: 'attachment:5003', ticketKey: '114' }, 1024);
    } finally {
      __zammadReadingTestHooks.setBigTicketArticles(null);
    }
    const paths = fake.requestedPaths();
    expect(paths).not.toContain('/api/v1/ticket_articles/by_ticket/114');
    expect(paths.filter((p) => /^\/api\/v1\/ticket_articles\/\d+$/.test(p))).toHaveLength(6);
    expect(paths.at(-1)).toBe('/api/v1/ticket_attachment/114/1028/5003');
  });

  it('locations are kept per source and ticket, whichever handle asks, in a bounded LRU (review 7)', async () => {
    const fake = new FakeZammad();
    const loader = zammadTestHandle(fake, { sourceId: 'lru-source' });
    await loadZammad(loader, zammadRow(fake.data.tickets.find((t) => t.id === 102) as never));
    // Another handle of the same source (the next slice) finds it without reading again.
    fake.requests.length = 0;
    await fetchZammadAttachment(zammadTestHandle(fake, { sourceId: 'lru-source' }), { sourceId: 'attachment:5004', ticketKey: '102' }, 1024);
    expect(fake.requestedPaths()).toEqual(['/api/v1/ticket_attachment/102/1005/5004']);
    // Another source never sees it.
    expect(rememberedFileLocation(zammadTestHandle(fake, { sourceId: 'other-source' }), '102', 5004)).toBeNull();
    // Bounded: the least recently used ticket goes first.
    for (let i = 0; i < ZAMMAD_FILE_LOCATION_TICKETS; i += 1) rememberFileLocations(loader, `9${i}`, []);
    expect(rememberedFileLocation(loader, '102', 5004)).toBeNull();
  });

  describe('the index is bounded in entries, not only tickets (#11730 review, Strix)', () => {
    const { perTicket, total } = ZAMMAD_ATTACHMENT_INDEX_LIMITS;
    const stubs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, store_file_id: from + i, filename: 'f', size: '1', preferences: {} }));
    const articleWith = (ticketId: number, files: ReturnType<typeof stubs>) => ({ id: ticketId * 10, ticket_id: ticketId, attachments: files }) as unknown as ZammadArticle;

    it('a ticket over the per-ticket cap is not indexed; its file still downloads through a fresh read', async () => {
      const data = loadZammadFixtures('base');
      data.byTicket.set(102, data.byTicket.get(102)!.map((a) => (a.id === 1004
        ? { ...a, attachments: [...(a.attachments as unknown[]), ...stubs(100_000, perTicket)] }
        : a)));
      const fake = new FakeZammad(data);
      const src = await loaded(fake, 102);
      expect(rememberedFileLocation(src, '102', 5004)).toBeNull();
      expect(indexedFileLocationCount()).toBe(0);
      fake.requests.length = 0;
      const bytes = await fetchZammadAttachment(src, { sourceId: 'attachment:5004', ticketKey: '102' }, 1024);
      expect(Buffer.from(bytes).equals(fake.data.files.get(5004)!)).toBe(true);
      expect(fake.requestedPaths()).toEqual([
        '/api/v1/tickets/102?expand=true', '/api/v1/ticket_articles/by_ticket/102', '/api/v1/ticket_attachment/102/1005/5004',
      ]);
      expect(indexedFileLocationCount()).toBe(0);
    });

    it('a ticket at the cap is indexed and its files come from the cache', () => {
      const src = zammadTestHandle(new FakeZammad(), { sourceId: 'cap-source' });
      rememberFileLocations(src, '7', [articleWith(7, stubs(1, perTicket))]);
      expect(indexedFileLocationCount()).toBe(perTicket);
      expect(rememberedFileLocation(src, '7', perTicket)).toEqual({ ticketId: 7, articleId: 70 });
    });

    it('past the total cap across sources the least recently used tickets go first', () => {
      const fake = new FakeZammad();
      const a = zammadTestHandle(fake, { sourceId: 'total-a' });
      const b = zammadTestHandle(fake, { sourceId: 'total-b' });
      const tickets = total / perTicket;
      for (let i = 1; i <= tickets; i += 1) rememberFileLocations(i % 2 ? a : b, String(i), [articleWith(i, stubs(1, perTicket))]);
      expect(indexedFileLocationCount()).toBe(total);
      // Ticket 1 used most recently: ticket 2 is the oldest now.
      expect(rememberedFileLocation(a, '1', 1)).not.toBeNull();
      rememberFileLocations(a, 'next', [articleWith(99, stubs(1, 1))]);
      expect(indexedFileLocationCount()).toBe(total - perTicket + 1);
      expect(rememberedFileLocation(b, '2', 1)).toBeNull();
      expect(rememberedFileLocation(a, '1', 1)).not.toBeNull();
      expect(rememberedFileLocation(a, 'next', 1)).toEqual({ ticketId: 99, articleId: 990 });
      // Re-indexing a ticket replaces its entries; forgetting a source releases its count.
      rememberFileLocations(a, 'next', [articleWith(99, stubs(1, 3))]);
      expect(indexedFileLocationCount()).toBe(total - perTicket + 3);
      forgetFileLocations('total-b');
      expect(indexedFileLocationCount()).toBe(Math.ceil(tickets / 2) * perTicket + 3);
    });
  });

  it('the attachment id is the attachment\'s own, not the shared store file (review 7)', async () => {
    const fake = new FakeZammad();
    const articles = fake.data.byTicket.get(102)!.flatMap((a) => (a.attachments as Array<{ id: number; store_file_id: number }>).map((f) => ({ article: a.id, ...f })));
    // 5001 and 5004 hold equal content: one store file, two attachments on two articles.
    expect(articles.filter((f) => f.store_file_id === 9001).map((f) => [f.article, f.id])).toEqual([[1004, 5001], [1005, 5004]]);
    const src = await loaded(fake, 102);
    await fetchZammadAttachment(src, { sourceId: 'attachment:5001', ticketKey: '102' }, 1024);
    await fetchZammadAttachment(src, { sourceId: 'attachment:5004', ticketKey: '102' }, 1024);
    expect(fake.requestedPaths().slice(-2)).toEqual(['/api/v1/ticket_attachment/102/1004/5001', '/api/v1/ticket_attachment/102/1005/5004']);
  });

  it('an article moved by a merge is downloaded through its current ticket', async () => {
    const data = loadZammadFixtures('delta');
    // 1025 came from 113 (merged into 106); give it a file. The route checks the article's current ticket (Z8).
    data.byTicket.set(106, data.byTicket.get(106)!.map((a) => (a.id === 1025
      ? { ...a, attachments: [{ id: 5003, store_file_id: 9003, filename: 'report.pdf', size: '53', preferences: { 'Content-Type': 'application/pdf' } }] }
      : a)));
    const fake = new FakeZammad(data);
    const src = await loaded(fake, 106);
    await fetchZammadAttachment(src, { sourceId: 'attachment:5003', ticketKey: '106' }, 1024);
    expect(fake.requests.at(-1)!.path).toBe('/api/v1/ticket_attachment/106/1025/5003');
  });

  it('is bounded by maxBytes: an over-cap answer is too_large for the framework', async () => {
    const fake = new FakeZammad();
    const src = await loaded(fake, 102);
    await expect(fetchZammadAttachment(src, { sourceId: 'attachment:5003', ticketKey: '102' }, 10)).rejects.toBeInstanceOf(SourceResponseTooLargeError);
  });

  it('a 404 or 403 is permanent; a 5xx after retries transient; a long Retry-After a deferral; a 401 a stop', async () => {
    const fake = new FakeZammad();
    const src = await loaded(fake, 102);
    const ref = { sourceId: 'attachment:5003', ticketKey: '102' };
    const failure = async (status: number, headers?: Record<string, string>, times = 1) => {
      fake.failNext({ pathPrefix: '/api/v1/ticket_attachment', status, headers, times });
      return fetchZammadAttachment(src, ref, 1024).catch((e: unknown) => e);
    };
    expect(await failure(404)).toMatchObject({ name: 'SourceHttpError', status: 404 });
    expect(await failure(403)).toMatchObject({ name: 'SourceHttpError', status: 403 });
    const unavailable = await failure(503, undefined, 3);
    expect(unavailable).toBeInstanceOf(SourceUnavailableError);
    expect((unavailable as SourceUnavailableError).retryAfterMs).toBeNull();
    const deferred = await failure(429, { 'retry-after': '90' });
    expect(deferred).toBeInstanceOf(SourceUnavailableError);
    expect((deferred as SourceUnavailableError).retryAfterMs).toBe(90_000);
    expect(await failure(401)).toBeInstanceOf(SourceAuthError);
    // A short Retry-After is waited inline and retried.
    fake.failNext({ pathPrefix: '/api/v1/ticket_attachment', status: 429, headers: { 'retry-after': '2' } });
    expect((await fetchZammadAttachment(src, ref, 1024)).byteLength).toBe(fake.data.files.get(5003)!.byteLength);
  });

  it('an id this module did not mint, or a file its ticket does not list, is a permanent 404', async () => {
    const fake = new FakeZammad();
    const src = await loaded(fake, 102);
    for (const ref of [{ sourceId: 'file:5001', ticketKey: '102' }, { sourceId: 'attachment:5001', ticketKey: 'x' }, { sourceId: 'attachment:777', ticketKey: '102' }]) {
      const error = await fetchZammadAttachment(src, ref, 1024).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SourceHttpError);
      expect((error as SourceHttpError).status).toBe(404);
    }
  });
});

describe('probe', () => {
  it('present with its row, 404 deleted, 403 hidden (Z10); a refused token is not a deletion', async () => {
    const fake = new FakeZammad(loadZammadFixtures('delta'));
    const src = zammadTestHandle(fake);
    expect(await probeZammad(src, '101')).toEqual({ state: 'present', row: zammadRow(fake.data.tickets.find((t) => t.id === 101) as never) });
    expect(await probeZammad(src, '112')).toEqual({ state: 'deleted' });
    expect(await probeZammad(src, '115')).toEqual({ state: 'hidden' });
    await expect(probeZammad(zammadTestHandle(fake, { token: 'nope' }), '101')).rejects.toBeInstanceOf(SourceAuthError);
    fake.failNext({ pathPrefix: '/api/v1/tickets/101', status: 503, times: 3 });
    await expect(probeZammad(src, '101')).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(probeZammad(src, 'abc')).rejects.toThrow(/Not a Zammad ticket key/);
  });
});
