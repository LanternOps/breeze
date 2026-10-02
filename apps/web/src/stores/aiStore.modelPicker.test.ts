/**
 * W05 review fixes (#7603): the composer's model pick must never leak across
 * chats, and a coded 409 must not leave the optimistic user bubble behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelChoicesDto } from '@breeze/shared';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';
import { useAiModelPickerStore } from './aiModelPickerStore';

const fetchMock = vi.mocked(fetchWithAuth);

const CHOICES: AiModelChoicesDto = {
  surface: 'chat', allowUserChoice: true, defaultOfferingId: 'def',
  current: { offeringId: 'def', options: {} },
  choices: [
    { offeringId: 'def', displayName: 'Sonnet', contextTokens: 1, funding: 'platform', priceHint: { inputCentsPerM: 1, outputCentsPerM: 1, fast: null }, thinkingMode: 'adaptive', options: { effort: [], speed: ['standard'], budgetThinking: false }, defaults: {}, disabled: null },
    { offeringId: 'haiku', displayName: 'Haiku', contextTokens: 1, funding: 'platform', priceHint: { inputCentsPerM: 1, outputCentsPerM: 1, fast: null }, thinkingMode: 'budget', options: { effort: [], speed: ['standard'], budgetThinking: true }, defaults: {}, disabled: null },
  ],
};

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const emptyStream = (): Response => {
  let sent = false;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: new Uint8Array() })), cancel: async () => undefined }) } } as unknown as Response;
};

const reset = () => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  useAiModelPickerStore.getState().reset();
  useAiStore.setState({
    sessionId: 'A', sessionOrgId: 'o1', hydratedSessionId: 'A', messages: [], isStreaming: false, isLoading: false,
    error: null, errorCode: null, pageContext: null, pendingApproval: null,
  });
};

/** Route fetches by URL so ordering of background loads does not matter. */
function route(handlers: Record<string, () => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (url: string | URL | Request) => {
    const u = String(url);
    for (const [k, h] of Object.entries(handlers)) if (u.includes(k)) return h();
    return json({}, 404);
  });
}

const messagePosts = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/messages'));

beforeEach(reset);

describe('selection never leaks across chats', () => {
  it('switching A to B then sending before B\'s menu loads sends no model', async () => {
    useAiModelPickerStore.setState({ choices: CHOICES });
    useAiModelPickerStore.getState().select('haiku');
    let releaseChoices!: () => void;
    route({
      '/ai/sessions/B/messages': () => emptyStream(),
      '/ai/sessions/B': () => json({ session: { id: 'B', status: 'active', orgId: 'o1' }, messages: [] }),
      '/ai/models/choices/chat': () => new Promise<Response>((r) => { releaseChoices = () => r(json({ data: CHOICES })); }),
    });
    await useAiStore.getState().loadSession('B');
    await useAiStore.getState().sendMessage('hi');
    const body = JSON.parse((messagePosts()[0]![1] as { body: string }).body);
    expect(body.model).toBeUndefined();
    releaseChoices();
  });

  it('startDeviceTask does not carry the previous chat\'s selection into its session', async () => {
    useAiModelPickerStore.setState({ choices: CHOICES });
    useAiModelPickerStore.getState().select('haiku');
    let atCreate: unknown = 'unset';
    route({
      '/ai/sessions': () => { atCreate = useAiModelPickerStore.getState().selection; return json({ id: 'D', orgId: 'o1' }); },
      '/ai/models/choices/chat': () => json({ data: CHOICES }),
    });
    await useAiStore.getState().startDeviceTask('dev1', { type: 'device', id: 'dev1', hostname: 'h' });
    expect(atCreate).toBeNull();
  });

  it('createSession clears a leftover selection when no model is being created with', async () => {
    useAiModelPickerStore.setState({ choices: CHOICES });
    useAiModelPickerStore.getState().select('haiku');
    route({ '/ai/sessions': () => json({ id: 'N', orgId: 'o1' }), '/ai/models/choices/chat': () => json({ data: CHOICES }) });
    await useAiStore.getState().createSession();
    expect(useAiModelPickerStore.getState().selection).toBeNull();
  });

  it('closing the chat drops the selection and reloads the menu for the org (no session)', async () => {
    useAiStore.setState({ pageContext: { type: 'device', id: 'd', hostname: 'h', orgId: 'o7' } });
    useAiModelPickerStore.setState({ choices: CHOICES });
    useAiModelPickerStore.getState().select('haiku');
    route({ '/ai/sessions/A': () => json({}), '/ai/models/choices/chat': () => json({ data: CHOICES }) });
    await useAiStore.getState().closeSession();
    expect(useAiModelPickerStore.getState().selection).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/ai/models/choices/chat?orgId=o7'));
  });
});

describe('coded 409s remove the optimistic user bubble', () => {
  it.each(['turn_in_progress', 'model_unavailable', 'topology_model_changed'])('%s', async (code) => {
    useAiModelPickerStore.setState({ choices: CHOICES });
    route({
      '/ai/sessions/A/messages': () => json({ error: 'nope', code }, 409),
      '/ai/models/choices/chat': () => json({ data: CHOICES }),
    });
    await useAiStore.getState().sendMessage('hello');
    const s = useAiStore.getState();
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(0);
    expect(s.errorCode).toBe(code);
    expect(s.error).toBeTruthy();
    expect(s.isStreaming).toBe(false);
  });

  it('turn_in_progress keeps the picker selection for the retry', async () => {
    useAiModelPickerStore.setState({ choices: CHOICES });
    useAiModelPickerStore.getState().select('haiku');
    route({ '/ai/sessions/A/messages': () => json({ error: 'busy', code: 'turn_in_progress' }, 409) });
    await useAiStore.getState().sendMessage('hello');
    expect(useAiModelPickerStore.getState().selection?.offeringId).toBe('haiku');
  });
});
