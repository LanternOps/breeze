import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorEditor from './MonitorEditor';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const toastMock = vi.mocked(showToast);
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: true, defaultOwnerScope: 'organization' }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const KINDS = [
  { kind: 'disk', overridableKeys: ['value'], defaultSeverity: 'high', agentDelivered: false },
  { kind: 'cpu', overridableKeys: ['value'], defaultSeverity: 'high', agentDelivered: false },
];

function defaultFetchImpl(input: string) {
  if (input.startsWith('/monitor-definitions/kinds')) return json({ data: KINDS });
  if (input.startsWith('/scripts')) return json({ data: [] });
  if (input.startsWith('/alerts/channels')) return json({ data: [] });
  if (input.startsWith('/alerts/policies')) return json({ data: [] });
  if (input.startsWith('/ai/agents')) return json({ data: [] });
  if (input.startsWith('/software/catalog')) return json({ data: [] });
  return json({ data: [] });
}

const MONITOR_M1_FIXTURE = {
  id: 'm1',
  name: 'Disk full',
  description: '',
  kind: 'disk',
  enabled: true,
  condition: { operator: 'gt', value: 90, durationMinutes: 5 },
  severity: 'high',
  cooldownMinutes: 5,
  autoResolve: false,
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
  escalationPolicyId: null,
  recurrenceThreshold: null,
  recurrenceWindowHours: null,
  recurrenceActions: [],
  pauseResponsesOnEscalation: true,
  aiAgentId: null,
  orgId: 'org-1',
  partnerId: null,
  attachments: [],
};

