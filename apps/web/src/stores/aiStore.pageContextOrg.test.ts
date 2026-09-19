/**
 * #5684 — the AI sidebar reuses the PERSISTED session across org boundaries.
 *
 * #5598 fixed the server so a NEW session created from a device page anchors to
 * that device's org. It did not help the reported repro, because opening the
 * sidebar on an Org B device while an Org A session is persisted never creates
 * a session at all: `sessionId` survives in localStorage, `sendMessage` reuses
 * it, and every tool call resolves against Org A.
 *
 * The store must drop a session whose org no longer matches the device page the
 * chat is open on, so the next message creates one anchored to the device's org.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const DEVICE_B = 'dddddddd-1111-4222-8333-444455556666';

const deviceBContext = {
  type: 'device' as const,
  id: DEVICE_B,
  hostname: 'ORGB-WS-01',
  orgId: ORG_B,
};

function seedOrgASession() {
  useAiStore.setState({
    sessionId: 'session-org-a',
    sessionOrgId: ORG_A,
    messages: [{ id: 'm1', role: 'assistant', content: 'hello from org A' }] as never,
    pageContext: null,
    boundM365ConnectionId: 'conn-org-a',
    isFlagged: true,
    flagReason: 'stale',
    error: null,
    isLoading: false,
  });
}

describe('ai store page-context org rebinding (#5684)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAiStore.setState({
      sessionId: null,
      sessionOrgId: null,
      messages: [],
      pageContext: null,
      boundM365ConnectionId: null,
      isFlagged: false,
      flagReason: null,
      error: null,
      isLoading: false,
    });
  });

  it('drops an Org A session when the page context becomes an Org B device', () => {
    seedOrgASession();

    useAiStore.getState().setPageContext(deviceBContext);

    const state = useAiStore.getState();
    expect(state.sessionId).toBeNull();
    expect(state.sessionOrgId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.boundM365ConnectionId).toBeNull();
    expect(state.isFlagged).toBe(false);
    expect(state.pageContext).toEqual(deviceBContext);
  });

  it('keeps the session when the page-context device is in the same org', () => {
    seedOrgASession();

    useAiStore.getState().setPageContext({
      type: 'device',
      id: DEVICE_B,
      hostname: 'ORGA-WS-09',
      orgId: ORG_A,
    });

    expect(useAiStore.getState().sessionId).toBe('session-org-a');
  });

  it('keeps the session when the device page context carries no org (nothing to compare)', () => {
    seedOrgASession();

    useAiStore.getState().setPageContext({ type: 'device', id: DEVICE_B, hostname: 'WS' });

    expect(useAiStore.getState().sessionId).toBe('session-org-a');
  });

  it('keeps the session when the page context is cleared on unmount', () => {
    seedOrgASession();

    useAiStore.getState().setPageContext(null);

    expect(useAiStore.getState().sessionId).toBe('session-org-a');
  });

  it('creates the replacement session with the Org B device page context and records its org', async () => {
    seedOrgASession();
    useAiStore.getState().setPageContext(deviceBContext);

    fetchWithAuthMock.mockResolvedValueOnce(makeResponse({ id: 'session-org-b', orgId: ORG_B }));
    await useAiStore.getState().createSession();

    const [url, init] = fetchWithAuthMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/ai/sessions');
    expect(JSON.parse(String(init.body)).pageContext).toEqual(deviceBContext);
    expect(useAiStore.getState().sessionId).toBe('session-org-b');
    expect(useAiStore.getState().sessionOrgId).toBe(ORG_B);
  });

  it('drops a restored session whose org only becomes known after loadSession (post-reload path)', async () => {
    // localStorage only carries `sessionId`; the org arrives with the restore.
    useAiStore.setState({ sessionId: 'session-org-a', sessionOrgId: null, pageContext: deviceBContext });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ session: { id: 'session-org-a', orgId: ORG_A, status: 'active' }, messages: [] }),
    );
    await useAiStore.getState().loadSession('session-org-a');

    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().sessionOrgId).toBeNull();
    expect(useAiStore.getState().isLoading).toBe(false);
  });

  it('abandons an in-flight Org A stream when the page rebinds to Org B mid-response', async () => {
    // A tech sends a message on an Org A device, then navigates to an Org B
    // device before the answer finishes. The reader is still running: without
    // an ownership check its events append into the freshly-cleared Org B chat
    // and `isStreaming` stays true, silently blocking the next message.
    seedOrgASession();
    useAiStore.setState({ messages: [] });

    let releaseSecondChunk: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const encode = (obj: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n`);
    const cancel = vi.fn().mockResolvedValue(undefined);
    let read = 0;
    const reader = {
      cancel,
      read: vi.fn(async () => {
        read += 1;
        if (read === 1) {
          return { done: false, value: encode({ type: 'message_start', messageId: 'a1' }) };
        }
        if (read === 2) {
          await gate;
          return {
            done: false,
            value: encode({ type: 'content_delta', delta: 'org A secrets' }),
          };
        }
        return { done: true, value: undefined };
      }),
    };
    fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response);

    const sending = useAiStore.getState().sendMessage('what is wrong with this box?');
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));

    // Navigate to the Org B device while the Org A stream is still open.
    useAiStore.getState().setPageContext(deviceBContext);
    expect(useAiStore.getState().sessionId).toBeNull();
    expect(useAiStore.getState().isStreaming).toBe(false);

    releaseSecondChunk();
    await sending;

    const state = useAiStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it('restores a session normally when its org matches the device page', async () => {
    useAiStore.setState({ sessionId: 'session-org-b', sessionOrgId: null, pageContext: deviceBContext });

    fetchWithAuthMock.mockResolvedValueOnce(
      makeResponse({ session: { id: 'session-org-b', orgId: ORG_B, status: 'active' }, messages: [] }),
    );
    await useAiStore.getState().loadSession('session-org-b');

    expect(useAiStore.getState().sessionId).toBe('session-org-b');
    expect(useAiStore.getState().sessionOrgId).toBe(ORG_B);
  });
});
