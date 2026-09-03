// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityDeviceTable } from './SecurityDeviceTable';

it('renders all security evidence, including freshness in the organization timezone', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={[
    {
      id: 'd-1',
      name: 'Laptop',
      protection: 'protected',
      avProducts: ['Defender'],
      realTimeProtection: true,
      definitionsAgeDays: 1,
      encryption: 'encrypted',
      firewall: true,
      pendingCriticalPatches: 0,
      observedAt: '2026-09-02T12:00:00.000Z',
    },
    {
      id: 'd-2',
      name: 'Desktop',
      protection: 'unprotected',
      avProducts: [],
      realTimeProtection: false,
      definitionsAgeDays: null,
      encryption: null,
      firewall: null,
      pendingCriticalPatches: 2,
      observedAt: null,
    },
    {
      id: 'd-3',
      name: 'Server',
      protection: 'unknown',
      avProducts: [],
      realTimeProtection: null,
      definitionsAgeDays: null,
      encryption: null,
      firewall: null,
      pendingCriticalPatches: 0,
      observedAt: null,
    },
  ]} />);

  const row = screen.getByTestId('portal-security-device-d-1');
  expect(screen.getByTestId('portal-security-device-d-1-real-time-protection').textContent).toBe('On');
  expect(row.textContent).toContain('Sep 2, 2026');
  expect(row.textContent).toContain('6:00 AM MDT');
  expect(row.textContent).toContain('America/Denver');

  const unavailableRow = screen.getByTestId('portal-security-device-d-2');
  expect(screen.getByTestId('portal-security-device-d-2-real-time-protection').textContent).toBe('Off');
  expect(unavailableRow.textContent).toContain('Not available');
  expect(screen.getByTestId('portal-security-device-d-3-real-time-protection').textContent).toBe('Not available');
  expect(screen.getByText('Real-time protection')).toBeTruthy();
  expect(screen.getByText('Observed at')).toBeTruthy();
});
