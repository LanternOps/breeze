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

import CisComplianceTab from './CisComplianceTab';

describe('CisComplianceTab OS filter select accessible name (#7156)', () => {
  it('gives the OS filter select a real accessible name', async () => {
    render(<CisComplianceTab />);
    expect(await screen.findByRole('combobox', { name: 'Operating system' })).toBeInTheDocument();
  });
});
