import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

/**
 * Opens the create form however the page currently offers it.
 *
 * While the first-run panel is showing, the header's "New agent" button is
 * deliberately absent — one create affordance at a time — so a test that
 * starts from an empty tenant reaches the panel's own CTA instead.
 */
async function openCreateForm(): Promise<void> {
  // Settle the initial load FIRST. The header button is present while the page
  // is still loading and is replaced by the panel's CTA the moment an empty
  // list arrives, so querying mid-flight can hand back a node that React has
  // already detached — a click on which does nothing at all.
  await waitFor(() => expect(screen.queryByTestId('ai-agents-loading')).toBeNull());
  fireEvent.click(
    screen.queryByTestId('ai-agent-create-button') ?? screen.getByTestId('ai-agents-empty-create'),
  );
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

    await openCreateForm();

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

    await openCreateForm();
    expect(await screen.findByTestId('ai-agent-ownerscope')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-ownerscope')).toBeNull());
  });

  it('hides the owner-scope selector entirely from an org-scope session', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: 'p-1', orgId: 'org-1' });
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await openCreateForm();

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

    await openCreateForm();

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

    await openCreateForm();

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

    await openCreateForm();

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

    await openCreateForm();

    expect(await screen.findByTestId('ai-agent-roles-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-roles-empty')).toBeNull();
  });

  it('keeps a cleared numeric limit as a number the server will accept', async () => {
    // Clearing a number input yields '' -> NaN, which JSON.stringify emits as
    // null and the server rejects with a bare 400.
    mockEndpoints([]);
    render(<AiAgentsPage />);

    await openCreateForm();

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

  it('asks for confirmation in a dialog that names what stops and what is kept, not a relabelled button', async () => {
    // The old ceremony was a label swap ("Disable" -> "Confirm disable") that
    // stayed armed indefinitely and never said what disabling actually does.
    // Disable is a kill switch on an agent that may be running scheduled
    // sweeps for every org, so it gets the same dialog ceremony as revoke.
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    fireEvent.click(await screen.findByTestId('ai-agent-disable'));
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);

    // The consequence sentence, not just a second click.
    expect(await screen.findByText(/future runs stop/i)).toBeInTheDocument();
    expect(screen.getByText(/run history and evidence are kept/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-disable-confirm'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
      ).toBe(true),
    );
  });

  it('cancelling the disable dialog leaves the agent alone', async () => {
    mockEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-disable'));

    // Scoped to the confirm dialog: the form's own Cancel button carries the
    // same label, so a bare getByText would be ambiguous.
    const dialog = (await screen.findByTestId('ai-agent-disable-confirm')).closest('[role="dialog"]');
    fireEvent.click(within(dialog as HTMLElement).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-disable-confirm')).toBeNull());
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
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

    // The glossary is a two-column definition list ABOVE the CTA, not a
    // trailing paragraph under it.
    const glossary = within(empty).getByTestId('ai-agents-kind-glossary');
    expect(glossary.tagName).toBe('DL');

    // One create affordance while the empty state is showing, not two.
    expect(screen.queryByTestId('ai-agent-create-button')).toBeNull();

    fireEvent.click(within(empty).getByTestId('ai-agents-empty-create'));
    expect(await screen.findByTestId('ai-agent-editor')).toBeInTheDocument();
    // New agents start in the safe mode the panel actually names — shadow,
    // where the agent proposes and a person approves. The form used to
    // default to `off` while the panel said "start in shadow mode".
    expect(screen.getByTestId('ai-agent-mode-shadow')).toHaveAttribute('aria-checked', 'true');
    // ...but SWITCHED OFF (P1 review finding). `enabled: true` on create armed
    // the agent the instant Save landed: managedAutomation mirrors `enabled`
    // onto the seeded automation, and shadow passes run admission, so a
    // partner-wide triage create started firing LLM runs across every org
    // before the operator had reviewed the allowlist or the limits.
    expect(screen.getByTestId('ai-agent-enabled')).not.toBeChecked();
    // And the form says so, rather than leaving an unticked box to be read as
    // an oversight.
    expect(screen.getByTestId('ai-agent-enabled-create-hint')).toBeInTheDocument();
  });

  it('does not show the create-only "starts switched off" hint when editing', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    await screen.findByTestId('ai-agent-enabled');
    expect(screen.queryByTestId('ai-agent-enabled-create-hint')).toBeNull();
    // The stored value is what an edit shows — PARTNER_AGENT is enabled.
    expect(screen.getByTestId('ai-agent-enabled')).toBeChecked();
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

// ---------------------------------------------------------------------------
// #4187 UI critique round 2 — disable is a real kill switch with a way back,
// rows lead to their runs, and the page is deep-linkable.
// ---------------------------------------------------------------------------

const DISABLED_AGENT = {
  ...PARTNER_AGENT,
  id: 'a9',
  kind: 'patch' as const,
  name: 'Retired patcher',
  enabled: false,
  disabledAt: '2026-08-01T10:00:00.000Z',
};

/** Like `mockEndpoints`, but answers the re-enable POST too. */
function mockEnableEndpoints(agents: unknown[], enableResponse: () => Promise<Response>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
    if (url.endsWith('/enable') && init?.method === 'POST') return enableResponse();
    if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: agents }));
    if (url === '/roles') return Promise.resolve(json({ data: [] }));
    return Promise.resolve(json({ data: [] }));
  });
}

