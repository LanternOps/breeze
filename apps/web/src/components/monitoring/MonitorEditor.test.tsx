import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
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

vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));

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
  if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({ data: [], inherited: [] });
  if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: [] });
if (input.startsWith('/alerts/delivery/resolve')) return json({ skippedChannelIds: [], channelIds: [],
  escalationPolicyId: null, source: 'none', description: { channels: [], escalationPolicy: null, owner: null } });
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

describe('MonitorEditor owner scope hydration (#6391)', () => {
  it('omits the owner-scope block from the server markup so hydration matches', () => {
    // `isPartnerScope` is browser-only (it decodes the access token), so the
    // block must not appear until after hydration — otherwise the client's
    // <fieldset> lands where the server emitted the next <section> and React
    // discards the editor subtree.
    window.history.replaceState(null, '', '/alerts/monitors/new');
    const html = renderToString(<MonitorEditor />);
    expect(html).not.toContain('monitor-editor-owner-scope');
  });

  it('renders the owner-scope block for a partner-scope session in the browser', async () => {
    window.history.replaceState(null, '', '/alerts/monitors/new');
    fetchMock.mockImplementation(async (input: string) => defaultFetchImpl(input));
    render(<MonitorEditor />);
    expect(await screen.findByTestId('monitor-editor-owner-scope')).toBeTruthy();
  });
});

