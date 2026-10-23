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

describe('RecommendationsPage card labels (#9643)', () => {
  const rec = (id: string, steps: string[]) => ({
    id,
    title: `Rec ${id}`,
    description: 'desc',
    priority: 'high',
    category: 'encryption',
    status: 'open',
    impact: 'high',
    effort: 'low',
    affectedDevices: 12,
    steps,
  });

  async function renderWithRecs() {
    fetchWithAuth.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: [rec('one', ['a']), rec('many', ['a', 'b', 'c'])],
      }),
    }));
    render(<RecommendationsPage />);
    await screen.findByText('Rec one');
  }

  it('renders spaced "label: value" metadata', async () => {
    await renderWithRecs();
    expect(screen.getAllByText(/Impact: high/i)).toHaveLength(2);
    expect(screen.getAllByText(/Effort: low/i)).toHaveLength(2);
    expect(screen.getAllByText(/Devices: 12/i)).toHaveLength(2);
  });

  it('pluralises the remediation steps toggle through i18n', async () => {
    await renderWithRecs();
    expect(screen.getByRole('button', { name: '1 remediation step' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3 remediation steps' })).toBeInTheDocument();
  });

  it('exposes stable test ids for E2E', async () => {
    await renderWithRecs();
    expect(screen.getByTestId('recommendations-page')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-card-one')).toBeInTheDocument();
    expect(screen.getByTestId('recommendation-card-many')).toBeInTheDocument();
  });
});
