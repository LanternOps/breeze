import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { listInboxDelta, markRead, listMessageAttachments, getFileAttachmentBytes } from './graphMailClient';

const SELECT = '%24select'; // encodeURIComponent('$select')

describe('listInboxDelta', () => {
  beforeEach(() => fetchMock.mockReset());

  it('follows @odata.nextLink, aggregates messages, returns the final deltaLink', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          value: [{ id: 'm1' }],
          '@odata.nextLink': 'https://graph.microsoft.com/next-2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          value: [{ id: 'm2' }],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta-final',
        }),
      });

    const page = await listInboxDelta('tok', 'support@a.com', null);
    expect(page.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(page.deltaLink).toBe('https://graph.microsoft.com/delta-final');
    expect(fetchMock.mock.calls[0]![0]).toContain('/mailFolders/inbox/messages/delta');
    expect(fetchMock.mock.calls[0]![0]).toContain(SELECT);
  });

  it('uses the stored deltaLink verbatim when provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/delta-2',
      }),
    });
    await listInboxDelta('tok', 'support@a.com', 'https://graph.microsoft.com/stored-delta');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://graph.microsoft.com/stored-delta');
  });

  it('retries once on 429 honoring Retry-After', async () => {
    const headers429 = new Map([['retry-after', '0']]);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: headers429,
        text: async () => 'throttled',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ value: [], '@odata.deltaLink': 'd' }),
      });
    const page = await listInboxDelta('tok', 'support@a.com', null);
    expect(page.deltaLink).toBe('d');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('markRead', () => {
  beforeEach(() => fetchMock.mockReset());

  it('PATCHes isRead true', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({}),
    });
    await markRead('tok', 'support@a.com', 'm1');
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { body: string }];
    expect(url).toContain('/messages/m1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ isRead: true });
  });
});

describe('listMessageAttachments (#6688)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('lists attachment METADATA only (no contentBytes in $select) and follows nextLink', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({
          value: [{ id: 'a1', name: 'r.pdf', '@odata.type': '#microsoft.graph.fileAttachment' }],
          '@odata.nextLink': 'https://graph.microsoft.com/att-page-2',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ value: [{ id: 'a2', name: 'x.png' }] }),
      });

    const list = await listMessageAttachments('tok', 'support@a.com', 'm/1');
    expect(list.map((a) => a.id)).toEqual(['a1', 'a2']);
    const firstUrl = fetchMock.mock.calls[0]![0] as string;
    expect(firstUrl).toContain('/users/support%40a.com/messages/m%2F1/attachments');
    expect(decodeURIComponent(firstUrl)).toContain('$select=id,name,contentType,size,isInline');
    expect(firstUrl).not.toContain('contentBytes');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://graph.microsoft.com/att-page-2');
  });

  it('throws with the HTTP status on a non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map(), text: async () => 'gone' });
    await expect(listMessageAttachments('tok', 'support@a.com', 'm1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('getFileAttachmentBytes (#6688)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('decodes contentBytes from the single-attachment GET', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ id: 'a1', contentBytes: Buffer.from('%PDF-1.7 hi').toString('base64') }),
    });
    const buf = await getFileAttachmentBytes('tok', 'support@a.com', 'm1', 'a1');
    expect(buf.toString()).toBe('%PDF-1.7 hi');
    expect(fetchMock.mock.calls[0]![0]).toContain('/messages/m1/attachments/a1');
  });

  it('throws when the response carries no contentBytes', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: new Map(), json: async () => ({ id: 'a1' }) });
    await expect(getFileAttachmentBytes('tok', 'support@a.com', 'm1', 'a1')).rejects.toThrow(/contentBytes/);
  });
});
