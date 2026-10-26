import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DeviceHardwareInventory from './DeviceHardwareInventory';

vi.mock('./DeviceWarrantyCard', () => ({ default: () => null }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) =>
    new Response(
      JSON.stringify(
        url.endsWith('/hardware-health')
          ? { error: 'no_hardware_health' }
          : {
              cpuModel: 'CPU model',
              networkAdapters: [],
              disks: [{ name: 'C:', sizeGb: 200, usedGb: 150, health: 'healthy' }],
            },
      ),
      { status: 200 },
    ),
  ),
}));

it('renders the used percentage in the disk table (#9610)', async () => {
  render(<DeviceHardwareInventory deviceId="22222222-2222-4222-8222-222222222222" />);
  expect(await screen.findByText('75%')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: /used %/i })).toBeInTheDocument();
});