describe('MonitorEditor (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => defaultFetchImpl(input));
  });

  it.each([
    { orgId: null, partnerId: 'partner-1', label: 'Partner-wide' },
    { orgId: 'org-1', partnerId: null, label: 'Organization' },
  ])('shows the saved monitor owner in the detail header ($label)', async ({ orgId, partnerId, label }) => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE, orgId, partnerId } });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
    expect(screen.getByTestId('scope-badge')).toHaveTextContent(label);
  });

  const escalationPolicies = [
    { id: 'partner-policy', name: 'Partner policy', orgId: null, partnerId: 'partner-1' },
    { id: 'org-policy', name: 'Organization policy', orgId: 'org-1', partnerId: null },
    { id: 'other-org-policy', name: 'Other organization policy', orgId: 'org-2', partnerId: null },
  ];

  it.each([
    { orgId: null, partnerId: 'partner-1', expected: ['', 'partner-policy'] },
    { orgId: 'org-1', partnerId: null, expected: ['', 'partner-policy', 'org-policy'] },
  ])('offers only owner-compatible escalation policies for a saved monitor ($orgId, $partnerId)', async ({ orgId, partnerId, expected }) => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE, orgId, partnerId } });
      if (input === '/alerts/policies') return json({ data: escalationPolicies });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
    const picker = screen.getByTestId('monitor-editor-escalation-policy') as HTMLSelectElement;
    expect(Array.from(picker.options, (option) => option.value)).toEqual(expected);
  });

  it('clears an incompatible escalation policy when a new monitor switches to partner ownership', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/alerts/policies') return json({ data: escalationPolicies });
      if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id: 'new-1' } });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    const picker = screen.getByTestId('monitor-editor-escalation-policy') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(picker.options, (option) => option.value)).toContain('org-policy'));
    fireEvent.change(picker, { target: { value: 'org-policy' } });
    fireEvent.click(screen.getByTestId('monitor-editor-owner-partner'));
    expect(Array.from(picker.options, (option) => option.value)).toEqual(['', 'partner-policy']);
    expect(picker).toHaveValue('');
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Shared monitor' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    await waitFor(() => expect(navMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({ ownerScope: 'partner', escalationPolicyId: null });
  });

  it.each([
    { error: 'INVALID_MONITOR', details: 'Choose a compatible escalation policy.', expected: 'Choose a compatible escalation policy.' },
    { error: 'INVALID_MONITOR: Choose a compatible escalation policy.', expected: 'Choose a compatible escalation policy.' },
    { error: 'Permission denied', expected: 'Permission denied' },
  ])('shows save errors without a leading monitor machine code ($error)', async ({ expected, ...body }) => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json(body, false, 400);
      if (input === '/monitor-definitions/m1') return json({ data: MONITOR_M1_FIXTURE });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith({ type: 'error', message: expected }));
    expect(screen.getByTestId('monitor-editor-error')).toHaveTextContent(expected);
    expect(screen.getByTestId('monitor-editor-error')).not.toHaveTextContent('INVALID_MONITOR:');
  });

  it('create mode: switching kind to disk renders its fields with defaults and submits the right condition + ownerScope', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'disk' } });
    expect(screen.getByTestId('condition-field-operator')).toBeInTheDocument();
    expect(screen.getByTestId('condition-field-value')).toHaveValue(90);
    expect(screen.getByTestId('condition-field-durationMinutes')).toHaveValue(5);

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/alerts/monitors/new-1'));
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.condition).toEqual({ operator: 'gt', value: 90, durationMinutes: 5 });
    expect(body.ownerScope).toBe('organization');
  });

  it('converts a recurrence window in days to hours on submit', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-threshold'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-window-days'), { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.recurrenceThreshold).toBe(3);
    expect(body.recurrenceWindowHours).toBe(240);
  });

  it('allows clearing a previously-set recurrence threshold back to off (regression: valueAsNumber -> NaN blocked save)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-threshold'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-window-days'), { target: { value: '10' } });
    // Turn escalation back off by emptying both fields.
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-threshold'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('monitor-editor-recurrence-window-days'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.recurrenceThreshold).toBeNull();
    expect(body.recurrenceWindowHours).toBeNull();
  });

  it('omits an emptied optional condition field from the submitted payload instead of sending null (regression: valueAsNumber -> NaN)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'disk' } });
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    // durationMinutes is optional on the disk condition — clear it.
    fireEvent.change(screen.getByTestId('condition-field-durationMinutes'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect('durationMinutes' in body.condition).toBe(false);
  });

  it('offers ai_triage in the Respond action list only once an AI agent is selected', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.startsWith('/ai/agents')) return json({ data: [{ id: 'agent-1', name: 'Triage bot' }] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('option', { name: 'Triage bot' })).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: /add action/i })[0]);
    expect(screen.queryByRole('option', { name: /ai triage/i })).toBeNull();

    fireEvent.change(screen.getByTestId('monitor-editor-ai-agent'), { target: { value: 'agent-1' } });
    expect(screen.getByRole('option', { name: /ai triage/i })).toBeInTheDocument();
  });

  it('edit mode: loads the monitor, shows the Deployed card, and detaches an attachment', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) {
        return json({
          data: {
            id: 'm1',
            name: 'Disk full',
            description: '',
            kind: 'disk',
            enabled: true,
            condition: { operator: 'gt', value: 90, durationMinutes: 5 },
            severity: 'high',
            cooldownMinutes: 5,
            autoResolve: false,
            responses: [],
            deliveryMode: 'inherit',
            deliveryChannelIds: [],
            escalationPolicyId: null,
            recurrenceThreshold: null,
            recurrenceWindowHours: null,
            recurrenceActions: [],
            pauseResponsesOnEscalation: true,
            aiAgentId: null,
            orgId: 'org-1',
            partnerId: null,
            attachments: [
              { id: 'a1', configPolicyId: 'cp1', policyName: 'Site Policy', enabled: true, overrides: null },
            ],
          },
        });
      }
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      if (init?.method === 'DELETE' && input === '/monitor-definitions/m1/attachments/a1') return json({}, true, 204);
      if (input === '/devices') return json({ devices: [{ id: 'dev-1', hostname: 'HOST-1' }] });
      if (input === '/monitor-definitions/m1/test' && init?.method === 'POST') {
        return json({ data: { triggered: true, conditionsMet: [], conditionsNotMet: [], context: { deviceId: 'dev-1' } } });
      }
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    expect(screen.getByTestId('monitor-editor-deployed-card')).toBeInTheDocument();
    expect(screen.getByText('Site Policy')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('monitor-editor-detach-a1'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/monitor-definitions/m1/attachments/a1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    // Regression: a detach that succeeded at the API gave zero feedback in the UI.
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('edit mode: surfaces an error toast when detaching an attachment fails with a server error (regression: silent failure via runAction, sweep G1-4)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) {
        return json({
          data: {
            id: 'm1',
            name: 'Disk full',
            kind: 'disk',
            enabled: true,
            condition: { operator: 'gt', value: 90, durationMinutes: 5 },
            severity: 'high',
            cooldownMinutes: 5,
            autoResolve: false,
            responses: [],
            deliveryMode: 'inherit',
            deliveryChannelIds: [],
            recurrenceActions: [],
            pauseResponsesOnEscalation: true,
            orgId: 'org-1',
            partnerId: null,
            attachments: [
              { id: 'a1', configPolicyId: 'cp1', policyName: 'Site Policy', enabled: true, overrides: null },
            ],
          },
        });
      }
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      if (init?.method === 'DELETE' && input === '/monitor-definitions/m1/attachments/a1') {
        return json({ error: 'Internal error' }, false, 500);
      }
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    fireEvent.click(screen.getByTestId('monitor-editor-detach-a1'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    // The row must stay listed — a failed detach is not a detach.
    expect(screen.getByText('Site Policy')).toBeInTheDocument();
  });

  it('edit mode: surfaces an error banner when detaching an attachment fails (regression: silent no-op)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) {
        return json({
          data: {
            id: 'm1',
            name: 'Disk full',
            kind: 'disk',
            enabled: true,
            condition: { operator: 'gt', value: 90, durationMinutes: 5 },
            severity: 'high',
            cooldownMinutes: 5,
            autoResolve: false,
            responses: [],
            deliveryMode: 'inherit',
            deliveryChannelIds: [],
            recurrenceActions: [],
            pauseResponsesOnEscalation: true,
            orgId: 'org-1',
            partnerId: null,
            attachments: [
              { id: 'a1', configPolicyId: 'cp1', policyName: 'Site Policy', enabled: true, overrides: null },
            ],
          },
        });
      }
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      if (init?.method === 'DELETE' && input === '/monitor-definitions/m1/attachments/a1') {
        return json({ error: 'Policy not found' }, false, 404);
      }
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    fireEvent.click(screen.getByTestId('monitor-editor-detach-a1'));

    await waitFor(() => expect(screen.getByText('Policy not found')).toBeInTheDocument());
    // The row must stay listed — a failed detach is not a detach.
    expect(screen.getByText('Site Policy')).toBeInTheDocument();
  });

  it('edit mode: tests the monitor against a picked device', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) {
        return json({
          data: {
            id: 'm1',
            name: 'Disk full',
            kind: 'disk',
            enabled: true,
            condition: { operator: 'gt', value: 90, durationMinutes: 5 },
            severity: 'high',
            cooldownMinutes: 5,
            autoResolve: false,
            responses: [],
            deliveryMode: 'inherit',
            deliveryChannelIds: [],
            recurrenceActions: [],
            pauseResponsesOnEscalation: true,
            orgId: 'org-1',
            partnerId: null,
            attachments: [],
          },
        });
      }
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      if (input === '/devices') return json({ devices: [{ id: 'dev-1', hostname: 'HOST-1' }] });
      if (input === '/monitor-definitions/m1/test' && init?.method === 'POST') {
        expect(JSON.parse(init.body as string)).toEqual({ deviceId: 'dev-1' });
        return json({ data: { triggered: true, conditionsMet: [], conditionsNotMet: [], context: { deviceId: 'dev-1' } } });
      }
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    fireEvent.click(screen.getByTestId('monitor-editor-test-open'));
    await waitFor(() => expect(screen.getByTestId('monitor-editor-test-device')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('monitor-editor-test-device'), { target: { value: 'dev-1' } });
    fireEvent.click(screen.getByTestId('monitor-editor-test-run'));

    await waitFor(() => expect(screen.getByTestId('monitor-editor-test-result')).toHaveTextContent('HOST-1'));
  });

  it('edit mode: PATCHes the monitor on save and refetches (not POST, not the create-mode navigate)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) return json({ data: MONITOR_M1_FIXTURE });
      if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') return json({ data: { id: 'm1' } });
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full (renamed)' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/monitor-definitions/m1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions/m1' && (init as RequestInit)?.method === 'PATCH');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.name).toBe('Disk full (renamed)');
    expect(navMock).not.toHaveBeenCalled();
    // Edit-mode save re-fetches the monitor rather than navigating away.
    expect(fetchMock.mock.calls.filter(([url]) => url === '/monitor-definitions/m1').length).toBeGreaterThanOrEqual(2);
    // Regression: a save that succeeded at the API gave zero feedback in the UI.
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('edit mode: deletes the monitor via the confirm dialog and navigates to the list', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && !init) return json({ data: MONITOR_M1_FIXTURE });
      if (input === '/monitor-definitions/m1' && init?.method === 'DELETE') return json({}, true, 204);
      if (input === '/monitor-definitions/m1/devices') return json({ data: [] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    fireEvent.click(screen.getByTestId('monitor-editor-delete'));
    fireEvent.click(screen.getByTestId('monitor-editor-delete-confirm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m1', expect.objectContaining({ method: 'DELETE' })),
    );
    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/alerts/monitors'));
    // Regression: a delete that succeeded at the API gave zero feedback before navigating away.
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('reaches the delivery-mode radio choice in the submitted payload, and reveals the channel picker only for "channels"', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      if (input.startsWith('/alerts/channels')) return json({ data: [{ id: 'chan-1', name: 'Ops', type: 'email' }] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    expect(screen.queryByTestId('monitor-editor-channels')).toBeNull();
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-channels'));
    expect(screen.getByTestId('monitor-editor-channels')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.deliveryMode).toBe('channels');

    fireEvent.click(screen.getByTestId('monitor-editor-delivery-none'));
    expect(screen.queryByTestId('monitor-editor-channels')).toBeNull();
  });
});
