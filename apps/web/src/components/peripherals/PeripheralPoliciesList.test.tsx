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
  registerOrgIdProvider: vi.fn(),
}));

import PeripheralPoliciesList from './PeripheralPoliciesList';

describe('PeripheralPoliciesList filter selects accessible name (#7156)', () => {
  it('gives the class/action/status filter selects a real accessible name', async () => {
    render(<PeripheralPoliciesList />);
    expect(await screen.findByRole('combobox', { name: 'Device class' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Action' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
