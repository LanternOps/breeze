import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from './auth';
import { isChatSessionType, openAiSession, pageContextFromSnapshot } from './aiSessionOpen';

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1', title: 'T', status: 'active', orgId: 'org-1', type: 'general', deviceId: 'dev-1',
  flaggedAt: null, flagReason: null, delegantM365ConnectionId: 'm365-1',
  contextSnapshot: { type: 'device', hostname: 'h', orgAnchor: 'page_context' },
  topologySiteId: null, lastTurnModel: null, ...over,
});

describe('openAiSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('hydrates a general session', async () => {
    fetchMock.mockResolvedValue(res({ session: row({ flaggedAt: '2026-01-01', flagReason: 'x' }), messages: [
      { id: 'm1', role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    ] }));
    const r = await openAiSession('s1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/ai/sessions/s1');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.view).toMatchObject({
      id: 's1', orgId: 'org-1', type: 'general', deviceId: 'dev-1', status: 'active',
      m365ConnectionId: 'm365-1', isFlagged: true, flagReason: 'x', topologySiteId: null,
      pageContext: { type: 'device', hostname: 'h' },
    });
    expect(r.view.pageContext).not.toHaveProperty('orgAnchor');
    expect(r.view.raw.id).toBe('s1');
    expect(r.messages).toHaveLength(1);
  });

  it('treats a non-chat type as not_found', async () => {
    fetchMock.mockResolvedValue(res({ session: row({ type: 'script_builder' }), messages: [] }));
    expect(await openAiSession('s1')).toEqual({ kind: 'not_found' });
  });

  it('maps 404 to not_found', async () => {
    fetchMock.mockResolvedValue(res({}, 404));
    expect(await openAiSession('s1')).toEqual({ kind: 'not_found' });
  });

  it('maps a non-active session to closed', async () => {
    fetchMock.mockResolvedValue(res({ session: row({ status: 'expired' }), messages: [] }));
    expect(await openAiSession('s1')).toEqual({ kind: 'closed' });
  });

  it('maps other HTTP failures and network throws to error', async () => {
    fetchMock.mockResolvedValueOnce(res({}, 500));
    expect((await openAiSession('s1')).kind).toBe('error');
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    expect(await openAiSession('s1')).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('pageContextFromSnapshot', () => {
  it('returns null for null / non-objects / missing type', () => {
    expect(pageContextFromSnapshot(null)).toBeNull();
    expect(pageContextFromSnapshot('x')).toBeNull();
    expect(pageContextFromSnapshot({ hostname: 'h' })).toBeNull();
  });
  it('drops orgAnchor', () => {
    expect(pageContextFromSnapshot({ type: 'device', hostname: 'h', orgAnchor: 'page_context' }))
      .toEqual({ type: 'device', hostname: 'h' });
  });
});

describe('isChatSessionType', () => {
  it('accepts general and topology only', () => {
    expect(isChatSessionType('general')).toBe(true);
    expect(isChatSessionType('topology')).toBe(true);
    expect(isChatSessionType('script_builder')).toBe(false);
    expect(isChatSessionType(undefined)).toBe(false);
  });
});
