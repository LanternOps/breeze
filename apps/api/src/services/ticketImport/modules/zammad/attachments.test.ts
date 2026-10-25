import { afterEach, describe, expect, it } from 'vitest';
import { SourceAuthError, SourceHttpError, SourceResponseTooLargeError, SourceUnavailableError } from '../../sourceFetch';
import { fetchZammadAttachment, probeZammad } from './attachments';
import { clearZammadDirectoryCache } from './directory';
import { FakeZammad, loadZammadFixtures, RESIZED_COPY, zammadTestHandle } from './fakeZammad.fixtures';
import { loadZammad, zammadRow } from './reading';

/** Files and probes (spec 2026-10-19 §4.3, §5.9 deletions, §6.2; Z6, Z8, Z10). */

afterEach(() => clearZammadDirectoryCache());

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
    expect(fake.requestedPaths()).toEqual(['/api/v1/ticket_articles/by_ticket/102', '/api/v1/ticket_attachment/102/1005/5004']);
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
