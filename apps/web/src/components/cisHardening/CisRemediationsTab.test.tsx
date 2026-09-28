import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
  registerOrgIdProvider: vi.fn(),
}));

import CisRemediationsTab from './CisRemediationsTab';

describe('CisRemediationsTab status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', async () => {
    render(<CisRemediationsTab />);
    expect(await screen.findByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
