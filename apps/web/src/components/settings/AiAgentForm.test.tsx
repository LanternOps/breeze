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
      currentOrgId: 'org-1' as string | null,
      allOrgs: false,
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

import { type AgentToolCatalogDto } from '@breeze/shared';
import AiAgentForm, { type AiAgentDto } from './AiAgentForm';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** A registry response shaped exactly like GET /ai/agents/policy-decidable-keys. */
type RegistryRow = { key: string; toolName: string; action: string | null; note: string };

const REGISTRY: RegistryRow[] = [
  {
    key: 'manage_services:restart',
    toolName: 'manage_services',
    action: 'restart',
    note: 'Restarts one named service on one device via the agent command queue.',
  },
  {
    key: 'manage_startup_items:disable',
    toolName: 'manage_startup_items',
    action: 'disable',
    note: 'Disables one named startup item on one device via the agent command queue.',
  },
  {
    key: 'manage_scheduled_tasks:disable',
    toolName: 'manage_scheduled_tasks',
    action: 'disable',
    note: 'Disables one named scheduled task on one device via the agent command queue.',
  },
];

function makeAgent(overrides: Partial<AiAgentDto> = {}): AiAgentDto {
  return {
    id: 'a1',
    kind: 'triage',
    name: 'Triage',
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
    ...overrides,
  };
}

// Task 10 (#5050) — same fixture as CapabilityPicker.test.tsx / capabilityModel.test.ts
// (Task 7), kept identical so every suite touching the catalog exercises the
// same shape. `presets.triage` names `manage_services:restart`, which lines
// up with `makeAgent`'s default `kind: 'triage'` below.
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
        { key: 'manage_services:list', action: 'list', tier: 2, readOnly: true, policyDecidable: false, actEligible: false, actRequiresAuthorizedScripts: false },
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
    {
      name: 'query_devices',
      capability: 'scripts_commands',
      tier: 1,
      readOnly: true,
      operations: [{ key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false, actRequiresAuthorizedScripts: false }],
    },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
  unreachableTools: ['manage_ai_agents'],
};

function mockEndpoints(registry: RegistryRow[] = []): void {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: registry }));
    if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
    if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
    // The single-org shape AiAgentGraduationPanel's `normalize` accepts — a
    // body it rejects renders the panel's error state and floods the run with
    // console noise that has nothing to do with these assertions.
    if (url.startsWith('/ai/agents/graduation')) {
      return Promise.resolve(json({
        data: { rows: [], actOpReliability: [], promoteThreshold: null, policyDecideEnabled: true },
      }));
    }
    if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
    if (url === '/roles') return Promise.resolve(json({ data: [{ id: 'r-1', name: 'Org Admin' }] }));
    return Promise.resolve(json({ data: [] }));
  });
}

// Task 13 (#5051): AiAgentsPage only ever opens this drawer for EDIT now
// (`AgentCreateFlow` owns create), so `Props.agent` is a real `AiAgentDto` —
// every test renders against one, either this default or an override.
function renderForm(props: Partial<React.ComponentProps<typeof AiAgentForm>> = {}) {
  return render(
    <AiAgentForm
      agent={makeAgent()}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...props}
    />,
  );
}

/** The one PATCH/POST body the form sent, parsed. */
function writeBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(([, init]) =>
    ['POST', 'PATCH'].includes((init as RequestInit | undefined)?.method ?? ''));
  return JSON.parse((call?.[1] as RequestInit).body as string) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock.mockReset();
  getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
  orgState.current = {
    currentOrgId: 'org-1',
    allOrgs: false,
    error: null,
    organizationsLoaded: true,
    organizations: [{ id: 'org-1', name: 'Acme' }],
  };
});