describe('MonitorEditor (#5289)', () => {
  it('creates and attaches to the policy selected in the hash', async () => {
    const policyId = '10000000-0000-4000-8000-000000000009';
    const id = '20000000-0000-4000-8000-000000000001';
    window.history.replaceState(null, '', `/alerts/monitors/new#policy=${policyId}`);
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id } }, true, 201);
      if (input === `/monitor-definitions/${id}/attachments`) return json({ data: {} });
      return defaultFetchImpl(input);
    });
    try {
      render(<MonitorEditor />);
      fireEvent.change(await screen.findByTestId('monitor-editor-name'), { target: { value: 'CPU high' } });
      fireEvent.click(screen.getByTestId('monitor-editor-save'));
      await waitFor(() => expect(navMock).toHaveBeenCalledWith(`/configuration-policies/${policyId}#monitors`));
      expect(fetchMock).toHaveBeenCalledWith(`/monitor-definitions/${id}/attachments`, {
        method: 'POST', body: JSON.stringify({ configPolicyId: policyId }),
      });
    } finally { window.history.replaceState(null, '', '/'); }
  });

  it('leaves create mode after attachment failure and never creates twice', async () => {
    const policyId = '10000000-0000-4000-8000-000000000009';
    const id = '20000000-0000-4000-8000-000000000001';
    window.history.replaceState(null, '', `/alerts/monitors/new#policy=${policyId}`);
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id } }, true, 201);
      if (input === `/monitor-definitions/${id}/attachments`) return json({ error: 'Attach failed' }, false, 500);
      return defaultFetchImpl(input);
    });
    try {
      render(<MonitorEditor />);
      fireEvent.change(await screen.findByTestId('monitor-editor-name'), { target: { value: 'CPU high' } });
      fireEvent.click(screen.getByTestId('monitor-editor-save'));
      await waitFor(() => expect(navMock).toHaveBeenCalledWith(`/alerts/monitors/${id}#policy=${policyId}`));
      fireEvent.submit(screen.getByTestId('monitor-editor-save').closest('form')!);
      await waitFor(() => expect(navMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls.filter(([url, init]) => url === '/monitor-definitions' && init?.method === 'POST')).toHaveLength(1);
      const errors = toastMock.mock.calls.filter(([toast]) => toast.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0][0].message).toContain('Monitor saved');
      expect(errors[0][0].message).toContain('Failed to attach');
    } finally { window.history.replaceState(null, '', '/'); }
  });

  it('preserves the policy hash through actual editor tab clicks', async () => {
    const policyId = '10000000-0000-4000-8000-000000000009';
    window.history.replaceState(null, '', `/alerts/monitors/m1#policy=${policyId}`);
    fetchMock.mockImplementation(async (input: string) => input === '/monitor-definitions/m1'
      ? json({ data: MONITOR_M1_FIXTURE }) : defaultFetchImpl(input));
    try {
      render(<MonitorEditor monitorId="m1" />);
      await screen.findByTestId('monitor-editor-tab-activity');
      fireEvent.click(screen.getByTestId('monitor-editor-tab-activity'));
      expect(new URLSearchParams(window.location.hash.slice(1)).get('policy')).toBe(policyId);
      fireEvent.click(screen.getByTestId('monitor-editor-tab-settings'));
      expect(new URLSearchParams(window.location.hash.slice(1)).get('policy')).toBe(policyId);
    } finally { window.history.replaceState(null, '', '/'); }
  });
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
      if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: escalationPolicies });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));
    const picker = screen.getByTestId('monitor-editor-escalation-policy') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(picker.options, (option) => option.value)).toEqual(expected));
  });

  it('clears an incompatible escalation policy when a new monitor switches to partner ownership', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: escalationPolicies });
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

  it('blocks the save on a condition the shared schema rejects and says why (#6371 W05c2 Task 12)', async () => {
    fetchMock.mockImplementation(async (input: string) => defaultFetchImpl(input));
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'disk' } });
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    // percentThresholdCondition caps value at 100.
    fireEvent.change(screen.getByTestId('condition-field-value'), { target: { value: '150' } });
    // submit() rather than a click: the input's native max=100 would block a
    // click-submit before react-hook-form's resolver ever runs.
    fireEvent.submit(screen.getByTestId('monitor-editor-save').closest('form')!);

    expect(await screen.findByTestId('monitor-editor-condition-error')).toHaveTextContent(
      'Some condition values are missing or out of range',
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => ['POST', 'PATCH'].includes(String((init as RequestInit)?.method))),
    ).toBe(false);
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
      if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({ data: [{ id: 'chan-1', name: 'Ops', type: 'email' }] });
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

  it('create mode: retains the chosen script id for a script-check monitor on submit (#6207)', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/monitor-definitions') return json({ data: { id: 'new-1' } }, true, 201);
      if (input.startsWith('/scripts')) {
        return json({ data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Disk cleanup' }] });
      }
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('monitor-editor-kind'), { target: { value: 'script' } });
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Disk cleanup' })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('condition-field-scriptId'), {
      target: { value: '11111111-2222-4333-8444-555555555555' },
    });
    expect(screen.getByTestId('condition-field-scriptId')).toHaveValue('11111111-2222-4333-8444-555555555555');

    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Script check' } });
    fireEvent.click(screen.getByTestId('monitor-editor-save'));

    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/alerts/monitors/new-1'));
    const call = fetchMock.mock.calls.find(([url, init]) => url === '/monitor-definitions' && (init as RequestInit)?.method === 'POST');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.condition.scriptId).toBe('11111111-2222-4333-8444-555555555555');
  });

  it('edit mode: retains the previously-saved script — in the picker AND on save — even when the script list resolves after the monitor (#6207)', async () => {
    let resolveScripts: (value: Response) => void = () => {};
    const scriptsPromise = new Promise<Response>((resolve) => {
      resolveScripts = resolve;
    });
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/monitor-definitions/m1' && init?.method === 'PATCH') {
        return json({ data: { id: 'm1' } });
      }
      if (input === '/monitor-definitions/m1') {
        return json({
          data: {
            ...MONITOR_M1_FIXTURE,
            kind: 'script',
            condition: {
              scriptId: '11111111-2222-4333-8444-555555555555',
              intervalMinutes: 60,
              timeoutSeconds: 300,
              breachOnNonZeroExit: true,
            },
          },
        });
      }
      if (input.startsWith('/scripts')) return scriptsPromise;
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Disk full'));

    // The scripts list resolves AFTER the monitor has already loaded and reset()
    // has run — the select's <option> for the saved script doesn't exist yet at
    // that point.
    resolveScripts(json({ data: [{ id: '11111111-2222-4333-8444-555555555555', name: 'Disk cleanup' }] }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Disk cleanup' })).toBeInTheDocument());

    // Assert inside its own `waitFor` — the option appearing and the select's
    // `value` prop re-syncing both happen off the same `setScripts` state
    // update but are two separate observations of the DOM, so give React a
    // tick to settle rather than asserting immediately after the first one.
    await waitFor(() =>
      expect(screen.getByTestId('condition-field-scriptId')).toHaveValue('11111111-2222-4333-8444-555555555555'),
    );

    // Saving WITHOUT touching the field must still submit the real scriptId —
    // this is what actually determines whether the monitor alerts (#6207's
    // second symptom: monitorScriptWorker silently skips a monitor whose
    // stored scriptId doesn't resolve to a script row).
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, i]) => url === '/monitor-definitions/m1' && (i as RequestInit)?.method === 'PATCH'),
      ).toBe(true),
    );
    const patchCall = fetchMock.mock.calls.find(
      ([url, i]) => url === '/monitor-definitions/m1' && (i as RequestInit)?.method === 'PATCH',
    );
    const patchBody = JSON.parse((patchCall![1] as RequestInit).body as string);
    expect(patchBody.condition.scriptId).toBe('11111111-2222-4333-8444-555555555555');
  });
  it('previews unsaved Inherit instead of the saved channels mode, and keeps delivery configuration at its home', async () => {
    fetchMock.mockImplementation(async input => {
      if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE, deliveryMode: 'channels', deliveryChannelIds: ['ch'] } });
      if (input.startsWith('/alerts/delivery/resolve')) return json({ skippedChannelIds: [], channelIds: ['ch'], escalationPolicyId: null,
        source: 'default_row', routingRuleName: 'Everything else', description: {
          channels: [{ id: 'ch', name: 'NOC', enabled: true }], escalationPolicy: null, owner: 'partner' } });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await screen.findByDisplayValue('Disk full');
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-inherit'));
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('NOC');
    const calls = fetchMock.mock.calls.filter(([url]) => url.startsWith('/alerts/delivery/resolve'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([url]) => !url.includes('monitorId='))).toBe(true);
    expect(screen.getByTestId('monitor-editor-delivery-home')).toHaveAttribute('href', '/alerts/delivery');
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-none'));
    expect(screen.queryByTestId('delivery-preview-result')).toBeNull();
    expect(screen.queryByTestId('monitor-editor-escalation-policy')).toBeNull();
  });

  it.each(['create', 'edit'] as const)('%s selects inherited channels and escalation and saves their IDs', async mode => {
    const inheritedChannel = { id: 'partner-channel', name: 'Partner NOC', type: 'slack', enabled: true, inherited: true };
    const inheritedPolicy = { id: 'partner-policy', name: 'Partner escalation', stepCount: 1, inherited: true };
    const saved = { ...MONITOR_M1_FIXTURE, deliveryMode: 'channels',
      deliveryChannelIds: [inheritedChannel.id], escalationPolicyId: inheritedPolicy.id };
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({
        data: [{ id: 'org-channel', name: 'Org email', type: 'email', config: {} }], inherited: [inheritedChannel],
      });
      if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: [inheritedPolicy] });
      if (input === '/monitor-definitions/m1') return json({ data: saved });
      if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id: 'new-1' } }, true, 201);
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId={mode === 'edit' ? 'm1' : undefined} />);
    await screen.findByTestId('monitor-editor-name');
    if (mode === 'create') {
      fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
      fireEvent.click(screen.getByTestId('monitor-editor-delivery-channels'));
    }
    await screen.findByRole('option', { name: 'Partner NOC (slack)' });
    await screen.findByRole('option', { name: 'Partner escalation' });
    const channelPicker = screen.getByTestId('monitor-editor-channels') as HTMLSelectElement;
    const policyPicker = screen.getByTestId('monitor-editor-escalation-policy');
    expect(Array.from(channelPicker.options, option => option.value)).toEqual(['org-channel', 'partner-channel']);
    if (mode === 'create') {
      for (const option of channelPicker.options) option.selected = option.value === inheritedChannel.id;
      fireEvent.change(channelPicker);
      fireEvent.change(policyPicker, { target: { value: inheritedPolicy.id } });
    }
    expect(channelPicker).toHaveValue([inheritedChannel.id]);
    expect(policyPicker).toHaveValue(inheritedPolicy.id);
    fireEvent.click(screen.getByTestId('monitor-editor-save'));
    const method = mode === 'edit' ? 'PATCH' : 'POST';
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === method)!;
    expect(JSON.parse(init!.body as string)).toMatchObject({ deliveryMode: 'channels',
      deliveryChannelIds: [inheritedChannel.id], escalationPolicyId: inheritedPolicy.id });
    const rails = fetchMock.mock.calls.filter(([url]) => url.startsWith('/alerts/delivery/rails'));
    expect(rails.some(([url]) => url === '/alerts/delivery/rails?rail=channels&orgId=org-1')).toBe(true);
    expect(rails.some(([url]) => url === '/alerts/delivery/rails?rail=escalation&orgId=org-1')).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/alerts/channels') || url.startsWith('/alerts/policies'))).toBe(false);
  });
  it('late inherited choices do not refetch the monitor or overwrite unsaved edits', async () => {
    let finishChannels!: (response: Response) => void;
    fetchMock.mockImplementation(async (input: string) => {
      if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE,
        deliveryMode: 'channels', deliveryChannelIds: ['partner-channel'], escalationPolicyId: 'partner-policy' } });
      if (input.startsWith('/alerts/delivery/rails?rail=channels')) return new Promise<Response>(resolve => { finishChannels = resolve; });
      if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: [
        { id: 'partner-policy', name: 'Partner escalation', stepCount: 1, inherited: true },
      ] });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await screen.findByDisplayValue('Disk full');
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Draft name' } });
    await act(async () => finishChannels(json({ data: [], inherited: [{ id: 'partner-channel', name: 'Partner NOC', type: 'slack', enabled: true, inherited: true }] })));
    expect(await screen.findByRole('option', { name: 'Partner NOC (slack)' })).toBeInTheDocument();
    expect(screen.getByTestId('monitor-editor-channels')).toHaveValue(['partner-channel']);
    expect(screen.getByTestId('monitor-editor-escalation-policy')).toHaveValue('partner-policy');
    expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Draft name');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/monitor-definitions/m1')).toHaveLength(1);
  });

});
