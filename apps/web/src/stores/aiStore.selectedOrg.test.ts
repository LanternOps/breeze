/**
 * #9529 — a chat opened from a page with no device/topology context ignored
 * the organization selected in the header. `createSession` POSTed only
 * `{ pageContext, approvalMode }`, so a partner-scope session fell through to
 * the server's `accessibleOrgIds[0]`: whichever customer org sorted first.
 *
 * The store must send the selected org as `orgId` when nothing on the page
 * names an org of its own, and send nothing when there is no selection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

const orgState = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => orgState } }));

import { fetchWithAuth } from './auth';
import { useAiStore } from './aiStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const ORG_C = 'cccccccc-1111-4222-8333-444455556666';
const DEVICE_C = 'dddddddd-1111-4222-8333-444455556666';

const makeResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 201 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Body of the POST /ai/sessions call. */
function createBody(): Record<string, unknown> {
  const call = fetchWithAuthMock.mock.calls.find(([url, init]) => url === '/ai/sessions' && init?.method === 'POST');
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]!.body));
}

describe('ai store createSession sends the header-selected org (#9529)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orgState.currentOrgId = ORG_B;
    fetchWithAuthMock.mockImplementation(async (url: string) =>
      url === '/ai/sessions'
        ? makeResponse({ id: 'sess-1', orgId: ORG_B, delegantM365ConnectionId: null })
        : makeResponse({}),
    );
    useAiStore.setState({
      sessionId: null,
      sessionOrgId: null,
      messages: [],
      pageContext: null,
      selectedM365ConnectionId: null,
      error: null,
      isLoading: false,
    });
  });

  it('sends the selected org when the page has no context', async () => {
    await useAiStore.getState().createSession();

    expect(createBody()).toMatchObject({ orgId: ORG_B });
    expect(useAiStore.getState().sessionOrgId).toBe(ORG_B);
  });

  it('sends the selected org for a non-device page context (alert, dashboard, custom)', async () => {
    useAiStore.setState({ pageContext: { type: 'custom', label: 'Vulnerabilities', data: {} } });

    await useAiStore.getState().createSession();

    expect(createBody()).toMatchObject({ orgId: ORG_B, pageContext: { type: 'custom', label: 'Vulnerabilities' } });
  });

  it('sends no orgId when no org is selected (partner on All organizations)', async () => {
    orgState.currentOrgId = null;

    await useAiStore.getState().createSession();

    expect(createBody()).not.toHaveProperty('orgId');
  });

  it('sends no orgId on a device page: the server anchors to the device org (#5593)', async () => {
    useAiStore.setState({ pageContext: { type: 'device', id: DEVICE_C, hostname: 'WS-C', orgId: ORG_C } });

    await useAiStore.getState().createSession();

    expect(createBody()).not.toHaveProperty('orgId');
  });

  it('sends no orgId for a device-bound task (startDeviceTask)', async () => {
    await useAiStore.getState().startDeviceTask(DEVICE_C, { type: 'device', id: DEVICE_C, hostname: 'WS-C', orgId: ORG_C });

    expect(createBody()).toMatchObject({ deviceId: DEVICE_C });
    expect(createBody()).not.toHaveProperty('orgId');
  });

  it('sends the selected org alongside an M365 connection: the server binds only a connection from that org', async () => {
    useAiStore.setState({ selectedM365ConnectionId: 'conn-1' });

    await useAiStore.getState().createSession();

    expect(createBody()).toMatchObject({ orgId: ORG_B, delegantM365ConnectionId: 'conn-1' });
  });
});