describe('AiAgentForm — unattended policy authorization', () => {
  // Task 5 (#5050): the interactive checkbox registry only exists for
  // PARTNER-owned rows now — an org row renders its currently-held keys as a
  // read-only list instead (see the "org-owned supervised keys are
  // grant-only" describe block below). These four tests exercise the
  // checkbox/registry rendering itself (grouping, translation, description,
  // DOM order), so they moved to a partner-owned fixture; `mode: 'act'`
  // keeps the registry unwrapped rather than collapsed behind the
  // partner-ceiling `<details>`.
  const partnerFixture = {
    id: 'a9', ownerScope: 'partner' as const, orgId: null, partnerId: 'p-1', allOrgs: true, mode: 'act' as const,
  };

  it('names each authorized operation in words rather than the raw registry token', async () => {
    // The registry key IS the wire contract, so it stays on the data-testid —
    // but "manage_startup_items / disable" is a machine token, and the bare
    // verb "disable" appears against three different objects in this list.
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent(partnerFixture) });

    const fieldset = await screen.findByTestId('ai-agent-policy-decide');
    await within(fieldset).findByText('Services');
    expect(within(fieldset).getByText('Startup items')).toBeInTheDocument();
    expect(within(fieldset).getByText('Scheduled tasks')).toBeInTheDocument();

    expect(within(fieldset).getByText('Restart a service')).toBeInTheDocument();
    expect(within(fieldset).getByText('Disable a startup item')).toBeInTheDocument();
    expect(within(fieldset).getByText('Disable a scheduled task')).toBeInTheDocument();

    // No raw token survives as a visible label.
    expect(fieldset.textContent).not.toContain('manage_services');
    expect(fieldset.textContent).not.toContain('manage_startup_items');
  });

  it('sentence-cases a key the catalog has no translation for, rather than showing the token', async () => {
    // The registry is server-owned: a key can land in an API build before the
    // web catalog knows it. It must still read as words.
    mockEndpoints([
      { key: 'manage_widgets:defrag', toolName: 'manage_widgets', action: 'defrag', note: '' },
    ]);
    renderForm({ agent: makeAgent(partnerFixture) });

    const fieldset = await screen.findByTestId('ai-agent-policy-decide');
    await within(fieldset).findByText('Manage widgets');
    expect(within(fieldset).getByText('Defrag')).toBeInTheDocument();
  });

  it('describes each operation with the registry note, wired to the checkbox', async () => {
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent(partnerFixture) });

    const checkbox = await screen.findByTestId('ai-agent-supervised-key-manage_services:restart');
    const describedBy = checkbox.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'Restarts one named service on one device via the agent command queue.',
    );
  });

  it('asks for the tool allowlist before it asks who may act on it unattended', async () => {
    // Authority over a set has to come after the set: the permissions section
    // is what the authorized operations are drawn from.
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent(partnerFixture) });

    const permissions = await screen.findByTestId('ai-agent-permissions');
    const authorization = screen.getByTestId('ai-agent-policy-decide');
    expect(
      permissions.compareDocumentPosition(authorization) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('collapses a partner-wide ceiling behind a summary that counts it, while the row is not acting', async () => {
    // A partner row's keys are a CEILING, not authority it exercises — so on a
    // shadow-mode baseline the whole list is secondary, and only its size is
    // worth a line.
    mockEndpoints(REGISTRY);
    renderForm({
      agent: makeAgent({
        id: 'a9',
        ownerScope: 'partner',
        orgId: null,
        partnerId: 'p-1',
        allOrgs: true,
        mode: 'shadow',
        actAssets: { supervisedActionKeys: ['manage_services:restart'] },
      }),
    });

    const details = await screen.findByTestId('ai-agent-policy-keys-details');
    expect(details.tagName).toBe('DETAILS');
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText(/Ceiling for organizations/)).toHaveTextContent('1 key');

    // Entering act mode is the operator saying the list itself matters now.
    fireEvent.click(screen.getByTestId('ai-agent-mode-act'));
    await waitFor(() => expect(screen.queryByTestId('ai-agent-policy-keys-details')).toBeNull());
    expect(screen.getByTestId('ai-agent-supervised-key-manage_services:restart')).toBeInTheDocument();
  });
});

