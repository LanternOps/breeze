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
}));

import VulnerabilitiesPage from './VulnerabilitiesPage';

describe('VulnerabilitiesPage filter selects accessible name (#7156)', () => {
  it('gives the severity/status/category filter selects a real accessible name', async () => {
    render(<VulnerabilitiesPage />);
    expect(await screen.findByRole('combobox', { name: 'Severity' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
  });
});
