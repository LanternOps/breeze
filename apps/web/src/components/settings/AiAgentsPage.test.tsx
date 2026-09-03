import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// P2-4 (#4191) review fix — ticket-triggered runs are admitted with
// `kind: 'helpdesk'` (ticketHelpdeskSubscriber.ts's `admitTriageRun`,
// `createAndEnqueueAgentRun({ kind: 'helpdesk', ... })`), and runService.ts
// resolves the effective policy off THAT kind — never `triage` (the
// scheduled-sweeps kind, a different gate entirely). `ticketAutonomousWrites`
// can therefore only ever take effect on a `helpdesk`-kind, ORG-owned row.
const ORG_HELPDESK_AGENT = {
  ...PARTNER_AGENT,
  id: 'a3',
  kind: 'helpdesk' as const,
  name: 'Org helpdesk',
  orgId: 'org-1',
  partnerId: null,
  ownerScope: 'organization' as const,
  allOrgs: false,
};

const PARTNER_HELPDESK_AGENT = {
  ...PARTNER_AGENT,
  id: 'a4',
  kind: 'helpdesk' as const,
  name: 'Partner helpdesk',
};

function mockEndpoints(agents: unknown[] = [PARTNER_AGENT]) {
  fetchMock.mockImplementation((url: string) => {
    // Registered BEFORE the generic '/ai/agents' prefix check below — that
    // check's startsWith would otherwise swallow this literal path too and
    // hand the agents LIST back as the policy-key registry, since
    // '/ai/agents/policy-decidable-keys'.startsWith('/ai/agents') is true.
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
    // Same swallowing hazard as the line above, and the reason the schedules
    // section (P2-2, #4189) validates ROW shape and not just array shape:
    // '/ai/agents/schedules?agentId=…'.startsWith('/ai/agents') is true, so
    // without this the editor was handed the AGENTS list as its schedules.
    if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
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

  it("enables the 'act' mode option once the API reports it in supportedModes (#3826 Task 8)", async () => {
    mockEndpoints([{ ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] }]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-mode-act')).not.toBeDisabled();
  });

  it("does NOT permanently disable the 'act' mode option on the CREATE form — falls back to SUPPORTED_AGENT_MODES, not [] (final-review fix, #3826)", async () => {
    // Create has no `agent` DTO yet (agent === null until the first save), so
    // there is no `supportedModes` to read from a real row — the form must
    // fall back to the shared `SUPPORTED_AGENT_MODES` constant, not an empty
    // array, or an operator can never create an act-mode agent through the UI
    // even once the API accepts one.
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-create-button'));
    fireEvent.click(screen.getByTestId('ai-agent-create-button'));

    expect(await screen.findByTestId('ai-agent-mode-act')).not.toBeDisabled();
  });

  it('shows the act warning banner and requires acknowledgement before saving a transition into act mode', async () => {
    mockEndpoints([{ ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] }]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    // Not shown before the operator has selected act.
    expect(screen.queryByTestId('ai-agent-act-warning')).toBeNull();

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));

    expect(await screen.findByTestId('ai-agent-act-warning')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-act-ack')).not.toBeChecked();
    expect(screen.getByTestId('ai-agent-save')).toBeDisabled();

    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    expect(screen.getByTestId('ai-agent-save')).not.toBeDisabled();
  });

  it('does not require the acknowledgement to save an agent that is already in act mode', async () => {
    const actAgent = { ...PARTNER_AGENT, mode: 'act' as const, supportedModes: ['off', 'shadow', 'act'] as const };
    mockEndpoints([actAgent]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-act-warning')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-save')).not.toBeDisabled();
  });

  it('surfaces the act_prerequisites_not_met 422 body as structured issues', async () => {
    const actAgent = { ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/a1' && init?.method === 'PATCH') {
        return Promise.resolve(
          json(
            {
              error: 'act_prerequisites_not_met: recipient, act_eligible_tool',
              code: 'act_prerequisites_not_met',
              missing: ['recipient', 'act_eligible_tool'],
            },
            false,
            422,
          ),
        );
      }
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [actAgent] }));
      if (url === '/roles') return Promise.resolve(json({ data: [{ id: 'r-1', name: 'Org Admin' }] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() => expect(screen.getByTestId('ai-agent-issues')).toBeInTheDocument());
    expect(
      screen.getByText('Add at least one notification recipient before enabling act mode.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Allow at least one act-eligible tool, or authorize a script, before enabling act mode.',
      ),
    ).toBeInTheDocument();
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
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
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

  it('renders supervisedActionKeys grouped by tool from the registry, only in act mode, and includes selections in the save body (wave 5 Part B, #3827)', async () => {
    const actAgent = { ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };
    const registry = [
      { key: 'manage_services:restart', toolName: 'manage_services', action: 'restart', note: 'Restarts a service.' },
      { key: 'manage_services:stop', toolName: 'manage_services', action: 'stop', note: 'Stops a service.' },
      { key: 'security_scan:quarantine', toolName: 'security_scan', action: 'quarantine', note: 'Quarantines a threat.' },
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: registry }));
      if (url === '/ai/agents/a1' && init?.method === 'PATCH') return Promise.resolve(json({ data: actAgent }));
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [actAgent] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    // Not offered before the operator has selected act — matches the
    // existing act-warning gating pattern.
    expect(screen.queryByTestId('ai-agent-supervised-key-manage_services:restart')).toBeNull();

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));

    expect(await screen.findByTestId('ai-agent-supervised-key-manage_services:restart')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:stop')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-supervised-key-security_scan:quarantine')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-supervised-key-manage_services:restart'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    const body = JSON.parse((patch?.[1] as RequestInit).body as string);
    expect(body.actAssets).toEqual({ supervisedActionKeys: ['manage_services:restart'] });
  });

  it('surfaces the invalid_supervised_action_keys 422 body as structured, per-key issues (wave 5 Part B, #3827)', async () => {
    const actAgent = { ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
      if (url === '/ai/agents/a1' && init?.method === 'PATCH') {
        return Promise.resolve(
          json(
            {
              error: 'invalid_supervised_action_keys: bogus_key',
              code: 'invalid_supervised_action_keys',
              rejected: [{ key: 'bogus_key', reason: 'not registered in POLICY_DECIDABLE_TIER3' }],
            },
            false,
            422,
          ),
        );
      }
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [actAgent] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() => expect(screen.getByTestId('ai-agent-issues')).toBeInTheDocument());
    expect(screen.getByText('bogus_key: not registered in POLICY_DECIDABLE_TIER3')).toBeInTheDocument();
  });

  it('says the policy-decidable action list could not be loaded rather than rendering an empty registry', async () => {
    const actAgent = { ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ error: 'nope' }, false, 500));
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [actAgent] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));

    expect(await screen.findByTestId('ai-agent-policy-keys-failed')).toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// #4187 UI critique — the mode control, the first-run panel, and the drawer.