describe('AiAgentsPage disabled agents (#4187 UI critique)', () => {
  it('asks the list endpoint for disabled rows too', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-row-a1'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('includeDisabled=1'))).toBe(true);
  });

  it('keeps a disabled agent out of the live list and offers it in a Disabled section', async () => {
    mockEndpoints([PARTNER_AGENT, DISABLED_AGENT]);
    render(<AiAgentsPage />);

    const list = await screen.findByTestId('ai-agents-list');
    expect(within(list).getByTestId('ai-agent-row-a1')).toBeInTheDocument();
    expect(within(list).queryByTestId('ai-agent-row-a9')).toBeNull();

    const section = screen.getByTestId('ai-agents-disabled-section');
    expect(within(section).getByTestId('ai-agent-disabled-row-a9')).toBeInTheDocument();
    // Collapsed by default — a retired agent must not compete with the live ones.
    expect(section).not.toHaveAttribute('open');
  });

  it('re-enables a disabled agent and reloads the list', async () => {
    mockEnableEndpoints([PARTNER_AGENT, DISABLED_AGENT], () =>
      Promise.resolve(json({ data: { ...DISABLED_AGENT, disabledAt: null } })));
    render(<AiAgentsPage />);

    await screen.findByTestId('ai-agents-disabled-section');
    fireEvent.click(screen.getByTestId('ai-agent-reenable-a9'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          String(url) === '/ai/agents/a9/enable' && (init as RequestInit | undefined)?.method === 'POST'),
      ).toBe(true),
    );
  });

  it('shows an all-disabled state, not the first-run panel, when every agent is disabled', async () => {
    // The first-run panel used to render whenever the LIVE list was empty, so
    // an operator who had just disabled their only agent was told "No agents
    // yet" while runs and a partner-wide schedule still existed.
    mockEndpoints([DISABLED_AGENT]);
    render(<AiAgentsPage />);

    expect(await screen.findByTestId('ai-agents-all-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agents-empty')).toBeNull();
    // The section is open, because it is the only thing on the page.
    expect(screen.getByTestId('ai-agents-disabled-section')).toHaveAttribute('open');
    // Same one-CTA-at-a-time rule as the first-run panel.
    expect(screen.queryByTestId('ai-agent-create-button')).toBeNull();
    expect(screen.getByTestId('ai-agents-all-disabled-create')).toBeInTheDocument();
  });
});

describe('AiAgentsPage row affordances (#4187 UI critique)', () => {
  it('links each row to that agent’s runs', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    const link = await screen.findByTestId('ai-agent-runs-link-a1');
    expect(link).toHaveAttribute('href', '/ai-agents/runs#agent=a1');
  });

  it('shows the last run outcome when the list carries one', async () => {
    mockEndpoints([{ ...PARTNER_AGENT, lastRunAt: '2026-08-30T12:00:00.000Z', lastRunStatus: 'failed' }]);
    render(<AiAgentsPage />);

    const badge = await screen.findByTestId('ai-agent-lastrun-a1');
    expect(badge).toHaveTextContent('Failed');
  });

  it('says so plainly when an agent has never run', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    expect(await screen.findByTestId('ai-agent-lastrun-a1')).toHaveTextContent('Never run');
  });

  it('renders the kind badge through the shared badge system, not a bespoke bg-muted pill', async () => {
    // Two idioms in one row (`span.rounded.bg-muted` beside `badgeClass`) read
    // as two different kinds of information; the muted pill also measured
    // 4.2:1 in light mode.
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    const kind = await screen.findByTestId('ai-agent-kind-badge-a1');
    expect(kind.className).toContain('rounded-full');
    expect(kind.className).toMatch(/dark:/);
    expect(kind.className).not.toContain('bg-muted');
  });
});

