// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityDeviceTable } from './SecurityDeviceTable';

it('renders customer-safe protection evidence and unknown values', () => {
  render(<SecurityDeviceTable devices={[{
    id: 'd-1',
    name: 'Laptop',
    protection: 'unknown',
    avProducts: [],
    realTimeProtection: null,
    definitionsAgeDays: null,
    encryption: null,
    firewall: null,
    pendingCriticalPatches: 0,
    observedAt: null,
  }]} />);

  const row = screen.getByTestId('portal-security-device-d-1');
  expect(row.textContent).toContain('Unknown');
  expect(row.textContent).toContain('Not available');
});
