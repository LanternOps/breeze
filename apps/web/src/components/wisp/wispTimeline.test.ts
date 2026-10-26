import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispTimelineItem, WispTimelineMessage, WispTimelinePost } from '@breeze/shared';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchMock }));

import { fetchWispTimeline, mergeTimelineItems, splitTimelinePage } from './wispTimeline';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

const msg = (id: string, createdAt: string, over: Partial<WispTimelineMessage> = {}): WispTimelineMessage => ({
  source: 'message', id, sessionId: 's-old', role: 'assistant', content: `text ${id}`, contentBlocks: null,
  toolName: null, toolInput: null, toolOutput: null, toolUseId: null, createdAt, ...over,
});
const post = (id: string, createdAt: string, over: Partial<WispTimelinePost> = {}): WispTimelinePost => ({
  source: 'post', id, kind: 'nudge', title: `post ${id}`, body: null, link: null, sections: null,
  concernId: null, orgId: null, read: null, createdAt, ...over,
});

describe('fetchWispTimeline', () => {
  beforeEach(() => fetchMock.mockReset());

  it('builds the query string and unwraps data', async () => {
    const items = [post('p-1', '2026-10-26T09:00:00.000Z'), msg('m-1', '2026-10-26T08:00:00.000Z')];
    fetchMock.mockResolvedValue(ok({ data: { items, nextCursor: 'next-1' } }));
    const page = await fetchWispTimeline('th 1', { cursor: 'c/1', limit: 20, excludeSessionId: 's-live' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    const [path, query] = url.split('?') as [string, string];
    expect(path).toBe('/wisp/thread/th%201/timeline');
    const params = new URLSearchParams(query);
    expect(params.get('limit')).toBe('20');
    expect(params.get('cursor')).toBe('c/1');
    expect(params.get('excludeSessionId')).toBe('s-live');
    // Id-addressed and grant-scoped: the org switcher must not narrow it.
    expect(init).toMatchObject({ skipOrgIdInjection: true });
    expect(page).toEqual({ items, nextCursor: 'next-1' });
  });

  it('omits an absent cursor and exclusion, and defaults the limit', async () => {
    fetchMock.mockResolvedValue(ok({ data: { items: [], nextCursor: null } }));
    const page = await fetchWispTimeline('th-1', { cursor: null, excludeSessionId: null });
    const params = new URLSearchParams((fetchMock.mock.calls[0]?.[0] as string).split('?')[1]);
    expect(params.has('cursor')).toBe(false);
    expect(params.has('excludeSessionId')).toBe(false);
    expect(params.get('limit')).toBe('50');
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('a failed response throws with its status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409, json: async () => ({}) } as Response);
    await expect(fetchWispTimeline('th-1', {})).rejects.toThrow('409');
  });

  it('a body without an items array is a contract break, not an empty thread', async () => {
    fetchMock.mockResolvedValue(ok({ data: { nextCursor: null } }));
    await expect(fetchWispTimeline('th-1', {})).rejects.toThrow(/malformed/);
  });

  it('drops malformed rows (and logs them) but keeps the rest', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = msg('m-1', '2026-10-26T08:00:00.000Z');
    fetchMock.mockResolvedValue(ok({
      data: {
        items: [good, { source: 'post', id: 'p-x', kind: 'mystery', title: 't', createdAt: '2026-10-26T08:00:00.000Z' }, { source: 'other', id: 'z' }],
        nextCursor: null,
      },
    }));
    const page = await fetchWispTimeline('th-1', {});
    expect(page.items).toEqual([good]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[wispTimeline]'), expect.anything());
    err.mockRestore();
  });

  it('every row malformed is a contract break', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(ok({ data: { items: [{ source: 'other' }], nextCursor: null } }));
    await expect(fetchWispTimeline('th-1', {})).rejects.toThrow(/malformed/);
  });
});

describe('splitTimelinePage', () => {
  it('splits and orders oldest first', () => {
    const items: WispTimelineItem[] = [
      post('p-2', '2026-10-26T10:00:00.000Z'),
      msg('m-3', '2026-10-26T09:30:00.000Z', { role: 'tool_result', toolName: 'query_devices', toolUseId: 'tu-1', toolOutput: { ok: true } }),
      msg('m-2', '2026-10-26T09:29:00.000Z', { role: 'tool_use', toolName: 'query_devices', toolUseId: 'tu-1', toolInput: { limit: 5 } }),
      post('p-1', '2026-10-26T09:00:00.000Z'),
      msg('m-1', '2026-10-26T08:00:00.000Z', { role: 'user', content: 'hi' }),
    ];
    const { messages, posts } = splitTimelinePage(items);
    expect(messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(posts.map((p) => p.id)).toEqual(['p-1', 'p-2']);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(messages[0]?.createdAt).toEqual(new Date('2026-10-26T08:00:00.000Z'));
    expect(messages[1]).toMatchObject({ role: 'tool_use', toolName: 'query_devices', toolUseId: 'tu-1', toolInput: { limit: 5 } });
    expect(messages[2]).toMatchObject({ role: 'tool_result', toolOutput: { ok: true } });
  });

  it('on equal milliseconds a tool call reads in conversation order, whatever the ids say', () => {
    const same = '2026-10-26T09:00:00.000Z';
    // Newest first as the server sends it: equal ms fall back to id DESC, so the result can come "after" its use.
    const items: WispTimelineItem[] = [
      msg('a-use', same, { role: 'tool_use', toolName: 'q', toolUseId: 'tu' }),
      msg('z-result', same, { role: 'tool_result', toolName: 'q', toolUseId: 'tu' }),
      msg('m-text', same, { role: 'assistant' }),
    ];
    expect(splitTimelinePage(items).messages.map((m) => m.role)).toEqual(['assistant', 'tool_use', 'tool_result']);
  });

  it('maps null fields to the store shape (empty content, no tool fields)', () => {
    const { messages } = splitTimelinePage([msg('m-1', '2026-10-26T08:00:00.000Z', { content: null })]);
    expect(messages[0]?.content).toBe('');
    expect(messages[0]?.toolName).toBeUndefined();
    expect(messages[0]?.toolUseId).toBeUndefined();
    expect(messages[0]?.toolInput).toBeUndefined();
  });
});

describe('mergeTimelineItems', () => {
  it('unions by source and id, the incoming copy wins, and the result is newest first in the keyset order', () => {
    const prev: WispTimelineItem[] = [post('p-1', '2026-10-26T09:00:00.000Z', { read: false }), msg('m-1', '2026-10-26T08:00:00.000Z')];
    const incoming: WispTimelineItem[] = [
      post('p-2', '2026-10-26T10:00:00.000Z'),
      post('p-1', '2026-10-26T09:00:00.000Z', { read: true }),
      // Same millisecond as p-1: the keyset puts the post first (source DESC).
      msg('m-2', '2026-10-26T09:00:00.000Z'),
    ];
    const merged = mergeTimelineItems(prev, incoming);
    expect(merged.map((i) => i.id)).toEqual(['p-2', 'p-1', 'm-2', 'm-1']);
    expect((merged[1] as WispTimelinePost).read).toBe(true);
  });

  it('a message and a post may share an id without colliding', () => {
    const merged = mergeTimelineItems([msg('x', '2026-10-26T08:00:00.000Z')], [post('x', '2026-10-26T08:00:00.000Z')]);
    expect(merged.map((i) => i.source)).toEqual(['post', 'message']);
  });
});
