import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_ACTING_KINDS } from '@breeze/shared';
import ApprovalsInbox from './ApprovalsInbox';
import { fetchWithAuth } from '../../stores/auth';

// #9939: request-count contract for the inbox's mount. Every load used to fire
// one `GET /ai/agents/graduation` per acting kind per supervised org — each a
// 404 on a deployment where policy-decide is dark (the default), where the
// "Approve and always allow" affordance can never render anyway — and fetched
// `/approvals/pending` a second time the moment the event stream first
// connected, treating the FIRST connect as a reconnect.

const state = vi.hoisted(() => ({
  connected: false,
  policyDecide: { enabled: false, loaded: true },
  canReadAiAgents: true,
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: state.connected, subscribe: vi.fn(), unsubscribe: vi.fn() }),
}));
vi.mock('../../stores/featuresStore', () => ({
  useAiAgentsPolicyDecideGate: () => state.policyDecide,
}));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: [],
    can: (resource: string, action: string) =>
      resource === 'ai_agents' && action === 'read' ? state.canReadAiAgents : true,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const response = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const supervisedAgentCard = (id: string, orgId: string) => ({
  id,
  requestingClientLabel: 'Patch Sweep',
  requestingMachineLabel: null,
  actionLabel: 'Install patches',
  actionToolName: 'manage_patches',
  actionArguments: { action: 'install' },
  riskTier: 'medium',
  riskSummary: 'Installs pending patches',
  customerTenant: null,
  status: 'pending',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  decidedAt: null,
  decisionReason: null,
  executionId: null,
  intentId: `intent-${id}`,
  approvalScope: 'supervised',
  isRecursive: false,
  createdAt: '2026-10-23T12:00:00.000Z',
  origin: 'ai_agent',
  agentName: 'Patch Sweep',
  orgId,
  orgName: `Org ${orgId}`,
  action: 'install',
  targetDevice: { id: `device-${id}`, hostname: `HOST-${id}` },
});

const APPROVALS = [supervisedAgentCard('ap-a', 'org-1'), supervisedAgentCard('ap-b', 'org-2')];

const callsTo = (fragment: string) =>
  fetchMock.mock.calls.filter(([url]) => {
    const path = String(url);
    return path.includes(fragment);
  });
/** `/approvals/pending?…` only — not `/approvals/pending/count`. */
const pendingListCalls = () =>
  fetchMock.mock.calls.filter(([url]) => /\/approvals\/pending\?/.test(String(url)));
const graduationCalls = () => callsTo('/ai/agents/graduation');

beforeEach(() => {
  vi.clearAllMocks();
  state.connected = false;
  state.policyDecide = { enabled: false, loaded: true };
  state.canReadAiAgents = true;
  fetchMock.mockImplementation((async (url: string) => {
    const raw = String(url);
    if (raw.includes('/approvals/pending/count')) return response({ count: APPROVALS.length });
    if (raw.includes('/ai/agents/graduation')) {
      return response({ error: 'No active agent policy for this organization/kind' }, false, 404);
    }
    return response({ approvals: APPROVALS, nextCursor: null });
  }) as unknown as typeof fetchWithAuth);
});

/** Lets every queued microtask/effect settle so a fetch that WOULD fire has. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('ApprovalsInbox — request count on load (#9939)', () => {
  it('fires no graduation GETs while policy-decide is dark', async () => {
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');
    await settle();

    expect(graduationCalls()).toHaveLength(0);
    expect(screen.queryByTestId('approval-always-allow-ap-a')).not.toBeInTheDocument();
  });

  it('fires no graduation GETs while the policy-decide flag is still loading', async () => {
    state.policyDecide = { enabled: false, loaded: false };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');
    await settle();

    expect(graduationCalls()).toHaveLength(0);
  });

  it('fires no graduation GETs for a viewer without ai_agents:read (the route would 403)', async () => {
    state.policyDecide = { enabled: true, loaded: true };
    state.canReadAiAgents = false;
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');
    await settle();

    expect(graduationCalls()).toHaveLength(0);
  });

  it('reads graduation once per (org, acting kind) when policy-decide is on and the viewer may read it', async () => {
    state.policyDecide = { enabled: true, loaded: true };
    render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    await waitFor(() => expect(graduationCalls()).toHaveLength(2 * AI_AGENT_ACTING_KINDS.length));
  });

  it('starts the graduation read once the flag resolves on, without re-reading on later renders', async () => {
    state.policyDecide = { enabled: false, loaded: false };
    const { rerender } = render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');
    await settle();
    expect(graduationCalls()).toHaveLength(0);

    state.policyDecide = { enabled: true, loaded: true };
    rerender(<ApprovalsInbox />);
    await waitFor(() => expect(graduationCalls()).toHaveLength(2 * AI_AGENT_ACTING_KINDS.length));

    rerender(<ApprovalsInbox />);
    await settle();
    expect(graduationCalls()).toHaveLength(2 * AI_AGENT_ACTING_KINDS.length);
  });

  it('fetches /approvals/pending once when the event stream connects for the first time', async () => {
    const { rerender } = render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');
    expect(pendingListCalls()).toHaveLength(1);

    state.connected = true;
    rerender(<ApprovalsInbox />);
    await settle();

    expect(pendingListCalls()).toHaveLength(1);
  });

  it('still refetches /approvals/pending on a genuine reconnect after an outage', async () => {
    const { rerender } = render(<ApprovalsInbox />);
    await screen.findByTestId('approval-row-ap-a');

    state.connected = true;
    rerender(<ApprovalsInbox />);
    await settle();
    state.connected = false;
    rerender(<ApprovalsInbox />);
    await settle();
    expect(pendingListCalls()).toHaveLength(1);

    state.connected = true;
    rerender(<ApprovalsInbox />);
    await waitFor(() => expect(pendingListCalls()).toHaveLength(2));
  });
});
