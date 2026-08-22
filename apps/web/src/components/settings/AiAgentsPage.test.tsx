import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

// Partner scope comes from the JWT claims and the org context from the org
// store — the same pair `useDefaultOwnerScope` reads (#1724 / #2126).
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
  useOrgStore: (sel?: (s: typeof orgState.current) => unknown) => (sel ? sel(orgState.current) : orgState.current),
}));

import AiAgentsPage from './AiAgentsPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PARTNER_AGENT = {
  id: 'a1',
  kind: 'triage' as const,
  name: 'Triage',
  enabled: true,
  mode: 'shadow' as const,
  orgId: null,
  partnerId: 'p-1',
  ownerScope: 'partner' as const,
  allOrgs: true,
  supportedModes: ['off', 'shadow'] as Array<'off' | 'shadow' | 'act'>,
  disabledAt: null,
  triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true },
  recipients: { userIds: [], roleIds: [] },
};

function mockEndpoints(agents: unknown[] = [PARTNER_AGENT]) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: agents }));
    if (url === '/roles') return Promise.resolve(json({ roles: [{ id: 'r-1', name: 'Org Admin' }] }));
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

describe('AiAgentsPage', () => {
  it('lists agents and badges the partner-wide ones', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-row-a1')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-allorgs-a1')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, false, 500));
    render(<AiAgentsPage />);

    await waitFor(() => expect(screen.getByText('Could not load agents.')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agents-empty')).toBeNull();
  });

  it("leaves the 'act' mode option disabled until the API supports it", async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    expect(await screen.findByTestId('ai-agent-mode-act')).toBeDisabled();
  });

  it('offers the owner-scope selector on create and never on edit', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));
    expect(await screen.findByTestId('ai-agent-ownerscope')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-ownerscope')).toBeNull());
  });

  it('hides the owner-scope selector entirely from an org-scope session', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: 'p-1', orgId: 'org-1' });
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    await screen.findByTestId('ai-agent-editor');
    expect(screen.queryByTestId('ai-agent-ownerscope')).toBeNull();
  });

  it('only offers kinds that do not already have an active agent', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    const kind = await screen.findByTestId('ai-agent-kind');
    const options = [...kind.querySelectorAll('option')].map((option) => option.value);
    // `triage` is taken by PARTNER_AGENT — the unique index would reject it.
    expect(options).toEqual(['patch', 'helpdesk']);
  });

  it('refuses to save with no alert severity selected, and does not call the API', async () => {
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    fireEvent.change(await screen.findByTestId('ai-agent-name'), { target: { value: 'Triage' } });
    // Defaults are critical + high; clearing both leaves the server-side
    // `.min(1)` unsatisfiable.
    fireEvent.click(screen.getByTestId('ai-agent-severity-critical'));
    fireEvent.click(screen.getByTestId('ai-agent-severity-high'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() => expect(screen.getByTestId('ai-agent-issues')).toBeInTheDocument());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('posts a partner-wide create with no orgId and the selected role recipients', async () => {
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    fireEvent.change(await screen.findByTestId('ai-agent-name'), { target: { value: 'Triage' } });
    fireEvent.click(screen.getByTestId('ai-agent-owner-partner'));
    fireEvent.click(await screen.findByTestId('ai-agent-role-r-1'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(post?.[0]).toBe('/ai/agents');
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(body.ownerScope).toBe('partner');
    expect(body.orgId).toBeUndefined();
    // Role IDs, never role names — roles are tenant-scoped rows with custom names.
    expect(body.recipients).toEqual({ roleIds: ['r-1'] });
  });

  it('requires a confirming second click before disabling an agent', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    fireEvent.click(await screen.findByTestId('ai-agent-disable'));
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);

    fireEvent.click(screen.getByTestId('ai-agent-disable'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
      ).toBe(true),
    );
  });
});
