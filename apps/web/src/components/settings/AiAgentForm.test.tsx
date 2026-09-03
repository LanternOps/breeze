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

function mockEndpoints(registry: RegistryRow[] = []): void {
  fetchMock.mockImplementation((url: string) => {
    if (url === '/ai/agents/policy-decidable-keys') return Promise.resolve(json({ data: registry }));
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

function renderForm(props: Partial<React.ComponentProps<typeof AiAgentForm>> = {}) {
  return render(
    <AiAgentForm
      agent={null}
      agents={[]}
      showOwnerScope={false}
      defaultOwnerScope="organization"
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
  it('names each authorized operation in words rather than the raw registry token', async () => {
    // The registry key IS the wire contract, so it stays on the data-testid —
    // but "manage_startup_items / disable" is a machine token, and the bare
    // verb "disable" appears against three different objects in this list.
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent({ mode: 'act' }) });

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
    renderForm({ agent: makeAgent({ mode: 'act' }) });

    const fieldset = await screen.findByTestId('ai-agent-policy-decide');
    await within(fieldset).findByText('Manage widgets');
    expect(within(fieldset).getByText('Defrag')).toBeInTheDocument();
  });

  it('describes each operation with the registry note, wired to the checkbox', async () => {
    mockEndpoints(REGISTRY);
    renderForm({ agent: makeAgent({ mode: 'act' }) });

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
    renderForm({ agent: makeAgent({ mode: 'act' }) });

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

describe('AiAgentForm — mode cards', () => {
  it('top-aligns the option cards so the three labels share a baseline', async () => {
    // A <button>'s content box is vertically centred by the UA stylesheet, so
    // three cards of unequal height put their labels on three different lines.
    mockEndpoints();
    renderForm();

    for (const mode of ['off', 'shadow', 'act']) {
      const card = await screen.findByTestId(`ai-agent-mode-${mode}`);
      expect(card.className).toContain('flex-col');
      expect(card.className).toContain('items-start');
    }
  });
});

describe('AiAgentForm — name', () => {
  it('marks the name as required and says so on blur, not only after a failed save', async () => {
    mockEndpoints();
    renderForm();

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

describe('AiAgentForm — Save button', () => {
  // Review finding — the disabled Save button was missing the
  // `disabled:cursor-not-allowed` affordance already used by
  // `RunsListPage.tsx`'s Load more button.
  it('shows a not-allowed cursor while disabled, matching the rest of the AI agents UI', async () => {
    mockEndpoints();
    // No available kinds on a create form disables Save (see the
    // `disabled` expression below the button) without needing to wait on
    // an async validation state.
    renderForm();

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
