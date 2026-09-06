import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const orgState = {
  current: {
    currentOrgId: null as string | null,
    allOrgs: true,
    error: null as string | null,
    organizationsLoaded: true,
    organizations: [{ id: 'org-1', name: 'Acme' }],
  },
};
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: typeof orgState.current) => unknown) => (sel ? sel(orgState.current) : orgState.current),
}));

import { AI_AGENT_KINDS, type AgentToolCatalogDto, type AiAgentDto } from '@breeze/shared';
import AgentCreateFlow from './AgentCreateFlow';
import { fetchWithAuth } from '../../../stores/auth';
import { buildAgentSaveBody, draftFrom } from './agentDraft';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const CATALOG: AgentToolCatalogDto = {
  capabilities: [
    { id: 'services_startup', tone: 'standard' },
    { id: 'scripts_commands', tone: 'standard' },
  ],
  tools: [
    {
      name: 'manage_services',
      capability: 'services_startup',
      tier: 3,
      readOnly: false,
      operations: [
        { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true, actRequiresAuthorizedScripts: false },
        { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false, actRequiresAuthorizedScripts: false },
      ],
    },
    {
      name: 'run_script',
      capability: 'scripts_commands',
      tier: 3,
      readOnly: false,
      operations: [{ key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true, actRequiresAuthorizedScripts: true }],
    },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
  unreachableTools: [],
};

/** `agents` fixture: `org-1` already owns a `patch` agent, so free-kind logic
 *  has something real to narrow. */
function makeAgents(): AiAgentDto[] {
  return [
    {
      id: 'a1',
      kind: 'patch',
      name: 'Org patcher',
      enabled: true,
      mode: 'shadow',
      model: null,
      orgId: 'org-1',
      partnerId: null,
      ownerScope: 'organization',
      allOrgs: false,
      supportedModes: ['off', 'shadow', 'act'],
      toolAllowlist: [],
      protectedResources: {},
      limits: {},
      triggers: { alertSeverities: ['critical'], respectMaintenanceWindows: true },
      recipients: { userIds: [], roleIds: [] },
      actAssets: { supervisedActionKeys: [] },
      instructions: null,
      cooldownSeconds: 900,
      disabledAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as AiAgentDto,
  ];
}

function mockEndpoints(overrides: {
  registry?: Array<{ key: string; toolName: string; action: string | null; note: string }>;
  roles?: Array<{ id: string; name: string; scope?: 'partner' | 'organization'; userCount?: number }>;
  rolesStatus?: number;
  preview?: unknown;
  createStatus?: number;
  createBody?: unknown;
} = {}): void {
  const { registry = [], roles = [{ id: 'r-1', name: 'Org Admin' }], rolesStatus = 200, preview, createStatus = 201, createBody } = overrides;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
    if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: registry }));
    if (url === '/roles') return Promise.resolve(json(rolesStatus === 200 ? { data: roles } : { error: 'nope' }, rolesStatus === 200, rolesStatus));
    if (url === '/ai/agents/preview') {
      return Promise.resolve(json({ data: preview ?? buildFakePreview() }));
    }
    if (url === '/ai/agents' && init?.method === 'POST') {
      return Promise.resolve(
        json(
          createBody ?? { data: { id: 'new-agent', ...JSON.parse(init.body as string) } },
          createStatus < 400,
          createStatus,
        ),
      );
    }
    return Promise.resolve(json({ data: [] }));
  });
}

function buildFakePreview() {
  return {
    mode: 'shadow',
    kind: 'triage',
    readOnlyToolCount: 3,
    operations: [],
    unrecognised: [],
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true, ticketAutonomousWrites: false },
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxDevicesPerRun: 5, maxRunsPerHour: 10, maxBudgetCentsPerDay: 1000, maxFleetPercentPerDay: 5, wallClockSeconds: 300 },
    cooldownSeconds: 900,
    recipients: { userIds: [], roleIds: [] },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  orgState.current = {
    currentOrgId: null,
    allOrgs: true,
    error: null,
    organizationsLoaded: true,
    organizations: [{ id: 'org-1', name: 'Acme' }],
  };
});

