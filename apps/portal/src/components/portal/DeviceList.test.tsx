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
          lastSeenAt: null,
          lastPatchAt: '2026-09-01T00:00:00Z',
          protection: 'protected',
          encryption: 'encrypted',
          lastBackupAt: null,
          warrantyEndsAt: '2027-01-01',
        },
      ]}
    />
  );

  const row = screen.getByTestId('portal-device-d-1');
  expect(row.textContent).toContain('Protected');
  expect(row.textContent).toContain('encrypted');
  expect(row.textContent).toContain('2027-01-01');
  expect(row.textContent).toContain('Not available');

  const exportLink = screen.getByTestId('portal-devices-export');
  expect(exportLink.getAttribute('href')).toBe('/api/v1/portal/devices/export.csv');
});