// ---------------------------------------------------------------------------

const ACT_AGENT = { ...PARTNER_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };

/** The three-key policy registry every act-mode test below shares. */
const REGISTRY = [
  { key: 'manage_services:restart', toolName: 'manage_services', action: 'restart', note: 'Restarts a service.' },
  { key: 'manage_services:stop', toolName: 'manage_services', action: 'stop', note: 'Stops a service.' },
  { key: 'security_scan:quarantine', toolName: 'security_scan', action: 'quarantine', note: 'Quarantines a threat.' },
];

function mockActEndpoints(agent: unknown = ACT_AGENT, registry: unknown[] = REGISTRY) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: registry }));
    if (url === '/ai/agents/a1' && init?.method === 'PATCH') return Promise.resolve(json({ data: agent }));
    if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [agent] }));
    if (url === '/roles') return Promise.resolve(json({ data: [] }));
    return Promise.resolve(json({ data: [] }));
  });
}

function lastPatchBody() {
  const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
  return JSON.parse((patch?.[1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('AiAgentsPage mode radiogroup (#4187 UI critique)', () => {
  it('renders mode as a three-option radiogroup whose selection reflects the stored mode', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    const group = await screen.findByTestId('ai-agent-mode');
    expect(group).toHaveAttribute('role', 'radiogroup');
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(3);
    // PARTNER_AGENT is stored as `shadow`.
    expect(screen.getByTestId('ai-agent-mode-shadow')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'false');
    // Roving tabindex: exactly one tab stop, on the selected option.
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('moves the selection with the arrow keys, wrapping at both ends', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    const group = await screen.findByTestId('ai-agent-mode');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'true');

    // Wraps forward from the last option back to the first.
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(group, { key: 'Home' });
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('aria-checked', 'true');
  });

  // Review fix (#4187 UI critique, P3): `onModeKeyDown` moves selection AND
  // is documented as moving focus (the roving-tabindex pattern requires
  // both), but nothing previously asserted the focus half — a regression
  // that moved selection without calling `.focus()` would have passed every
  // other test here.
  it('moves DOM focus together with the selection on every arrow/Home/End key, wrapping at both ends', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    const group = await screen.findByTestId('ai-agent-mode');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('ai-agent-mode-act'));

    // Wraps forward from the last option back to the first.
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByTestId('ai-agent-mode-off'));

    // Wraps backward from the first option to the last.
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByTestId('ai-agent-mode-act'));

    fireEvent.keyDown(group, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByTestId('ai-agent-mode-off'));

    fireEvent.keyDown(group, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('ai-agent-mode-act'));
  });

  // Review fix (#4187 UI critique, P3): a stale row can have its CHECKED
  // option itself disabled — an agent saved while `act` was supported, whose
  // partner later lost act eligibility, still stores `mode: 'act'`. The old
  // `tabIndex={selected ? 0 : -1}` left every radio at -1 in that case,
  // making the whole group unreachable by keyboard (Tab skips it entirely).
  it('falls back the roving tab stop to the first ENABLED option when the checked option is itself disabled', async () => {
    const staleActAgent = { ...PARTNER_AGENT, mode: 'act' as const, supportedModes: ['off', 'shadow'] as const };
    mockEndpoints([staleActAgent]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    const group = await screen.findByTestId('ai-agent-mode');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-agent-mode-act')).toBeDisabled();

    const radios = within(group).getAllByRole('radio');
    expect(radios.filter((radio) => radio.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('tabindex', '-1');
  });

  it('never lands on the act option with the arrow keys when the API does not support it', async () => {
    // `PARTNER_AGENT.supportedModes` is ['off','shadow'] — the disabled card
    // has to be skipped by the keyboard too, not just unclickable.
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    const group = await screen.findByTestId('ai-agent-mode');

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(group, { key: 'End' });
    expect(screen.getByTestId('ai-agent-mode-shadow')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'false');
  });

  // Review fix (#4187 UI critique, P2): the ORIGINAL Riley bug was that
  // leaving act only HID the fieldset while Save still submitted keys the
  // operator could no longer see. The FIRST fix over-corrected — it cleared
  // `supervisedActionKeys` from the draft on the way out of act, so an
  // act -> shadow -> act round trip silently lost a persisted grant list the
  // operator never touched. The keys now stay in the draft the whole time;
  // only the SAVE PAYLOAD omits them while the mode isn't act.
  it('keeps supervisedActionKeys in the draft across an act -> shadow -> act round trip, and omits them from Save only while not in act', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));
    fireEvent.click(await screen.findByTestId('ai-agent-supervised-key-manage_services:restart'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:restart')).toBeChecked();

    fireEvent.click(screen.getByTestId('ai-agent-mode-shadow'));

    // Announced: Save will not carry these keys while the mode stays shadow.
    expect(await screen.findByTestId('ai-agent-act-keys-cleared')).toBeInTheDocument();
    // The acknowledgement still resets — a genuine re-entry into act must ask
    // again — but the KEY SELECTION itself is restored, not re-blanked.
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    expect(screen.getByTestId('ai-agent-act-ack')).not.toBeChecked();
    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:restart')).toBeChecked();
    // Mounted unconditionally (see the dedicated test below) — back in act
    // mode there is nothing to omit, so the text is empty rather than absent.
    expect(screen.getByTestId('ai-agent-act-keys-cleared')).toHaveTextContent('');

    // Saving from shadow omits the keys even though the draft still holds
    // them — the draft is a form of "remembered while not in effect", never
    // wire truth for a mode that cannot use them.
    fireEvent.click(screen.getByTestId('ai-agent-mode-shadow'));
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
    );
    const body = lastPatchBody();
    expect(body.mode).toBe('shadow');
    expect(body.actAssets).toEqual({ supervisedActionKeys: [] });
  });

  it('does not claim keys will be omitted when there were none to omit', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-mode-off'));

    // Review fix (#4187 UI critique, P3): the status region is now mounted
    // UNCONDITIONALLY (see the radiogroup test below) so a screen reader
    // hears the FIRST announcement too — an aria-live region only announces
    // changes to content that was already in the DOM when it changed. So
    // "not shown" is now "present with no text", not "absent".
    const status = screen.getByTestId('ai-agent-act-keys-cleared');
    expect(status).toHaveTextContent('');
  });

  // Review fix (#4187 UI critique, P3): `role="status"` mounted only once
  // there was something to say, so the FIRST thing it ever announced was
  // never heard — an aria-live region has to already be in the accessibility
  // tree before its content changes for assistive tech to pick up the
  // change. The element must always be there; only its text toggles.
  it('mounts the act-keys status region unconditionally, gating only its text', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    // Present even before act mode has ever been touched.
    const status = await screen.findByTestId('ai-agent-act-keys-cleared');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('');

    fireEvent.click(await screen.findByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-supervised-key-manage_services:restart'));
    fireEvent.click(screen.getByTestId('ai-agent-mode-shadow'));

    expect(screen.getByTestId('ai-agent-act-keys-cleared')).toHaveTextContent(/.+/);
  });

  it('explains that `enabled` and the mode are two gates', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-enabled-hint')).toBeInTheDocument();
  });
});