function renderFlow(props: Partial<Parameters<typeof AgentCreateFlow>[0]> = {}) {
  const onCancel = vi.fn();
  const onCreated = vi.fn();
  render(
    <AgentCreateFlow
      agents={makeAgents()}
      partnerBaselineKinds={new Set()}
      showOwnerScope
      defaultOwnerScope="partner"
      onCancel={onCancel}
      onCreated={onCreated}
      {...props}
    />,
  );
  return { onCancel, onCreated };
}

const postBody = (): Record<string, unknown> => {
  const call = fetchMock.mock.calls.find(([url, init]) => url === '/ai/agents' && (init as RequestInit | undefined)?.method === 'POST');
  return JSON.parse((call?.[1] as RequestInit).body as string);
};

describe('AgentCreateFlow — header, footer and cancel', () => {
  it('renders the header title, the vertical stepper and Cancel; Cancel calls onCancel', async () => {
    mockEndpoints();
    const { onCancel } = renderFlow();

    expect(screen.getByTestId('agent-create-flow')).toBeInTheDocument();
    expect(screen.getByTestId('setup-stepper-vertical')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-create-flow-back')).toBeNull(); // no Back on step 1

    fireEvent.click(screen.getByTestId('agent-create-flow-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('AgentCreateFlow — step navigation persists state', () => {
  it('keeps the name typed on Purpose after navigating to What it does and back', async () => {
    mockEndpoints();
    renderFlow();

    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    expect(await screen.findByTestId('ai-agent-permissions')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('setup-stepper-step-0'));
    expect(await screen.findByTestId('ai-agent-name')).toHaveValue('Triage bot');
  });

  it('Back returns to the previous step without losing state', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');

    fireEvent.click(screen.getByTestId('agent-create-flow-back'));
    expect(await screen.findByTestId('ai-agent-name')).toHaveValue('Triage bot');
  });

  it('only a COMPLETED step is clickable in the stepper — step 2 cannot be reached before step 1 is', async () => {
    mockEndpoints();
    renderFlow();
    expect(screen.getByTestId('setup-stepper-step-1')).toBeDisabled();
  });

  it('after an Edit link from Review, every already-visited step stays reachable from the stepper (#5048 QA)', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('agent-summary-card');

    fireEvent.click(screen.getByTestId('agent-summary-title-edit')); // back to Purpose
    await screen.findByTestId('ai-agent-name');
    expect(screen.getByTestId('setup-stepper-step-3')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('setup-stepper-step-3'));
    expect(await screen.findByTestId('agent-create-flow-start-enabled')).toBeInTheDocument();
  });

  it('a forward jump from the stepper still runs the current step\'s validation gate', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('setup-stepper-step-0'));
    await screen.findByTestId('ai-agent-name');

    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('setup-stepper-step-1'));

    expect(await screen.findByTestId('ai-agent-issues')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-permissions')).toBeNull();
  });
});

describe('AgentCreateFlow — default owner scope (#5048 QA)', () => {
  it('defaults a partner-scope draft to partner-wide when no baseline exists for the kind, even with an org focused', async () => {
    // Org-only overrides a baseline; with none, the org-only default the hook
    // chose for a focused org would produce an agent that does nothing.
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints();
    renderFlow({ defaultOwnerScope: 'organization', partnerBaselineKinds: new Set() });

    expect(screen.getByTestId('ai-agent-owner-partner')).toBeChecked();
    expect(screen.queryByTestId('ai-agent-no-baseline-hint')).toBeNull();
  });

  it('keeps the org-only default once a partner baseline exists for the kind', async () => {
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints();
    renderFlow({ defaultOwnerScope: 'organization', partnerBaselineKinds: new Set(['triage']) });

    expect(screen.getByTestId('ai-agent-owner-org')).toBeChecked();
  });
});

describe('AgentCreateFlow — recipients (#5048 QA)', () => {
  async function advanceToSafety() {
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Act bot' } });
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');
  }

  it('marks a role with no active members so the operator is not steered into an unreachable recipient', async () => {
    mockEndpoints({ roles: [{ id: 'r-empty', name: 'Partner Technician', scope: 'partner', userCount: 0 }, { id: 'r-1', name: 'Partner Admin', scope: 'partner', userCount: 1 }] });
    renderFlow();
    await advanceToSafety();
    expect(screen.getByTestId('ai-agent-role-r-empty-no-members')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-role-r-1-no-members')).toBeNull();
  });

  it('explains a recipient 422 as "no active members" when a role WAS selected, and carries it to Safety via Edit', async () => {
    mockEndpoints({
      roles: [{ id: 'r-empty', name: 'Partner Technician', scope: 'partner', userCount: 0 }],
      createStatus: 422,
      createBody: { error: 'act_prerequisites_not_met: recipient', code: 'act_prerequisites_not_met', missing: ['recipient'] },
    });
    renderFlow();
    await advanceToSafety();
    fireEvent.click(screen.getByTestId('ai-agent-role-r-empty'));
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    fireEvent.click(await screen.findByTestId('agent-create-flow-create'));

    const issues = await screen.findByTestId('ai-agent-issues');
    expect(issues.textContent).toMatch(/no active members/i);
    expect(issues.textContent).not.toMatch(/Add at least one/i);
  });
});

describe('AgentCreateFlow — validation gates', () => {
  it('blocks leaving Purpose with an empty name, and shows the issue', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));

    expect(await screen.findByTestId('ai-agent-issues')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-permissions')).toBeNull();
  });

  it('blocks leaving "What it does" with no severities selected for a triage agent', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');

    // Defaults are critical + high; clear both.
    fireEvent.click(screen.getByTestId('ai-agent-severity-critical'));
    fireEvent.click(screen.getByTestId('ai-agent-severity-high'));
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));

    expect(await screen.findByTestId('ai-agent-issues')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-policy-decide')).toBeNull(); // never reached Safety
  });

  it('disables Next on Purpose while entering act mode until the acknowledgement is checked', async () => {
    mockEndpoints();
    renderFlow();
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Act bot' } });
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));

    expect(screen.getByTestId('agent-create-flow-next')).toBeDisabled();
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    expect(screen.getByTestId('agent-create-flow-next')).not.toBeDisabled();
  });
});

