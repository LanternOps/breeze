import '@/lib/i18n';
import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
fetchWithAuth.mockImplementation(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ data: [] }),
}));

vi.mock('@/stores/auth', () => ({
  fetchWithAuth,
  registerOrgIdProvider: vi.fn(),
}));

import { useOrgStore } from '@/stores/orgStore';

import RecommendationsPage from './RecommendationsPage';

describe('RecommendationsPage filter selects accessible name (#7156)', () => {
  it('gives the priority/category/status filter selects a real accessible name', async () => {
    render(<RecommendationsPage />);
    expect(await screen.findByRole('combobox', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

describe('RecommendationsPage org scope (#9642)', () => {
  it('refetches when the selected org changes', async () => {
    act(() => useOrgStore.setState({ currentOrgId: 'org-a' }));
    render(<RecommendationsPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const before = fetchWithAuth.mock.calls.length;

    act(() => useOrgStore.setState({ currentOrgId: 'org-b' }));

    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(before));
  });
});
