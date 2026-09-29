import '@/lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, gate, navigateToMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  gate: { enabled: true, loaded: true },
  navigateToMock: vi.fn(async () => 'client'),
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
// The page exists only while the platform enrollment flag (runtime /config) is on.
vi.mock('../../stores/featuresStore', () => ({ usePreAssignmentGate: () => gate }));
vi.mock('../../lib/navigation', () => ({ navigateTo: navigateToMock }));
vi.mock('./AssignParkedDeviceDialog', () => ({
  default: (props: { devices: Array<{ id: string }>; onCompleted: () => void; onClose: () => void }) => (
    <div data-testid="dialog-stub">
      <span data-testid="dialog-devices">{props.devices.map((d) => d.id).join(',')}</span>
      <button type="button" data-testid="dialog-complete" onClick={props.onCompleted}>complete</button>
      <button type="button" data-testid="dialog-close" onClick={props.onClose}>close</button>
    </div>
  ),
}));

import UnassignedDevicesPage from './UnassignedDevicesPage';

const row = (id: string, hostname: string) => ({
  id,
  hostname,
  osType: 'windows',
  osVersion: '11',
  agentVersion: '1.0.0',
  status: 'online',
  serialNumber: `SER-${id}`,
  manufacturer: 'Dell',
  model: 'XPS',
  primaryMacAddress: null,
  parkedAt: '2026-09-27T10:00:00.000Z',
  lastSeenAt: null,
  deployKeyName: 'Spring rollout',
});

const list = (devices: unknown[]) => new Response(JSON.stringify({ devices }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

beforeEach(() => {
  fetchMock.mockReset();
  navigateToMock.mockClear();
  gate.enabled = true;
  gate.loaded = true;
  window.history.replaceState(null, '', '/devices/unassigned');
});
afterEach(() => {
  window.history.replaceState(null, '', '/devices/unassigned');
});

describe('UnassignedDevicesPage — platform enrollment flag', () => {
  it('with the flag off, renders nothing, reads nothing and sends the user to the device list', async () => {
    gate.enabled = false;
    const { container } = render(<UnassignedDevicesPage />);
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/devices', { replace: true }));
    expect(container.querySelector('[data-testid="unassigned-devices-page"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders nothing and does not redirect while the flag is still unknown', () => {
    gate.enabled = false;
    gate.loaded = false;
    const { container } = render(<UnassignedDevicesPage />);
    expect(container.querySelector('[data-testid="unassigned-devices-page"]')).toBeNull();
    expect(navigateToMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('UnassignedDevicesPage', () => {
  it('shows the empty state when nothing is waiting', async () => {
    fetchMock.mockResolvedValue(list([]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-devices-empty')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/pre-assignment/devices');
  });

  it('lists parked devices and labels their identity as device-reported', async () => {
    fetchMock.mockResolvedValue(list([row('d1', 'LAPTOP-1'), row('d2', 'LAPTOP-2')]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-device-row-d1')).toBeTruthy());
    expect(screen.getByTestId('parked-device-row-d2').textContent).toContain('LAPTOP-2');
    expect(screen.getByTestId('parked-device-row-d1').textContent).toContain('Spring rollout');
    expect(screen.getByTestId('parked-devices-reported-caption').textContent).toMatch(/not verified/i);
  });

  it('shows the API error when the list is refused', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Managing partner-wide state requires full partner org access' }), { status: 403 }));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-devices-error').textContent).toMatch(/full partner org access/));
  });

  it('Assign puts the device in the URL hash and opens the dialog for it; closing clears it', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(list([row('d1', 'LAPTOP-1')]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-device-assign-d1')).toBeTruthy());
    await user.click(screen.getByTestId('parked-device-assign-d1'));
    expect(window.location.hash).toBe('#d1');
    expect(screen.getByTestId('dialog-devices').textContent).toBe('d1');
    await user.click(screen.getByTestId('dialog-close'));
    expect(window.location.hash).toBe('');
    expect(screen.queryByTestId('dialog-stub')).toBeNull();
  });

  it('opens the dialog for a device named in the hash on load', async () => {
    window.history.replaceState(null, '', '/devices/unassigned#d2');
    fetchMock.mockResolvedValue(list([row('d1', 'LAPTOP-1'), row('d2', 'LAPTOP-2')]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('dialog-devices').textContent).toBe('d2'));
  });

  it('bulk assign needs two selected devices and passes exactly the selection', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(list([row('d1', 'A'), row('d2', 'B'), row('d3', 'C')]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-device-select-d1')).toBeTruthy());
    const bulk = screen.getByTestId('parked-devices-bulk-assign') as HTMLButtonElement;
    expect(bulk.disabled).toBe(true);
    await user.click(screen.getByTestId('parked-device-select-d1'));
    expect(bulk.disabled).toBe(true);
    await user.click(screen.getByTestId('parked-device-select-d3'));
    expect(bulk.disabled).toBe(false);
    await user.click(bulk);
    expect(screen.getByTestId('dialog-devices').textContent).toBe('d1,d3');
  });

  it('reloads the list after an assignment completes', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValueOnce(list([row('d1', 'A')])).mockResolvedValueOnce(list([]));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-device-assign-d1')).toBeTruthy());
    await user.click(screen.getByTestId('parked-device-assign-d1'));
    await user.click(screen.getByTestId('dialog-complete'));
    await waitFor(() => expect(screen.getByTestId('parked-devices-empty')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps a selection at 50 devices, the largest batch the server accepts', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 51 }, (_, i) => row(`d${i}`, `HOST-${i}`));
    fetchMock.mockResolvedValue(list(rows));
    render(<UnassignedDevicesPage />);
    await waitFor(() => expect(screen.getByTestId('parked-devices-select-all')).toBeTruthy());
    await user.click(screen.getByTestId('parked-devices-select-all'));
    expect(screen.getByTestId('parked-devices-bulk-assign').textContent).toContain('50');
    const last = screen.getByTestId('parked-device-select-d50') as HTMLInputElement;
    expect(last.checked).toBe(false);
    expect(last.disabled).toBe(true);
    expect(screen.getByTestId('parked-devices-selection-cap')).toBeTruthy();
  });
});