describe('AgentCreateFlow — kind cards and owner scope (moved from AiAgentsPage.test.tsx)', () => {
  it('disables a kind card already taken for the current owner scope, and re-evaluates on owner-scope switch', async () => {
    // org-1 (via orgState) already owns `patch`; the partner-wide `triage`
    // agent from PARTNER_AGENT-style fixtures does not exist here, so only
    // `patch` is taken on the ORG axis.
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    mockEndpoints();
    // A triage baseline exists, so the org-owned default holds (#5048 QA
    // flips it to partner-wide only when there is no baseline for the kind).
    renderFlow({ defaultOwnerScope: 'organization', partnerBaselineKinds: new Set(['triage']) });

    expect(screen.getByTestId('ai-agent-kind-card-patch')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-kind-card-triage')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('ai-agent-owner-partner'));
    // Partner axis: nothing is taken there in this fixture.
    expect(screen.getByTestId('ai-agent-kind-card-patch')).not.toBeDisabled();
  });

  it('shows the no-baseline hint for an org draft of a kind with no partner-wide baseline', async () => {
    mockEndpoints();
    renderFlow({ defaultOwnerScope: 'organization', partnerBaselineKinds: new Set() });
    // With no baseline the flow starts partner-wide (#5048 QA); the hint
    // appears once the operator explicitly picks "This organization only".
    expect(screen.queryByTestId('ai-agent-no-baseline-hint')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-agent-owner-org'));
    expect(screen.getByTestId('ai-agent-no-baseline-hint')).toBeInTheDocument();
  });

  // Ported from AiAgentForm.test.tsx (Task 10, #5051 review): the hint is
  // create-only and no longer rendered by the drawer at all now that it only
  // ever edits — this is its sole remaining coverage.
  it('does not warn when a partner baseline already exists for the selected kind', async () => {
    mockEndpoints();
    renderFlow({ defaultOwnerScope: 'organization', partnerBaselineKinds: new Set(['triage']) });
    await screen.findByTestId('ai-agent-kind-card-triage');
    expect(screen.queryByTestId('ai-agent-no-baseline-hint')).toBeNull();
  });

  it('does not warn when creating a partner-wide agent', async () => {
    mockEndpoints();
    renderFlow({ partnerBaselineKinds: new Set() }); // defaultOwnerScope defaults to 'partner'
    await screen.findByTestId('ai-agent-kind-card-triage');
    expect(screen.queryByTestId('ai-agent-no-baseline-hint')).toBeNull();
  });

  it('disables Next on Purpose (and Create) once every kind is already taken for the current owner, mirroring the drawer\'s availableKinds guard', async () => {
    orgState.current = { ...orgState.current, currentOrgId: 'org-1', allOrgs: false };
    const allKindsTaken: AiAgentDto[] = AI_AGENT_KINDS.map((kind, i) => ({
      ...makeAgents()[0]!,
      id: `taken-${i}`,
      kind,
    }));
    mockEndpoints();
    renderFlow({ defaultOwnerScope: 'organization', agents: allKindsTaken, partnerBaselineKinds: new Set(AI_AGENT_KINDS) });

    expect(screen.getByTestId('ai-agent-kinds-exhausted')).toBeInTheDocument();
    expect(screen.getByTestId('agent-create-flow-next')).toBeDisabled();

    // Switching to the partner axis frees it up again (nothing taken there).
    fireEvent.click(screen.getByTestId('ai-agent-owner-partner'));
    expect(screen.queryByTestId('ai-agent-kinds-exhausted')).toBeNull();
    expect(screen.getByTestId('agent-create-flow-next')).not.toBeDisabled();
  });
});

describe('AgentCreateFlow — Safety step (moved from AiAgentsPage.test.tsx)', () => {
  async function advanceToSafety(name = 'Triage bot') {
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: name } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');
  }

  it('says roles could not be loaded rather than claiming none exist', async () => {
    mockEndpoints({ rolesStatus: 403 });
    renderFlow();
    await advanceToSafety();
    expect(screen.getByTestId('ai-agent-roles-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-roles-empty')).toBeNull();
  });

  it('falls back a cleared numeric limit to its minimum, never 0 (Number(\'\') is 0, not NaN)', async () => {
    // The old guard only checked `Number.isFinite(next)` on the theory that
    // clearing the box yields `'' -> NaN` — it does not, `Number('')` is `0`,
    // which IS finite, so the guard never fired and a cleared limit silently
    // stored 0 rather than falling back at all.
    mockEndpoints();
    renderFlow();
    await advanceToSafety();

    fireEvent.change(screen.getByTestId('ai-agent-limit-devices'), { target: { value: '' } });
    expect(screen.getByTestId('ai-agent-limit-devices')).toHaveValue(1); // this field's min

    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    fireEvent.click(await screen.findByTestId('agent-create-flow-create'));

    const limits = () => postBody().limits as { maxDevicesPerRun: number };
    await waitFor(() => expect(limits().maxDevicesPerRun).toBeTypeOf('number'));
    expect(limits().maxDevicesPerRun).toBe(1);
  });

  it('collapses a partner draft\'s supervised-key registry behind a summary while shadow/off, mirroring the drawer', async () => {
    mockEndpoints();
    renderFlow(); // defaultOwnerScope: 'partner', mode defaults to 'shadow'
    await advanceToSafety();

    const details = await screen.findByTestId('ai-agent-policy-keys-details');
    expect(details.tagName).toBe('DETAILS');
    expect(details).not.toHaveAttribute('open');

    // Entering act mode unwraps the registry entirely — go back to Purpose,
    // switch to act, and return.
    fireEvent.click(screen.getByTestId('setup-stepper-step-0'));
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    fireEvent.click(screen.getByTestId('ai-agent-act-ack'));
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');

    expect(screen.queryByTestId('ai-agent-policy-keys-details')).toBeNull();
    expect(screen.getByTestId('ai-agent-policy-decide')).toBeInTheDocument();
  });
});

describe('AgentCreateFlow — Create posts the same body buildAgentSaveBody would (moved from AiAgentsPage.test.tsx)', () => {
  it('posts a partner-wide create with no orgId and the selected role recipients', async () => {
    mockEndpoints();
    renderFlow();

    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-role-r-1');
    fireEvent.click(screen.getByTestId('ai-agent-role-r-1'));
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    fireEvent.click(await screen.findByTestId('agent-create-flow-create'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => url === '/ai/agents' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true),
    );
    const body = postBody();
    expect(body.ownerScope).toBe('partner');
    expect(body.orgId).toBeUndefined();
    expect(body.recipients).toEqual({ roleIds: ['r-1'] });
  });

  it('the final POST body matches buildAgentSaveBody for the same draft (drawer/flow parity)', async () => {
    mockEndpoints();
    renderFlow();

    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Parity bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    fireEvent.click(await screen.findByTestId('agent-create-flow-create'));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => url === '/ai/agents' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true),
    );
    const draft = { ...draftFrom(null, { ownerScope: 'partner', kind: 'triage' }), name: 'Parity bot' };
    const expected = buildAgentSaveBody(draft, { isCreate: true, orgId: null });
    expect(postBody()).toEqual(expected);
  });
});