// #5049 — the API now rejects any org-row create/PATCH that ADDS a
// supervisedActionKeys entry the row does not already hold (a key goes live on
// an org row only through the four-eyes grant executor, spec §4.4). The form
// must stop offering an org row a control that a save can never honor, and
// must stop asking the server to leave a key list alone by SENDING the exact
// list it already holds — omitting `actAssets` entirely is what "leave it
// alone" means to the merge-patch semantics `save()` already relies on for
// every other narrowing field.
describe('AiAgentForm — org-owned supervised keys are grant-only (#5049)', () => {
  it('renders an org-owned act-mode agent\'s supervised keys as a read-only list, with the grant-only hint', async () => {
    mockEndpoints(REGISTRY);
    renderForm({
      agent: makeAgent({ mode: 'act', actAssets: { supervisedActionKeys: ['manage_services:restart'] } }),
    });

    const fieldset = await screen.findByTestId('ai-agent-policy-decide');
    // A read-only LIST, not disabled checkboxes: no `<input>` of any kind in
    // this fieldset for an org row — a control that a save can never honor
    // must not exist at all, not exist-but-disabled.
    expect(within(fieldset).queryAllByRole('checkbox')).toHaveLength(0);
    expect(fieldset.querySelector('input')).toBeNull();

    // The row's own currently-held key is listed, in words.
    expect(within(fieldset).getByText('Restart a service')).toBeInTheDocument();
    // The rest of the registry (never held by this row) is NOT listed —
    // this is "what this row holds", not "the whole registry, disabled".
    expect(within(fieldset).queryByText('Disable a startup item')).not.toBeInTheDocument();

    expect(screen.getByTestId('ai-agent-supervised-keys-grant-only-hint')).toHaveTextContent(
      'Pre-authorized keys on an organization agent are granted only through the Graduation panel by a second approver, and are revoked there too.',
    );
  });

  it('omits actAssets entirely from an org agent\'s save payload', async () => {
    mockEndpoints(REGISTRY);
    renderForm({
      agent: makeAgent({ mode: 'act', actAssets: { supervisedActionKeys: ['manage_services:restart'] } }),
    });

    await screen.findByTestId('ai-agent-policy-decide');
    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true));

    expect(writeBody()).not.toHaveProperty('actAssets');
  });

  it('leaves a partner-owned agent\'s checkboxes enabled and still sends actAssets', async () => {
    mockEndpoints(REGISTRY);
    renderForm({
      agent: makeAgent({
        id: 'a9',
        ownerScope: 'partner',
        orgId: null,
        partnerId: 'p-1',
        allOrgs: true,
        mode: 'act',
        actAssets: { supervisedActionKeys: ['manage_services:restart'] },
      }),
    });

    const checkbox = await screen.findByTestId('ai-agent-supervised-key-manage_services:restart');
    expect(checkbox).not.toBeDisabled();
    expect(screen.queryByTestId('ai-agent-supervised-keys-grant-only-hint')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true));

    expect(writeBody()).toHaveProperty('actAssets');
    expect((writeBody().actAssets as { supervisedActionKeys: string[] }).supervisedActionKeys).toEqual([
      'manage_services:restart',
    ]);
  });

  it('surfaces the supervised_keys_grant_only 422 as a per-key issue, same as invalid_supervised_action_keys', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: REGISTRY }));
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({ data: CATALOG }));
      if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
      if (url === '/ai/agents/a1' && init?.method === 'PATCH') {
        return Promise.resolve(json(
          {
            error: 'supervised_keys_grant_only: manage_services:restart',
            code: 'supervised_keys_grant_only',
            rejected: [{ key: 'manage_services:restart', reason: 'grant_only' }],
          },
          false,
          422,
        ));
      }
      if (url.startsWith('/ai/agents/graduation')) {
        return Promise.resolve(json({
          data: { rows: [], actOpReliability: [], promoteThreshold: null, policyDecideEnabled: true },
        }));
      }
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    renderForm({ agent: makeAgent({ mode: 'act' }) });

    await screen.findByTestId('ai-agent-policy-decide');
    fireEvent.click(screen.getByTestId('ai-agent-save'));

    expect(await screen.findByTestId('ai-agent-issues')).toBeInTheDocument();
    expect(screen.getByText('manage_services:restart: grant_only')).toBeInTheDocument();
  });
});