describe('AiAgentsPage deep link (#4187 UI critique)', () => {
  beforeEach(() => {
    window.location.hash = '';
  });

  it('opens the edit drawer for the agent named in the hash', async () => {
    window.location.hash = '#agent=a2';
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    expect(await screen.findByTestId('ai-agent-editor-drawer')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Org patcher')).toBeInTheDocument();
  });

  it('ignores a hash naming an agent this session cannot see', async () => {
    window.location.hash = '#agent=nope';
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await screen.findByTestId('ai-agent-row-a1');
    expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull();
  });

  // Review finding 6: the list carries disabled rows (`includeDisabled=1`), so
  // a stale link could open the full editor on a soft-deleted agent — every
  // field live, Save pointed at a PATCH the server refuses outright.
  it('does not open the editor for a soft-deleted agent named in the hash', async () => {
    window.location.hash = `#agent=${DISABLED_AGENT.id}`;
    mockEndpoints([PARTNER_AGENT, DISABLED_AGENT]);
    render(<AiAgentsPage />);

    await screen.findByTestId('ai-agents-disabled-section');
    expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull();
  });

  // Same finding: the deep link is ONE-SHOT. The latch that stops every list
  // reload from re-opening the drawer also meant the hash stayed in the URL
  // forever — so closing the editor left a link that could never re-open it,
  // and a browser reload landed straight back on the drawer.
  it('clears the hash when the deep-linked editor is closed', async () => {
    window.location.hash = '#agent=a2';
    mockEndpoints([PARTNER_AGENT, ORG_AGENT]);
    render(<AiAgentsPage />);

    await screen.findByTestId('ai-agent-editor-drawer');
    fireEvent.click(screen.getByTestId('ai-agent-cancel'));

    await waitFor(() => expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull());
    expect(window.location.hash).toBe('');
    // And it stays closed: clearing the applied-hash latch must not let the
    // effect immediately re-open what the operator just dismissed.
    await waitFor(() => screen.getByTestId('ai-agent-row-a2'));
    expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull();
  });
});

describe('AiAgentsPage re-enable (#4187 UI critique round 2)', () => {
  // Review finding 5: `enablingId` is read from the render that produced the
  // handler, so it is still null on the second half of a double-click — the
  // same failure ConfirmDialog's own latch comment documents. Two POSTs, and
  // the second 409s `agent_not_disabled` on the row the first just restored,
  // so the operator gets a success toast AND an error toast.
  it('fires exactly one POST for a double-clicked Re-enable', async () => {
    let resolveEnable: (value: Response) => void = () => {};
    mockEnableEndpoints([PARTNER_AGENT, DISABLED_AGENT], () =>
      new Promise<Response>((resolve) => { resolveEnable = resolve; }));
    render(<AiAgentsPage />);

    await screen.findByTestId('ai-agents-disabled-section');
    const button = screen.getByTestId('ai-agent-reenable-a9');
    // Raw dispatches inside ONE act scope, not two `fireEvent.click`s: RTL
    // flushes React between fireEvents, which hands the second click a
    // freshly-rendered handler and so cannot reproduce a double-click at all.
    // A real double-click runs both handlers off the SAME render — where
    // `enablingId` is still null and `disabled={enablingId !== null}` is still
    // false — which is exactly what the ref latch is for.
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const enableCalls = () => fetchMock.mock.calls.filter(
      ([url, init]) => String(url) === '/ai/agents/a9/enable' && (init as RequestInit | undefined)?.method === 'POST',
    );
    await waitFor(() => expect(enableCalls()).toHaveLength(1));
    resolveEnable(json({ data: { ...DISABLED_AGENT, disabledAt: null } }));
    await waitFor(() => expect(enableCalls()).toHaveLength(1));
  });
});

describe('AiAgentForm act card, roles and schedule drafts (#4187 UI critique)', () => {
  it('marks the selected Act card with a warning ring, not the same primary ring as Off/Shadow', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    const act = await screen.findByTestId('ai-agent-mode-act');
    const shadow = screen.getByTestId('ai-agent-mode-shadow');
    expect(shadow.className).toContain('ring-primary');

    fireEvent.click(act);
    expect(act).toHaveAttribute('aria-checked', 'true');
    expect(act.className).toContain('ring-warning-strong');
    expect(act.className).not.toContain('ring-primary');
  });

  it('groups notification roles under Partner and Organization', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [PARTNER_AGENT] }));
      if (url === '/roles') {
        return Promise.resolve(json({
          data: [
            { id: 'r-1', name: 'Partner Admin', scope: 'partner' },
            { id: 'r-2', name: 'Org Admin', scope: 'organization' },
            { id: 'r-3', name: 'Partner Tech', scope: 'partner' },
          ],
        }));
      }
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    const partnerGroup = await screen.findByTestId('ai-agent-roles-partner');
    const orgGroup = screen.getByTestId('ai-agent-roles-organization');
    expect(within(partnerGroup).getByTestId('ai-agent-role-r-1')).toBeInTheDocument();
    expect(within(partnerGroup).getByTestId('ai-agent-role-r-3')).toBeInTheDocument();
    expect(within(orgGroup).getByTestId('ai-agent-role-r-2')).toBeInTheDocument();
    // Every control survives the regrouping.
    expect(screen.getAllByTestId(/^ai-agent-role-/)).toHaveLength(3);
  });

  /** Opens agent a1's editor and dirties its schedule draft. */
  async function openDirtySchedule(): Promise<void> {
    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    expect(await screen.findByTestId('ai-agent-schedule-editor')).toBeInTheDocument();
    // Review finding 3: OPENING the editor is not an edit. Dirty is the first
    // field CHANGE, so this is what actually arms the guard.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0 * * * *' } });
    await screen.findByTestId('ai-agent-schedule-dirty');
  }

  it('blocks the outer Save while an edited schedule draft is unsaved', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);
    await openDirtySchedule();

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH'),
    ).toBe(false);

    // Cancelling the schedule draft clears the block.
    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-schedule-dirty')).toBeNull());
    expect(screen.getByTestId('ai-agent-save')).not.toBeDisabled();
  });

  // Review finding 3: `hasDraft = draft !== null` latched the parent dirty the
  // moment the editor opened, so merely LOOKING at a schedule wedged the
  // agent's own Save and (before finding 2) its Cancel too.
  it('does not treat an opened-but-untouched schedule draft as unsaved work', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    expect(await screen.findByTestId('ai-agent-schedule-editor')).toBeInTheDocument();

    expect(screen.queryByTestId('ai-agent-schedule-dirty')).toBeNull();
    expect(screen.getByTestId('ai-agent-save')).not.toBeDisabled();
  });
});

