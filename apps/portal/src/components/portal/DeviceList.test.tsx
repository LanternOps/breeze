// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

// Resolving the full API module pulls in Astro's virtual transitions module,
// which is unavailable under Vitest. Keep the browser-facing path contract
// represented directly in this component test.
vi.mock('@/lib/api', () => ({
  publicApiPath: (path: string) => `/api/v1${path}`,
}));

import { DeviceList } from './DeviceList';

it('renders enrichment and a same-origin export action', () => {
  render(
    <DeviceList
      devices={[
        {
          id: 'd-1',
          hostname: 'Laptop',
          displayName: null,
          osType: 'windows',
          osVersion: '11',
          status: 'online',
          lastSeenAt: 'Sep 2, 2026, 5:00 AM MDT',
          lastPatchAt: 'Aug 31, 2026, 6:00 PM MDT',
          protection: 'protected',
          encryption: 'encrypted',
          lastBackupAt: 'Sep 2, 2026, 2:00 AM MDT',
          warrantyEndsAt: '2027-01-01',
        },
      ]}
    />
  );

  const row = screen.getByTestId('portal-device-d-1');
  expect(row.textContent).toContain('Protected');
  expect(row.textContent).toContain('encrypted');
  expect(row.textContent).toContain('2027-01-01');
  expect(row.textContent).toContain('Sep 2, 2026, 5:00 AM MDT');
  expect(row.textContent).toContain('Aug 31, 2026, 6:00 PM MDT');
  expect(row.textContent).toContain('Sep 2, 2026, 2:00 AM MDT');
  const cells = Array.from(row.querySelectorAll('td'));
  expect(cells.map((cell) => cell.className.match(/order-\d+/)?.[0])).toEqual([
    'order-1',
    'order-3',
    'order-2',
    'order-4',
    'order-5',
    'order-6',
    'order-7',
    'order-8',
    'order-9',
  ]);
  expect(cells.slice(4).map((cell) => cell.querySelector('.sm\\:hidden')?.textContent)).toEqual([
    'Last patch ',
    'Protection ',
    'Encryption ',
    'Last backup ',
    'Warranty ends ',
  ]);

  const exportLink = screen.getByTestId('portal-devices-export');
  expect(exportLink.getAttribute('href')).toBe('/api/v1/portal/devices/export.csv');
});
