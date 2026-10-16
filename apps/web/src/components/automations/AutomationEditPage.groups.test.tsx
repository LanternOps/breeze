import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

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

const ORG = '22222222-2222-4222-8222-222222222222';

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const automation = (over: Record<string, unknown>) => ({
  id: 'automation-1',
  name: 'Tidy up',
  trigger: { type: 'manual' },
  conditions: { type: 'groups', groupIds: ['g-1'] },
  actions: [{ type: 'run_script', scriptId: 's1' }],
  onFailure: 'stop',
  notificationTargets: { channelIds: [] },
  managedByAgentId: null,
  ...over,
});

function mockEndpoints(row: unknown, put?: Response) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/automations/automation-1' && init?.method === 'PUT') return Promise.resolve(put ?? json({}));
    if (url === '/automations/automation-1') return Promise.resolve(json({ automation: row }));
    if (url.startsWith('/device-groups')) {
      return Promise.resolve(json({ data: [{ id: 'g-1', name: 'Front desk', type: 'static', filterFieldsUsed: [], deviceCount: 2 }] }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  orgState.current = { ...orgState.current, currentOrgId: null };
});

describe('AutomationEditPage group targets (#8599)', () => {
  it('scopes the group picker to the stored owner org and keeps a saved groups target', async () => {
    mockEndpoints(automation({ orgId: ORG, partnerId: null }));
    render(<AutomationEditPage automationId="automation-1" />);

    expect(await screen.findByRole('checkbox', { name: /Front desk/ })).toBeChecked();
    expect(fetchMock.mock.calls.some(([url]) => url === `/device-groups?orgId=${ORG}`)).toBe(true);
    expect(screen.queryByTestId('automation-target-partner-blocked')).toBeNull();
  });

  it('shows a blocking notice for a stored partner-wide automation that targets groups', async () => {
    mockEndpoints(automation({ orgId: null, partnerId: 'p-1' }));
    render(<AutomationEditPage automationId="automation-1" />);

    expect(await screen.findByTestId('automation-target-partner-blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeDisabled();
  });

  it('renders an INVALID_TARGET rejection as a readable error', async () => {
    mockEndpoints(
      automation({ orgId: ORG, partnerId: null }),
      json(
        { error: 'Device group(s) not found in this automation\'s organization: g-9', code: 'INVALID_TARGET', groupIds: ['g-9'] },
        400,
      ),
    );
    render(<AutomationEditPage automationId="automation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Save Changes/i }));

    await waitFor(() => {
      expect(screen.getByText(/The device target is invalid/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/g-9/)).toBeInTheDocument();
  });
});
