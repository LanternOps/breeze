import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import PeripheralActivityLog from './PeripheralActivityLog';
import { fetchWithAuth } from '../../stores/auth';

// #9621: the Device / Policy columns show names (joined server-side), not UUID prefixes.
describe('PeripheralActivityLog names (#9621)', () => {
  const event = {
    id: 'evt-1',
    eventType: 'blocked',
    peripheralType: 'storage',
    deviceId: '44444444-4444-4444-4444-444444444444',
    deviceName: 'Front Desk PC',
    policyId: '22222222-2222-2222-2222-222222222222',
    policyName: 'Block USB Storage',
    occurredAt: '2026-03-01T12:00:00.000Z',
  };

  it('shows the device hostname as a link and the policy name', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: vi.fn().mockResolvedValue({ data: [event], pagination: { total: 1, limit: 20, offset: 0 } }),
    } as unknown as Response);
    render(<PeripheralActivityLog />);
    const link = await screen.findByRole('link', { name: 'Front Desk PC' });
    expect(link).toHaveAttribute('href', `/devices/${event.deviceId}`);
    expect(screen.getByText('Block USB Storage')).toBeInTheDocument();
    expect(screen.queryByText(/44444444/)).toBeNull();
  });

  it('shows a translated peripheral type label, not the raw enum value', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: vi.fn().mockResolvedValue({ data: [{ ...event, peripheralType: 'bluetooth' }], pagination: { total: 1, limit: 20, offset: 0 } }),
    } as unknown as Response);
    render(<PeripheralActivityLog />);
    await screen.findByText('Front Desk PC');
    expect(screen.getByText('Bluetooth')).toBeInTheDocument();
    expect(screen.queryByText('bluetooth')).toBeNull();
  });

  it('keeps an unknown peripheral type visible as-is', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: vi.fn().mockResolvedValue({ data: [{ ...event, peripheralType: 'smartcard' }], pagination: { total: 1, limit: 20, offset: 0 } }),
    } as unknown as Response);
    render(<PeripheralActivityLog />);
    expect(await screen.findByText('smartcard')).toBeInTheDocument();
  });

  it('falls back to the id prefix when the name is unknown', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: vi.fn().mockResolvedValue({ data: [{ ...event, deviceName: null, policyName: null }], pagination: { total: 1, limit: 20, offset: 0 } }),
    } as unknown as Response);
    render(<PeripheralActivityLog />);
    expect(await screen.findByText('44444444...')).toBeInTheDocument();
  });
});

describe('PeripheralActivityLog event-filter select accessible name (#7156)', () => {
  it('gives the event-type filter select a real accessible name', async () => {
    render(<PeripheralActivityLog />);
    expect(await screen.findByRole('combobox', { name: 'Event type' })).toBeInTheDocument();
  });
});
