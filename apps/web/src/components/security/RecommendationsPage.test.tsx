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

import RecommendationsPage from './RecommendationsPage';

describe('RecommendationsPage filter selects accessible name (#7156)', () => {
  it('gives the priority/category/status filter selects a real accessible name', async () => {
    render(<RecommendationsPage />);
    expect(await screen.findByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});
