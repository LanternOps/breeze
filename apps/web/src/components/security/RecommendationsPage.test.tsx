import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', async (importOriginal) => ({
  // orgStore (name lookup for the per-org rows) registers an org-id provider here.
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue({ data: [] }),
  }),
}));

import { fetchWithAuth } from '@/stores/auth';
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
    const mock = vi.mocked(fetchWithAuth);
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
      expect(sent(post!)).toContain(ORG_B);
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
      expect(sent(post!)).toContain(ORG_A);
    });
  });
});