describe('AgentCreateFlow — review step preview and onCreated', () => {
  async function advanceToReview() {
    fireEvent.change(screen.getByTestId('ai-agent-name'), { target: { value: 'Triage bot' } });
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-permissions');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
    await screen.findByTestId('ai-agent-limit-devices');
    fireEvent.click(screen.getByTestId('agent-create-flow-next'));
  }

  it('fires POST /ai/agents/preview with the draft body on reaching Review, and renders the summary card', async () => {
    mockEndpoints();
    renderFlow();
    await advanceToReview();

    await waitFor(
      () => expect(fetchMock.mock.calls.some(([url, init]) => url === '/ai/agents/preview' && (init as RequestInit | undefined)?.method === 'POST')).toBe(true),
      { timeout: 2000 },
    );
    expect(await screen.findByTestId('agent-summary-card')).toBeInTheDocument();

    const previewCall = fetchMock.mock.calls.find(([url]) => url === '/ai/agents/preview')!;
    const previewBody = JSON.parse((previewCall[1] as RequestInit).body as string);
    expect(previewBody.name).toBe('Triage bot');
    expect(previewBody.kind).toBe('triage');
  });

  it('shows an inline error on a failed preview but still allows Create', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
      if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: [] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      if (url === '/ai/agents/preview') return Promise.resolve(json({ error: 'nope' }, false, 500));
      if (url === '/ai/agents' && init?.method === 'POST') {
        return Promise.resolve(json({ data: { id: 'new-agent', ...JSON.parse(init.body as string) } }, true, 201));
      }
      return Promise.resolve(json({ data: [] }));
    });
    renderFlow();
    await advanceToReview();

    expect(await screen.findByTestId('agent-create-flow-preview-error', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByTestId('agent-create-flow-create')).not.toBeDisabled();
  });

  it('calls onCreated with the server response on a successful Create', async () => {
    mockEndpoints();
    const { onCreated } = renderFlow();
    await advanceToReview();
    fireEvent.click(await screen.findByTestId('agent-create-flow-create'));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toMatchObject({ id: 'new-agent' });
  });

  it('onEdit from the summary card jumps back to the right step', async () => {
    mockEndpoints();
    renderFlow();
    await advanceToReview();
    await screen.findByTestId('agent-summary-card');

    fireEvent.click(screen.getByTestId('agent-summary-row-mayPropose-edit')); // "does" section
    expect(await screen.findByTestId('ai-agent-permissions')).toBeInTheDocument();
  });

  it('the "Start enabled" switch defaults to off and drives the created body\'s enabled field', async () => {
    mockEndpoints();
    renderFlow();
    await advanceToReview();
    await screen.findByTestId('agent-summary-card');

    expect(screen.getByTestId('agent-create-flow-start-enabled')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('agent-create-flow-start-enabled'));
    fireEvent.click(screen.getByTestId('agent-create-flow-create'));

    await waitFor(() => expect(postBody().enabled).toBe(true));
  });
});
