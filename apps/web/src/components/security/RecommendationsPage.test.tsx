import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('RecommendationsPage per-org actions (#9714)', () => {
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const rec = (orgs: unknown[]) => ({
    id: 'rec-enable-firewall', title: 'Enable firewall', description: 'd', priority: 'high',
    category: 'firewall', status: 'open', impact: 'high', effort: 'low', affectedDevices: 3, steps: [], orgs,
  });
  const mockList = (orgs: unknown[]) => {
    const mock = fetchWithAuth;
    mock.mockReset();
    mock.mockImplementation((async (_url: string, init?: { method?: string }) => ({
      ok: true, status: 200, statusText: 'OK',
      json: async () => (init?.method === 'POST'
        ? { data: { id: 'rec-enable-firewall', status: 'completed' } }
        : { data: [rec(orgs)], summary: { total: 1, open: 1, completed: 0, dismissed: 0, criticalAndHigh: 1 } }),
    })) as never);
    return mock;
  };
  const findPost = (mock: ReturnType<typeof mockList>) =>
    mock.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
  const sent = (call: NonNullable<ReturnType<typeof findPost>>) => String(call[0]) + JSON.stringify(call[1]);

  it('acts per org: a completed org offers Reopen, an open org offers Complete/Dismiss, and each sends its own org + action', async () => {
    const mock = mockList([
      { orgId: ORG_A, status: 'completed', affectedDevices: 2 },
      { orgId: ORG_B, status: 'open', affectedDevices: 1 },
    ]);
    render(<RecommendationsPage />);
    const reopen = await screen.findByRole('button', { name: /reopen/i });
    expect(screen.getAllByRole('button', { name: /mark complete/i })).toHaveLength(1);
    fireEvent.click(reopen);
    await waitFor(() => {
      const post = findPost(mock);
      expect(post).toBeTruthy();
      expect(post![0]).toBe('/security/recommendations/rec-enable-firewall/reopen');
      expect(post![1]).toMatchObject({ method: 'POST', orgIdOverride: ORG_A });
    });
  });

  it("sends the clicked org's id with Mark Complete when a rec spans several orgs", async () => {
    const mock = mockList([
      { orgId: ORG_A, status: 'open', affectedDevices: 2 },
      { orgId: ORG_B, status: 'open', affectedDevices: 1 },
    ]);
    render(<RecommendationsPage />);
    const buttons = await screen.findAllByRole('button', { name: /mark complete/i });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    await waitFor(() => {
      const post = findPost(mock);
      expect(post).toBeTruthy();
      expect(post![1]).toMatchObject({ method: 'POST', orgIdOverride: ORG_B });
      expect(sent(post!)).not.toContain(ORG_A);
    });
  });

  it('sends the sole org id for a single-org recommendation', async () => {
    const mock = mockList([{ orgId: ORG_A, status: 'open', affectedDevices: 3 }]);
    render(<RecommendationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    await waitFor(() => {
      const post = findPost(mock);
      expect(post).toBeTruthy();
      expect(post![0]).toBe('/security/recommendations/rec-enable-firewall/dismiss');
      expect(post![1]).toMatchObject({ method: 'POST', orgIdOverride: ORG_A });
    });
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
