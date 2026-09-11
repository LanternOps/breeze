import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

/**
 * #4888 — the run-context override has to survive the last hop.
 *
 * `buildActionPayload` reconstructs every action field by field rather than
 * spreading the form values, so a field added to the form and not added there
 * is dropped between the operator clicking Save and the request leaving the
 * browser — silently, with no error and the UI still showing the selection.
 * That is exactly the bug #4888 was filed for, one layer below where a
 * component-level test on `AutomationForm`'s `onSubmit` can see it. These
 * assert on the actual PUT body.
 */
describe('AutomationEditPage — run_script run context (#4888)', () => {
  function putBody(): Record<string, unknown> {
    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/automations/automation-1' && (init as RequestInit | undefined)?.method === 'PUT',
    )!;
    return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
  }

  async function editAndSave(action: Record<string, unknown>, mutate?: () => void) {
    mockEndpoints({ ...baseAutomation, managedByAgentId: null, actions: [action] });
    render(<AutomationEditPage automationId="automation-1" />);
    const save = await screen.findByRole('button', { name: /Save Changes/i });
    mutate?.();
    fireEvent.click(save);
    await waitFor(() => expect(putBody()).toBeTruthy());
  }

  it('sends the chosen run context in the PUT body', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1' }, () => {
      fireEvent.change(screen.getByTestId('action-0-run-as-select'), { target: { value: 'user' } });
    });

    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'run_script',
      scriptId: 's1',
      runAs: 'user',
    });
  });

  it('omits runAs entirely while the action is on "Script default"', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1' });

    // Omitted, NOT sent as 'system': the launch-time enum cannot express
    // `elevated`, so a concrete value here would silently downgrade an
    // elevated script.
    expect((putBody().actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('runAs');
  });

  it('reads a stored override back into the form and round-trips it untouched', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1', runAs: 'user' });

    expect((screen.getByTestId('action-0-run-as-select') as HTMLSelectElement).value).toBe('user');
    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({ runAs: 'user' });
  });

  /**
   * `elevated` is a legal stored value that this control cannot hand out.
   * Opening such an automation for an unrelated edit must not downgrade it —
   * the select shows it (disabled) and the save preserves it.
   */
  it('preserves a stored elevated override through an unrelated edit', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1', runAs: 'elevated' });

    expect((screen.getByTestId('action-0-run-as-select') as HTMLSelectElement).value).toBe('elevated');
    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({ runAs: 'elevated' });
  });

  /**
   * #5128 W4 — `whenOffline` is the second field to go through the field-by-field
   * `buildActionPayload`, so it carries exactly the drop risk the block comment
   * above describes. `AutomationForm.test.tsx` asserts on that component's own
   * `onSubmit` prop, which is one layer ABOVE where such a drop happens; these
   * assert on the PUT body that actually leaves the browser.
   */
  it('sends the chosen offline behaviour in the PUT body (run_script)', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1' }, () => {
      fireEvent.change(screen.getByTestId('action-0-when-offline-select'), { target: { value: 'skip' } });
    });

    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'run_script',
      whenOffline: 'skip',
    });
  });

  it('sends the chosen offline behaviour in the PUT body (execute_command)', async () => {
    await editAndSave({ type: 'execute_command', command: 'whoami' }, () => {
      fireEvent.change(screen.getByTestId('action-0-when-offline-select'), { target: { value: 'skip' } });
    });

    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'execute_command',
      command: 'whoami',
      whenOffline: 'skip',
    });
  });

  it('omits whenOffline entirely for an automation authored before the field existed', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1' });

    // The control SHOWS Queue (the server's default), but the payload must not
    // gain a field the operator never chose — a pre-#5128 action has to
    // round-trip byte-identically through an unrelated edit.
    expect((screen.getByTestId('action-0-when-offline-select') as HTMLSelectElement).value).toBe('queue');
    expect((putBody().actions as Array<Record<string, unknown>>)[0]).not.toHaveProperty('whenOffline');
  });

  it('reads a stored skip back into the form and round-trips it through an unrelated edit', async () => {
    await editAndSave({ type: 'run_script', scriptId: 's1', whenOffline: 'skip' });

    expect((screen.getByTestId('action-0-when-offline-select') as HTMLSelectElement).value).toBe('skip');
    expect((putBody().actions as Array<Record<string, unknown>>)[0]).toMatchObject({ whenOffline: 'skip' });
  });
});