describe('AiAgentsPage unsaved-schedule close guard (#4187 UI critique round 2)', () => {
  /** Opens agent a1's editor and dirties its schedule draft. */
  async function openDirtySchedule(): Promise<void> {
    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), { target: { value: '0 * * * *' } });
    await screen.findByTestId('ai-agent-schedule-dirty');
  }

  // Review finding 2: the guard disabled the form's own Cancel button and
  // nothing else, so Escape, the drawer's X and a backdrop click all threw the
  // unsaved schedule away without a word — the loudest affordance was the one
  // blocked, the reflexive ones were not.
  it('ignores Escape and the drawer X while a schedule draft is unsaved', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);
    await openDirtySchedule();

    fireEvent.keyDown(screen.getByTestId('ai-agent-editor-drawer'), { key: 'Escape' });
    expect(screen.getByTestId('ai-agent-editor-drawer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-editor-drawer-close'));
    expect(screen.getByTestId('ai-agent-editor-drawer')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-editor-drawer-backdrop'));
    expect(screen.getByTestId('ai-agent-editor-drawer')).toBeInTheDocument();

    // And the drawer says why, in a described-by node rather than a tooltip.
    expect(screen.getByTestId('ai-agent-editor-drawer-close-blocked')).toBeInTheDocument();
  });

  // Cancel is the deliberate exit, so it must WORK — it just has to ask first.
  it('asks before discarding an unsaved schedule, then closes on confirm', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);
    await openDirtySchedule();

    const cancel = screen.getByTestId('ai-agent-cancel');
    expect(cancel).not.toBeDisabled();
    fireEvent.click(cancel);

    // Still open — the click opened a confirmation, it did not discard.
    expect(screen.getByTestId('ai-agent-editor-drawer')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('ai-agent-discard-schedule-confirm'));

    await waitFor(() => expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull());
  });

  it('keeps the editor open when the discard prompt is dismissed', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);
    await openDirtySchedule();

    fireEvent.click(screen.getByTestId('ai-agent-cancel'));
    // Scoped to the dialog's own footer: "Cancel" is also the form's and the
    // schedule editor's button label.
    const confirm = await screen.findByTestId('ai-agent-discard-schedule-confirm');
    fireEvent.click(within(confirm.parentElement!).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByTestId('ai-agent-editor-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-schedule-editor')).toBeInTheDocument();
  });

  it('closes straight away when nothing is unsaved', async () => {
    mockEndpoints([PARTNER_AGENT]);
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    await screen.findByTestId('ai-agent-editor-drawer');

    fireEvent.click(screen.getByTestId('ai-agent-cancel'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-editor-drawer')).toBeNull());
  });
});

