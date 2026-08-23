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

const ORG_AGENT = {
  ...PARTNER_AGENT,
  id: 'a2',
  kind: 'patch' as const,
  name: 'Org patcher',
  orgId: 'org-1',
  partnerId: null,
  ownerScope: 'organization' as const,
  allOrgs: false,
};

function mockEndpoints(agents: unknown[] = [PARTNER_AGENT]) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: agents }));
    // The real route answers { data }, not { roles } — mocking the dead branch
    // is how the production branch stayed untested.
    if (url === '/roles') return Promise.resolve(json({ data: [{ id: 'r-1', name: 'Org Admin' }] }));
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
  it('badges the partner-wide agent and NOT the org-owned one', async () => {
    // Two rows on purpose: with a partner-wide-only fixture this passed even
    // with the `allOrgs &&` guard deleted, i.e. with every org-owned agent
    // mislabelled "All orgs".
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-row-a1')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-allorgs-a1')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-row-a2')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-allorgs-a2')).toBeNull();
  });

  it('treats a malformed 200 body as an error, never as "no agents"', async () => {
    // A gateway error page or a shape change must not render as an empty
    // tenant — that also told the create form every kind was free.
    fetchMock.mockImplementation((url: string) =>
      url.startsWith('/ai/agents')
        ? Promise.resolve(json({ unexpected: true }))
        : Promise.resolve(json({ data: [] })),
    );
    render(<AiAgentsPage />);

    await waitFor(() => expect(screen.getByText('Could not load agents.')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agents-empty')).toBeNull();
    expect(screen.queryByTestId('ai-agents-loading')).toBeNull();
  });

  it('surfaces a load failure instead of rendering an empty list', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, false, 500));
    render(<AiAgentsPage />);

    await waitFor(() => expect(screen.getByText('Could not load agents.')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agents-empty')).toBeNull();
  });

  it("disables the 'act' mode option when the API does not list it", async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-mode-act')).toBeDisabled();
  });

  it("ENABLES 'act' as soon as the API reports it in supportedModes", async () => {
    // The create-form version of this assertion was vacuous: with agent=null it
    // evaluated a hardcoded fallback, so it would have kept passing on the day
    // wave 4 shipped while the form stayed unable to select 'act'.
    mockEndpoints([{ ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] }]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-mode-act')).not.toBeDisabled();
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

  it('only offers kinds free for the OWNER being created into', async () => {
    // Uniqueness is (partner_id, kind) and (org_id, kind) independently. A flat
    // taken-list hid `triage` from the partner-wide form as soon as any single
    // org owned a triage agent — and with no partner baseline,
    // resolveEffectiveAgent returns null, so triage died for every org.
    // A concrete org must be selected, or "this organization" has no owner to
    // check against (save() blocks that case separately).
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    // Org axis (the default with an org selected): org-1 owns `patch`; the
    // partner-wide `triage` must NOT block an org-level triage override.
    const kind = await screen.findByTestId('ai-agent-kind');
    expect([...kind.querySelectorAll('option')].map((o) => o.value)).toEqual(['triage', 'helpdesk']);

    fireEvent.click(screen.getByTestId('ai-agent-owner-partner'));
    // Partner axis: only the partner-wide `triage` is taken. `patch` belongs to
    // org-1 and must still be offered for the partner-wide baseline — hiding it
    // is what killed the baseline row the whole feature depends on.
    expect(
      [...screen.getByTestId('ai-agent-kind').querySelectorAll('option')].map((o) => o.value),
    ).toEqual(['patch', 'helpdesk']);
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

  it('does not carry a stale draft from one edit target to the next', async () => {
    // The draft is seeded once at mount. Without a key on the form, switching
    // edit targets kept the previous draft and PATCHed the newly-selected
    // agent with the old agent's policy — a silent config overwrite.
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.change(await screen.findByTestId('ai-agent-name'), { target: { value: 'EDITED A1' } });

    fireEvent.click(screen.getByTestId('ai-agent-edit-a2'));
    await waitFor(() => expect(screen.getByTestId('ai-agent-name')).toHaveValue('Org patcher'));

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'),
      ).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch?.[0]).toBe('/ai/agents/a2');
    expect(JSON.parse((patch?.[1] as RequestInit).body as string).name).toBe('Org patcher');
  });

  it('says roles could not be loaded rather than claiming none exist', async () => {
    // This page needs organizations:read but GET /roles needs users:read, so a
    // 403 here is reachable. Rendering it as "no roles available" would turn an
    // authorization error into a config decision the operator never made.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [] }));
      if (url === '/roles') return Promise.resolve(json({ error: 'forbidden' }, false, 403));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    expect(await screen.findByTestId('ai-agent-roles-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-roles-empty')).toBeNull();
  });

  it('keeps a cleared numeric limit as a number the server will accept', async () => {
    // Clearing a number input yields '' -> NaN, which JSON.stringify emits as
    // null and the server rejects with a bare 400.
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    fireEvent.change(await screen.findByTestId('ai-agent-name'), { target: { value: 'Triage' } });
    fireEvent.change(screen.getByTestId('ai-agent-limit-devices'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
      ).toBe(true),
    );
    const post = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
    expect(Number.isFinite(body.limits.maxDevicesPerRun)).toBe(true);
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
