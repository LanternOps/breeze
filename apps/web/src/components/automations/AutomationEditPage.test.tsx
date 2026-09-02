import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const { getJwtClaimsMock, orgState } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null }),
  ),
  orgState: {
    current: {
      currentOrgId: null as string | null,
      allOrgs: true,
      error: null as string | null,
      organizationsLoaded: true,
      organizations: [{ id: 'org-1', name: 'Acme' }],
    },
  },
}));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (state: typeof orgState.current) => unknown) =>
    selector ? selector(orgState.current) : orgState.current,
}));

import AutomationEditPage from './AutomationEditPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const baseAutomation = {
  id: 'automation-1',
  name: 'Triage critical alerts',
  description: 'Handles incoming critical alerts',
  trigger: { type: 'event', eventType: 'alert.triggered' },
  conditions: [],
  onFailure: 'stop',
  notificationTargets: { channelIds: [] },
};

function mockEndpoints(automation: unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/automations/automation-1') {
      return Promise.resolve(json({ automation }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
  orgState.current = {
    currentOrgId: null,
    allOrgs: true,
    error: null,
    organizationsLoaded: true,
    organizations: [{ id: 'org-1', name: 'Acme' }],
  };
});

describe('AutomationEditPage managed automations', () => {
  it('renders a read-only notice instead of the editor for a managed automation', async () => {
    mockEndpoints({
      ...baseAutomation,
      managedByAgentId: 'agent-1',
      actions: [{ type: 'ai_triage' }],
    });

    render(<AutomationEditPage automationId="automation-1" />);

    expect(await screen.findByTestId('automation-managed-notice')).toBeInTheDocument();
    expect(screen.getByText('Managed by AI agent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeNull();
  });

  it('renders the editor for an unmanaged automation', async () => {
    mockEndpoints({
      ...baseAutomation,
      managedByAgentId: null,
      actions: [{ type: 'run_script', scriptId: 's1' }],
    });

    render(<AutomationEditPage automationId="automation-1" />);

    expect(await screen.findByRole('button', { name: /Save Changes/i })).toBeInTheDocument();
    expect(screen.queryByTestId('automation-managed-notice')).toBeNull();
  });
});
