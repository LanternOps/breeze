import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DeviceHardwareInventory from './DeviceHardwareInventory';
import { view } from './hardware/hardwareHealth.fixtures';
vi.mock('./DeviceWarrantyCard', () => ({ default: () => null }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/hardware-health') ? view() : { cpuModel: 'CPU model', disks: [], networkAdapters: [] },
  ), { status: 200 })),
}));
it('places Storage & RAID after the summary and before the disk table', async () => {
  render(<DeviceHardwareInventory deviceId="22222222-2222-4222-8222-222222222222" />);
  const section = await screen.findByTestId('hardware-storage-section');
  const cpu = screen.getByText('CPU model');
  const diskHeading = screen.getByText('Disk Drives');
  expect(cpu.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(section.compareDocumentPosition(diskHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(await screen.findByTestId('hardware-controller-card')).toBeInTheDocument();
});
