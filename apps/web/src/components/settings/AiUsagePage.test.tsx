import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null }) }));

import AiUsagePage from './AiUsagePage';

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function usageBody(billedTo?: 'platform' | 'partner_key') {
  return {
    daily: { inputTokens: 10, outputTokens: 20, totalCostCents: 5, messageCount: 1 },
    monthly: { inputTokens: 100, outputTokens: 200, totalCostCents: 50, messageCount: 10 },
    budget: null,
    ...(billedTo ? { billedTo } : {}),
  };
}

function mockUsage(billedTo?: 'platform' | 'partner_key') {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/ai/usage') return Promise.resolve(jsonRes(usageBody(billedTo)));
    if (url.startsWith('/ai/admin/sessions')) return Promise.resolve(jsonRes({ data: [] }));
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('AiUsagePage billedTo indicator', () => {
  it('renders the partner-key billing note when usage is billed to the partner key', async () => {
    mockUsage('partner_key');
    render(<AiUsagePage />);

    await waitFor(() => expect(screen.getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(screen.getByTestId('ai-usage-billed-to-note').textContent)
      .toContain("AI usage is billed to your organization's own Anthropic key");
  });

  it('does not render the note when usage is billed to the platform', async () => {
    mockUsage('platform');
    render(<AiUsagePage />);

    await waitFor(() => expect(screen.getByText('Budget Configuration')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-usage-billed-to-note')).toBeNull();
  });

  it('does not render the note when the response omits billedTo (older API)', async () => {
    mockUsage(undefined);
    render(<AiUsagePage />);

    await waitFor(() => expect(screen.getByText('Budget Configuration')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-usage-billed-to-note')).toBeNull();
  });
});