// Task 10 (#5050) — the capability picker replaces the free-text tool
// allowlist textarea and its autocomplete datalist inside Permissions. The
// picker's catalog/ceiling fetch must never block the form: a failed catalog
// falls back to the original textarea rather than leaving Permissions empty.
describe('AiAgentForm — capability picker wiring (#5050)', () => {
  it('renders the picker inside Permissions and removes the old allowlist textarea and suggestions datalist', async () => {
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent() });

    const permissions = await screen.findByTestId('ai-agent-permissions');
    expect(await within(permissions).findByTestId('capability-picker')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-toolallowlist')).toBeNull();
    expect(screen.queryByTestId('ai-agent-toolallowlist-suggestions')).toBeNull();
    expect(screen.queryByTestId('ai-agent-toolallowlist-suggest')).toBeNull();
  });

  it('saves the selected operation as a scoped toolAllowlist entry', async () => {
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent() });

    await screen.findByTestId('capability-picker');
    fireEvent.click(screen.getByTestId('operation-checkbox-manage_services:restart'));

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true));

    expect(writeBody().toolAllowlist).toEqual(['manage_services:restart']);
  });

  it('shows a muted loading line, not the textarea fallback, while the catalog fetch is pending', async () => {
    fetchMock.mockImplementation((url: string) => {
      // tool-catalog never resolves in this test — the picker/fallback
      // choice must not be made before the fetch settles either way.
      if (url === '/ai/agents/tool-catalog') return new Promise(() => {});
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: REGISTRY }));
      if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
      if (url.startsWith('/ai/agents/graduation')) {
        return Promise.resolve(json({
          data: { rows: [], actOpReliability: [], promoteThreshold: null, policyDecideEnabled: true },
        }));
      }
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    renderForm({ agent: makeAgent() });

    expect(await screen.findByTestId('ai-agent-catalog-loading')).toHaveTextContent('Loading capabilities');
    expect(screen.queryByTestId('ai-agent-catalog-unavailable')).toBeNull();
    expect(screen.queryByTestId('ai-agent-toolallowlist')).toBeNull();
    expect(screen.queryByTestId('capability-picker')).toBeNull();
  });

  it('falls back to the free-text textarea, with a hint, when the catalog fetch fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/ai/agents/tool-catalog') return Promise.resolve(json({}, false, 500));
      if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: REGISTRY }));
      if (url.startsWith('/ai/agents/ceiling')) return Promise.resolve(json({ data: null }));
      if (url.startsWith('/ai/agents/graduation')) {
        return Promise.resolve(json({
          data: { rows: [], actOpReliability: [], promoteThreshold: null, policyDecideEnabled: true },
        }));
      }
      if (url.startsWith('/ai/agents/schedules')) return Promise.resolve(json({ data: [] }));
      if (url === '/roles') return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
    renderForm({ agent: makeAgent() });

    expect(await screen.findByTestId('ai-agent-catalog-unavailable')).toHaveTextContent(
      'Could not load the tool catalog. You can still edit the permissions list directly below.',
    );
    expect(screen.getByTestId('ai-agent-toolallowlist')).toBeInTheDocument();
    expect(screen.queryByTestId('capability-picker')).toBeNull();
  });

  // (d) an org-owned agent in act mode renders the policy-decide fieldset
  // read-only — see 'AiAgentForm — org-owned supervised keys are grant-only
  // (#5049)' above; that suite already covers this identically, so it is not
  // duplicated here.
});

// #5063: the drawer renders the guided create flow's own step components, so
// every setting from "When it runs" through recipients has exactly one
// rendering. The step roots carry test ids so this stays asserted rather
// than implied by the individual field ids still resolving.
describe('AiAgentForm — renders the create flow\'s step components (#5063)', () => {
  it('mounts WhatItDoesStep and SafetyStep, in that order, with the edit-only pieces around them', async () => {
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent({ mode: 'act' }) });

    const does = await screen.findByTestId('agent-step-does');
    const safety = screen.getByTestId('agent-step-safety');
    // Siblings in order — FOLLOWING alone is also true for a nested node, so
    // rule containment out explicitly.
    const position = does.compareDocumentPosition(safety);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(position & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeFalsy();

    // The settings live INSIDE the steps, not beside them — and exactly once
    // in the drawer. The role row arrives after the /roles fetch, so it is
    // awaited rather than assumed to have flushed.
    expect(within(does).getByTestId('ai-agent-permissions')).toBeInTheDocument();
    expect(within(does).getByTestId('ai-agent-respect-maintenance')).toBeInTheDocument();
    expect(within(safety).getByTestId('ai-agent-services')).toBeInTheDocument();
    expect(within(safety).getByTestId('ai-agent-policy-decide')).toBeInTheDocument();
    expect(within(safety).getByTestId('ai-agent-limit-devices')).toBeInTheDocument();
    expect(await within(safety).findByTestId('ai-agent-role-r-1')).toBeInTheDocument();
    for (const id of ['ai-agent-permissions', 'ai-agent-services', 'ai-agent-policy-decide', 'ai-agent-limit-devices', 'ai-agent-role-r-1']) {
      expect(screen.getAllByTestId(id)).toHaveLength(1);
    }

    // Edit-only pieces stay the drawer's own.
    expect(screen.getByTestId('ai-agent-kind')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-enabled')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-disable')).toBeInTheDocument();
  });
});

describe('AiAgentForm — alert severities', () => {
  it('offers alert severities to an alert-triage agent', async () => {
    mockEndpoints();
    renderForm({ agent: makeAgent({ kind: 'triage' }) });

    expect(await screen.findByTestId('ai-agent-severity-critical')).toBeInTheDocument();
  });

  it('hides alert severities from a help desk agent and omits them from the save', async () => {
    // Ticket-triggered runs carry no alert severity — `evaluateAgentTriggerFilters`
    // runs only when an `alertContext` is present, and only triage admissions
    // build one. Asking for a severity here is a decision that can never apply,
    // and the `.min(1)` client check could block a save on a field the server
    // never reads for this kind.
    mockEndpoints();
    renderForm({ agent: makeAgent({ kind: 'helpdesk', triggers: { respectMaintenanceWindows: true } }) });

    await screen.findByTestId('ai-agent-permissions');
    expect(screen.queryByTestId('ai-agent-severity-critical')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true));

    const triggers = writeBody().triggers as Record<string, unknown>;
    expect(triggers).not.toHaveProperty('alertSeverities');
    expect(screen.queryByTestId('ai-agent-issues')).toBeNull();
  });

  it('hides alert severities from a patching agent', async () => {
    mockEndpoints();
    renderForm({ agent: makeAgent({ kind: 'patch' }) });

    await screen.findByTestId('ai-agent-permissions');
    expect(screen.queryByTestId('ai-agent-severity-critical')).toBeNull();
  });
});

