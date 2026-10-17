import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import EdrActionButtons from './EdrActionButtons';
import type { EdrEndpoint } from '@/lib/edrProviders';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const KILLED = 'Response actions are disabled on this server';

const res = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

type Act = { action: string; available: boolean; reason: string | null; mfaRequired?: boolean };
const allOk: Act[] = [
  { action: 'isolate', available: true, reason: null },
  { action: 'unisolate', available: true, reason: null },
  { action: 'scan', available: true, reason: null },
];

function endpoint(actions: Act[] | undefined): EdrEndpoint {
  return {
    id: 'ep-1', orgId: 'o', connectionId: 'c', tenantId: 't', tenantName: null, provider: 'bitdefender',
    vendorEndpointId: 'v', hostname: 'LAPTOP-7', fqdn: null, osPlatform: 'windows', osName: null,
    agentVersion: null, health: 'healthy', online: true, isolationState: 'not_isolated', lastSeenAt: null,
    breezeDeviceId: 'dev-1', deviceMatchSource: null, ...(actions ? { actions } : {}),
  } as EdrEndpoint;
}

function mount(actions: Act[] | undefined, onActionTaken = vi.fn()) {
  render(<EdrActionButtons endpoint={endpoint(actions)} deviceName="LAPTOP-7" onActionTaken={onActionTaken} />);
  return onActionTaken;
}

const postCalls = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('EdrActionButtons rendering', () => {
  it('renders nothing when the endpoint carries no actions', () => {
    mount(undefined);
    expect(screen.queryByTestId('edr-actions')).toBeNull();
  });

  it('renders a disabled button with the reason as tooltip for an unavailable action', () => {
    mount([
      { action: 'isolate', available: false, reason: 'Endpoint is offline' },
      { action: 'scan', available: true, reason: null },
    ]);
    const btn = screen.getByTestId('edr-action-isolate');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Endpoint is offline');
    expect(screen.getByTestId('edr-action-scan')).toBeEnabled();
  });

  it('hides every button when all actions are unavailable for the kill-switch reason', () => {
    mount(allOk.map((a) => ({ ...a, available: false, reason: KILLED })));
    expect(screen.queryByTestId('edr-actions')).toBeNull();
    expect(screen.queryByTestId('edr-action-scan')).toBeNull();
  });

  it('shows the MFA prompt and disables the button when mfaRequired', () => {
    mount(allOk.map((a) => ({ ...a, available: false, reason: 'MFA required', mfaRequired: true })));
    expect(screen.getByTestId('edr-actions-mfa')).toHaveTextContent('Verify with MFA to run response actions');
    expect(screen.getByTestId('edr-action-scan')).toBeDisabled();
  });
});

describe('EdrActionButtons requests', () => {
  it('requires a confirm dialog for isolate and sends the reason only after confirm', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ endpointId: 'ep-1', actionId: 'a1', status: 'submitted', outcomeUnknown: false }] }));
    const taken = mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-isolate'));
    expect(postCalls()).toHaveLength(0);
    expect(await screen.findByText(/loses network access except to Bitdefender GravityZone/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('edr-action-reason'), { target: { value: ' ransomware ' } });
    fireEvent.click(screen.getByTestId('edr-action-confirm'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [url, init] = postCalls()[0]!;
    expect(url).toBe('/edr/actions');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      targetKind: 'endpoint', endpointIds: ['ep-1'], action: 'isolate', reason: 'ransomware',
    });
    await waitFor(() => expect(taken).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('requires a confirm dialog for unisolate', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ outcomeUnknown: false }] }));
    mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-unisolate'));
    expect(postCalls()).toHaveLength(0);
    fireEvent.click(await screen.findByTestId('edr-action-confirm'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse((postCalls()[0]![1] as RequestInit).body as string)).toMatchObject({ action: 'unisolate' });
    expect(JSON.parse((postCalls()[0]![1] as RequestInit).body as string)).not.toHaveProperty('reason');
  });

  it('scan is one click, no dialog, with a success toast', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ outcomeUnknown: false }] }));
    mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-scan'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(screen.queryByTestId('edr-action-confirm')).toBeNull();
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('202 outcomeUnknown shows the neutral confirming state with no error toast', async () => {
    fetchMock.mockResolvedValue(res({ data: [{ endpointId: 'ep-1', outcomeUnknown: true, status: 'queued' }] }, 202));
    mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-scan'));
    expect(await screen.findByTestId('edr-action-confirming')).toHaveTextContent('confirming with Bitdefender GravityZone');
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('409 action_in_progress is an info (warning) toast, never an error', async () => {
    fetchMock.mockResolvedValue(res({ error: 'busy', code: 'action_in_progress', data: [] }, 409));
    mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-scan'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' })));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('401 is silent', async () => {
    fetchMock.mockResolvedValue(res({}, 401));
    mount(allOk);
    fireEvent.click(screen.getByTestId('edr-action-scan'));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(toastMock).not.toHaveBeenCalled();
  });
});