describe('AiAgentsPage first run and drawer (#4187 UI critique)', () => {
  it('replaces the bare "no agents" line with a first-run panel that opens the create form', async () => {
    mockEndpoints([]);
    render(<AiAgentsPage />);

    const empty = await screen.findByTestId('ai-agents-empty');
    // Every kind is named, so an operator learns what is on offer before
    // being asked to pick one.
    expect(within(empty).getByText('Alert triage')).toBeInTheDocument();
    expect(within(empty).getByText('Patching')).toBeInTheDocument();
    expect(within(empty).getByText('Help desk')).toBeInTheDocument();

    fireEvent.click(within(empty).getByTestId('ai-agents-empty-create'));
    expect(await screen.findByTestId('ai-agent-editor')).toBeInTheDocument();
    // New agents start in the safe mode the panel names.
    expect(screen.getByTestId('ai-agent-mode-off')).toHaveAttribute('aria-checked', 'true');
  });

  it('opens the editor in a drawer and leaves the agent list on screen', async () => {
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    expect(await screen.findByTestId('ai-agent-editor-drawer')).toBeInTheDocument();
    // The list is what the inline editor used to push below the fold.
    expect(screen.getByTestId('ai-agents-list')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-row-a2')).toBeInTheDocument();
  });
});

// P2-4 (#4191, Task 12) — the `ticketAutonomousWrites` org-row-only opt-in
// toggle. Same "org override only" posture as `anomalyEnabled` (never
// surfaced on the web form at all): the partner baseline's own value is
// never consulted in either direction (effectivePolicy.ts's merge), so a
// partner-wide row must never let an operator believe toggling it does
// anything.
//
// Review fix (#4191): ticket-triggered runs are admitted with
// `kind: 'helpdesk'` (ticketHelpdeskSubscriber.ts's `admitTriageRun`), and
// runService.ts resolves the effective policy off THAT kind — never
// `triage` (a different, scheduled-sweeps-only gate). Every fixture below
// is `helpdesk`-kind for that reason, EXCEPT the first test, which proves
// a `triage`-kind agent — the exact kind this toggle was originally
// (wrongly) gated on — never renders it at all.
describe('AiAgentsPage ticketAutonomousWrites toggle (P2-4, #4191)', () => {
  it('hides the toggle entirely for a triage-kind agent — ticket runs are admitted as helpdesk, never triage', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    await screen.findByTestId('ai-agent-editor');
    expect(screen.queryByTestId('ai-agent-ticket-autonomous-writes')).toBeNull();
  });

  it('renders the toggle DISABLED for a partner-wide helpdesk agent — it can never take effect there', async () => {
    mockEndpoints([PARTNER_HELPDESK_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a4'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a4'));

    const checkbox = await screen.findByTestId('ai-agent-ticket-autonomous-writes');
    expect(checkbox).toBeDisabled();
  });

  it('renders the toggle CHECKED when the stored org-owned helpdesk agent already opted in', async () => {
    const preset = {
      ...ORG_HELPDESK_AGENT,
      triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true, ticketAutonomousWrites: true },
    };
    mockEndpoints([preset]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a3'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a3'));

    const checkbox = await screen.findByTestId('ai-agent-ticket-autonomous-writes');
    expect(checkbox).not.toBeDisabled();
    expect(checkbox).toBeChecked();
  });

  it('round-trips a toggle flip through to the PATCH body for an org-owned helpdesk agent', async () => {
    const orgAgent = { ...ORG_HELPDESK_AGENT, supportedModes: ['off', 'shadow', 'act'] as const };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
      if (url === '/ai/agents/a3' && init?.method === 'PATCH') return Promise.resolve(json({ data: orgAgent }));
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [orgAgent] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a3'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a3'));

    const checkbox = await screen.findByTestId('ai-agent-ticket-autonomous-writes');
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    const body = JSON.parse((patch?.[1] as RequestInit).body as string);
    expect(body.triggers.ticketAutonomousWrites).toBe(true);
  });
});
