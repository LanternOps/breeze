import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorEditor from './MonitorEditor';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
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

describe('MonitorEditor (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => defaultFetchImpl(input));
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

    await waitFor(() => expect(navMock).toHaveBeenCalledWith('/monitoring/monitors/new-1'));
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
});