describe('AiAgentsPage mode roving contract and disable focus (#4187 UI critique round 2)', () => {
  // Review finding 4: `onModeKeyDown` derived its starting index from
  // `draft.mode`, not from the option that actually had focus. Focus on Off
  // with Shadow selected therefore made ArrowRight jump to ACT — the one card
  // that authorizes unattended changes on a customer machine — while the user
  // was looking at the card before Shadow.
  it('moves selection from the FOCUSED option, not from the stored mode', async () => {
    mockActEndpoints();
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));

    // PARTNER_AGENT is stored as `shadow`; focus the option BEFORE it.
    const off = await screen.findByTestId('ai-agent-mode-off');
    off.focus();
    fireEvent.keyDown(off, { key: 'ArrowRight' });

    expect(screen.getByTestId('ai-agent-mode-shadow')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('ai-agent-mode-act')).toHaveAttribute('aria-checked', 'false');
  });

  // Review finding 7: the dialog was torn down synchronously on confirm, so
  // its focus-restore fired at a Disable button that the same click had just
  // disabled — `.focus()` on a disabled button is a no-op and focus fell to
  // <body>, dropping the keyboard user out of the drawer mid-action.
  it('keeps the confirmation mounted while the disable is in flight', async () => {
    let resolveDelete: (value: Response) => void = () => {};
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
      if (init?.method === 'DELETE') return new Promise<Response>((resolve) => { resolveDelete = resolve; });
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url.startsWith('/ai/agents')) return Promise.resolve(json({ data: [PARTNER_AGENT] }));
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentsPage />);

    await waitFor(() => screen.getByTestId('ai-agent-edit-a1'));
    // Focused explicitly: `fireEvent.click` does not move focus in jsdom, and
    // the drawer captures `document.activeElement` as its restore target — so
    // without this there is nothing for the restore to aim at and the last
    // assertion would fail for a reason that has nothing to do with the fix.
    screen.getByTestId('ai-agent-edit-a1').focus();
    fireEvent.click(screen.getByTestId('ai-agent-edit-a1'));
    fireEvent.click(await screen.findByTestId('ai-agent-disable'));

    const confirm = await screen.findByTestId('ai-agent-disable-confirm');
    fireEvent.click(confirm);

    // In flight: the dialog is STILL MOUNTED, showing its own progress state.
    // It used to be torn down on the first line of the handler.
    expect(screen.getByTestId('ai-agent-disable-confirm')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-disable-confirm')).toHaveTextContent('Processing');

    resolveDelete(json({ data: { ...PARTNER_AGENT, disabledAt: '2026-09-02T00:00:00.000Z' } }));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-disable-confirm')).toBeNull());

    // And when everything unwinds, focus lands on a LIVE element — the row's
    // Edit button, the drawer's own captured trigger. The old ordering had the
    // dialog restore focus to a Disable button that `saving` had just
    // disabled, which is a no-op, so the keyboard user ended up on <body>.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('ai-agent-edit-a1')));
  });
});
