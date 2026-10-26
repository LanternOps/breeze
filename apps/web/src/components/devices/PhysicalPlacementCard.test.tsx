import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PhysicalPlacementCard from './PhysicalPlacementCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const canMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: canMock }),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const ID = '22222222-2222-2222-2222-222222222222';
const FULL = { room: 'Server room', rack: 'R12', rackUnit: 5, heightU: 2 };
const EMPTY_BODY = { room: null, rack: null, rackUnit: null, heightU: null };

function res(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function getPayload(placement: unknown, authority: Record<string, unknown> = {}) {
  return { authority: { kind: 'device', id: ID, linked: false, ...authority }, placement };
}

function route(handlers: { get?: () => Response; put?: (body: unknown) => Response }) {
  fetchMock.mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') return handlers.put!(JSON.parse(String(init.body)));
    return handlers.get!();
  });
}

function putCalls() {
  return fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
}

describe('PhysicalPlacementCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMock.mockReturnValue(true);
  });

  it('renders the four fields for a device', async () => {
    route({ get: () => res(getPayload(FULL)) });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    expect(await screen.findByTestId('physical-placement-value-room')).toHaveTextContent('Server room');
    expect(screen.getByTestId('physical-placement-value-rack')).toHaveTextContent('R12');
    expect(screen.getByTestId('physical-placement-value-rackUnit')).toHaveTextContent('5');
    expect(screen.getByTestId('physical-placement-value-heightU')).toHaveTextContent('2');
    expect(fetchMock).toHaveBeenCalledWith(`/devices/${ID}/placement`);
  });

  it('renders an unlinked discovered asset against the discovery endpoint', async () => {
    route({ get: () => res(getPayload(null, { kind: 'discovered' })) });
    render(<PhysicalPlacementCard subject="discovered" id={ID} />);
    expect(await screen.findByTestId('physical-placement-value-room')).toHaveTextContent('—');
    expect(screen.getByTestId('physical-placement-edit')).toHaveTextContent('Add placement');
    expect(fetchMock).toHaveBeenCalledWith(`/discovery/assets/${ID}/placement`);
  });

  it('is read-only with a device link when the asset is linked', async () => {
    route({ get: () => res(getPayload(FULL, { linked: true, id: 'dev-9' })) });
    render(<PhysicalPlacementCard subject="discovered" id={ID} linkedDeviceName="SW-01" />);
    expect(await screen.findByTestId('physical-placement-linked')).toBeInTheDocument();
    expect(screen.queryByTestId('physical-placement-edit')).toBeNull();
    expect(screen.getByRole('link', { name: 'SW-01' })).toHaveAttribute('href', '/devices/dev-9');
    expect(screen.getByTestId('physical-placement-value-rack')).toHaveTextContent('R12');
  });

  it('hides Edit without devices:write', async () => {
    canMock.mockReturnValue(false);
    route({ get: () => res(getPayload(FULL)) });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    await screen.findByTestId('physical-placement-value-room');
    expect(screen.queryByTestId('physical-placement-edit')).toBeNull();
  });

  it('PUTs numbers and null for blank fields', async () => {
    const put = vi.fn((body: unknown) => res(getPayload(body)));
    route({ get: () => res(getPayload(null)), put });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.change(screen.getByTestId('physical-placement-room'), { target: { value: ' Lab ' } });
    fireEvent.change(screen.getByTestId('physical-placement-rackUnit'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith({ room: 'Lab', rack: null, rackUnit: 7, heightU: null });
    await waitFor(() => expect(screen.getByTestId('physical-placement-value-room')).toHaveTextContent('Lab'));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('removes the placement with an all-null body', async () => {
    const put = vi.fn(() => res(getPayload(null)));
    route({ get: () => res(getPayload(FULL)), put });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.click(screen.getByTestId('physical-placement-remove'));
    await waitFor(() => expect(put).toHaveBeenCalledWith(EMPTY_BODY));
    await waitFor(() => expect(screen.getByTestId('physical-placement-value-room')).toHaveTextContent('—'));
  });

  it('an emptied form saves as removal', async () => {
    const put = vi.fn(() => res(getPayload(null)));
    route({ get: () => res(getPayload(FULL)), put });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    for (const k of ['room', 'rack', 'rackUnit', 'heightU']) {
      fireEvent.change(screen.getByTestId(`physical-placement-${k}`), { target: { value: '' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(EMPTY_BODY));
  });

  it('validates on the client and does not send', async () => {
    route({ get: () => res(getPayload(null)), put: () => res({}) });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.change(screen.getByTestId('physical-placement-rackUnit'), { target: { value: '101' } });
    fireEvent.change(screen.getByTestId('physical-placement-heightU'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByTestId('physical-placement-room'), { target: { value: 'x'.repeat(256) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findAllByRole('alert')).toHaveLength(3);
    expect(putCalls()).toHaveLength(0);
  });

  it('409 concurrent update toasts friendly copy and re-reads', async () => {
    let gets = 0;
    route({
      get: () => { gets += 1; return res(getPayload(gets > 1 ? { ...FULL, room: 'Fresh' } : FULL)); },
      put: () => res({ error: 'x', code: 'PLACEMENT_CONCURRENT_UPDATE' }, 409),
    });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('physical-placement-value-room')).toHaveTextContent('Fresh'));
    expect(gets).toBe(2);
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('changed elsewhere') }),
    );
  });

  it('409 authority device toasts and reloads into read-only', async () => {
    let gets = 0;
    route({
      get: () => { gets += 1; return res(getPayload(FULL, gets > 1 ? { linked: true, id: 'dev-9' } : {})); },
      put: () => res({ error: 'x', code: 'PLACEMENT_AUTHORITY_DEVICE', deviceId: 'dev-9' }, 409),
    });
    render(<PhysicalPlacementCard subject="discovered" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('physical-placement-linked')).toBeInTheDocument();
    expect(screen.queryByTestId('physical-placement-edit')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('linked to a managed device') }),
    );
  });

  it('403 MFA_REQUIRED surfaces a friendly error', async () => {
    route({
      get: () => res(getPayload(FULL)),
      put: () => res({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403),
    });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('Multi-factor') }),
      ),
    );
    // Stays in edit mode so the input is not lost.
    expect(screen.getByTestId('physical-placement-room')).toBeInTheDocument();
  });

  it('403 site denial on save is surfaced, not silent', async () => {
    route({
      get: () => res(getPayload(FULL)),
      put: () => res({ error: 'Access to this site denied' }, 403),
    });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    fireEvent.click(await screen.findByTestId('physical-placement-edit'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Access to this site denied' }),
      ),
    );
  });

  it('shows a load failure when GET is forbidden', async () => {
    route({ get: () => res({ error: 'Access to this site denied' }, 403) });
    render(<PhysicalPlacementCard subject="device" id={ID} />);
    expect(await screen.findByText(/Couldn't load physical placement/)).toBeInTheDocument();
    expect(screen.queryByTestId('physical-placement-edit')).toBeNull();
  });
});