// Task 10 (#5051 review): "mode cards" (top-alignment) moved to
// ModeChoice.test.tsx — a component-level assertion, not anything specific
// to the drawer. "no-partner-baseline hint" is gone entirely: AiAgentsPage
// now only ever opens this drawer for EDIT (Task 13, #5051), and that hint
// was create-only (`isCreate && draft.ownerScope === 'organization' &&
// !partnerBaselineKinds.has(draft.kind)`) — deleted along with every other
// create-only branch now that `agent` is narrowed to a real `AiAgentDto`.
// Its remaining coverage (including the two "does not warn" negative cases)
// lives in AgentCreateFlow.test.tsx's "kind cards and owner scope" describe.

describe('AiAgentForm — name', () => {
  it('marks the name as required and says so on blur, not only after a failed save', async () => {
    mockEndpoints();
    renderForm({ agent: makeAgent({ name: '' }) });

    const input = await screen.findByTestId('ai-agent-name');
    expect(input).toBeRequired();
    // The repo's required marker (ApiKeyForm.tsx) is a destructive-toned
    // asterisk appended to the label.
    const label = document.querySelector(`label[for="${input.getAttribute('id')}"]`);
    expect(label?.textContent).toContain('*');

    expect(screen.queryByTestId('ai-agent-name-error')).toBeNull();
    fireEvent.blur(input);

    expect(await screen.findByTestId('ai-agent-name-error')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBe(
      screen.getByTestId('ai-agent-name-error').getAttribute('id'),
    );

    fireEvent.change(input, { target: { value: 'Triage' } });
    await waitFor(() => expect(screen.queryByTestId('ai-agent-name-error')).toBeNull());
    expect(input).not.toHaveAttribute('aria-invalid');
  });
});

describe('AiAgentForm — numeric limits', () => {
  it('falls back a cleared numeric limit to its minimum, never 0 (Number(\'\') is 0, not NaN)', async () => {
    // The old guard only checked `Number.isFinite(next)` on the theory that
    // clearing the box yields `'' -> NaN` — it does not, `Number('')` is `0`,
    // which IS finite, so the guard never fired and a cleared limit silently
    // stored 0 rather than falling back at all.
    mockEndpoints();
    renderForm({ agent: makeAgent() });

    const input = await screen.findByTestId('ai-agent-limit-devices');
    fireEvent.change(input, { target: { value: '' } });
    expect(input).toHaveValue(1); // this field's min

    fireEvent.click(screen.getByTestId('ai-agent-save'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) =>
        (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true));

    expect((writeBody().limits as { maxDevicesPerRun: number }).maxDevicesPerRun).toBe(1);
  });
});

describe('AiAgentForm — Save button', () => {
  // Review finding — the disabled Save button was missing the
  // `disabled:cursor-not-allowed` affordance already used by
  // `RunsListPage.tsx`'s Load more button.
  it('shows a not-allowed cursor while disabled, matching the rest of the AI agents UI', async () => {
    mockEndpoints();
    // The `disabled:cursor-not-allowed` Tailwind variant is a static part of
    // the button's className regardless of whether `disabled` is currently
    // true, so this needs no particular disabled state to assert on.
    renderForm({ agent: makeAgent() });

    const save = await screen.findByTestId('ai-agent-save');
    expect(save.className).toContain('disabled:cursor-not-allowed');
  });
});

describe('AiAgentForm — disable confirmation', () => {
  it('asks with a caution, not a destructive stop sign, for an action that can be undone', async () => {
    // Disabling is reversible from this very page (`actions.reenable`), so the
    // red stop octagon overstates it.
    mockEndpoints();
    renderForm({ agent: makeAgent() });

    fireEvent.click(await screen.findByTestId('ai-agent-disable'));
    const dialog = (await screen.findByTestId('ai-agent-disable-confirm')).closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect((dialog as HTMLElement).innerHTML).toContain('bg-warning/10');
    expect((dialog as HTMLElement).innerHTML).not.toContain('bg-destructive/10');
  });
});
