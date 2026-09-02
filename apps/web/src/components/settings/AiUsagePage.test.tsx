import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const orgState: { currentOrgId: string | null } = { currentOrgId: null };
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: orgState.currentOrgId }) }));

import AiUsagePage from './AiUsagePage';

function jsonRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function usageBody(billedTo?: 'platform' | 'partner_key', catalogEndpointName?: string | null) {
  return {
    daily: { inputTokens: 10, outputTokens: 20, totalCostCents: 5, messageCount: 1 },
    monthly: { inputTokens: 100, outputTokens: 200, totalCostCents: 50, messageCount: 10 },
    budget: null,
    ...(billedTo ? { billedTo } : {}),
    ...(catalogEndpointName !== undefined ? { catalogEndpointName } : {}),
  };
}

function mockUsage(billedTo?: 'platform' | 'partner_key', catalogEndpointName?: string | null) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/ai/usage') return Promise.resolve(jsonRes(usageBody(billedTo, catalogEndpointName)));
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
      .toContain('Billed to your key — AI usage goes to your own Anthropic account, not Breeze AI credits');
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

  it('names the catalog endpoint when session provenance carries one (#3922 W4)', async () => {
    mockUsage('partner_key', 'OpenRouter');
    render(<AiUsagePage />);

    await waitFor(() => expect(screen.getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(screen.getByTestId('ai-usage-billed-to-note').textContent).toContain('OpenRouter');
  });

  it('falls back to the generic partner-key note when no catalog endpoint is named', async () => {
    mockUsage('partner_key', null);
    render(<AiUsagePage />);

    await waitFor(() => expect(screen.getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(screen.getByTestId('ai-usage-billed-to-note').textContent)
      .toContain('Billed to your key — AI usage goes to your own Anthropic account, not Breeze AI credits');
  });
});

describe('AiUsagePage effective-settings parallel fetch', () => {
  beforeEach(() => {
    orgState.currentOrgId = 'org-1';
  });

  afterEach(() => {
    orgState.currentOrgId = null;
  });

  it('dispatches the effective-settings request up front, not after usage/sessions resolve', async () => {
    let resolveUsage!: (v: Response) => void;
    const usagePromise = new Promise<Response>((resolve) => { resolveUsage = resolve; });
    let resolveSessions!: (v: Response) => void;
    const sessionsPromise = new Promise<Response>((resolve) => { resolveSessions = resolve; });
    let resolveEff!: (v: Response) => void;
    const effPromise = new Promise<Response>((resolve) => { resolveEff = resolve; });

    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ai/usage') return usagePromise;
      if (url.startsWith('/ai/admin/sessions')) return sessionsPromise;
      if (url === '/orgs/organizations/org-1/effective-settings') return effPromise;
      return Promise.resolve(jsonRes({}));
    });

    render(<AiUsagePage />);

    // Flush a microtask tick without resolving any of the three promises, so
    // this only passes if effective-settings was requested in the same
    // up-front batch as usage/sessions rather than chained after them.
    await act(async () => { await Promise.resolve(); });

    const calledUrls = fetchWithAuth.mock.calls.map((c) => c[0]);
    expect(calledUrls).toContain('/orgs/organizations/org-1/effective-settings');

    // Clean up so no promise is left dangling across tests.
    resolveUsage(jsonRes(usageBody()));
    resolveSessions(jsonRes({ data: [] }));
    resolveEff(jsonRes({ locked: [] }));
    await act(async () => { await Promise.resolve(); });
  });
});

// #4388 W03: the ladder is the one budget field the org row cannot distinguish
// from "inherit", and the one whose input can hold text that never reaches the
// form state. Both contracts are load-bearing and only observable in the PUT.
describe('AiUsagePage alert threshold ladder', () => {
  function mockUsageWithBudget(alertThresholdPercents: number[] | undefined) {
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/usage' && !init) {
        return Promise.resolve(jsonRes({
          ...usageBody(),
          budget: {
            enabled: true,
            monthlyBudgetCents: 5000,
            dailyBudgetCents: null,
            monthlyUsedCents: 0,
            dailyUsedCents: 0,
            approvalMode: 'per_step',
            alertThresholdPercents,
          },
        }));
      }
      if (url.startsWith('/ai/admin/sessions')) return Promise.resolve(jsonRes({ data: [] }));
      return Promise.resolve(jsonRes({ success: true }));
    });
  }

  const budgetPutBody = () => {
    const call = fetchWithAuth.mock.calls.find(
      ([url, init]) => url === '/ai/budget' && (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(call).toBeDefined();
    return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
  };

  it('sends alertThresholdPercents: null when the ladder is cleared', async () => {
    mockUsageWithBudget([50, 80, 95]);
    render(<AiUsagePage />);

    const input = await screen.findByTestId('ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('alertThresholdPercents', null));
  });

  it('sends the edited ladder', async () => {
    mockUsageWithBudget(undefined);
    render(<AiUsagePage />);

    const input = await screen.findByTestId('ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '60, 90' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('alertThresholdPercents', [60, 90]));
  });

  // The form seeds from the EFFECTIVE budget, so an untouched field is showing
  // whatever the org inherits. Sending it back would pin that inherited ladder
  // onto the org row as an explicit choice.
  it('omits alertThresholdPercents entirely when the field was never edited', async () => {
    mockUsageWithBudget([50, 80, 95]);
    render(<AiUsagePage />);

    await screen.findByTestId('ai-budget-thresholds-input');
    fireEvent.click(screen.getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('monthlyBudgetCents', 5000));
    expect(budgetPutBody()).not.toHaveProperty('alertThresholdPercents');
  });

  it('disables Save while the ladder text does not parse', async () => {
    mockUsageWithBudget([50, 80, 95]);
    render(<AiUsagePage />);

    const input = await screen.findByTestId('ai-budget-thresholds-input');
    const save = screen.getByTestId('ai-budget-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('ai-budget-thresholds-error')).toBeInTheDocument();
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '95' } });
    fireEvent.blur(input);
    expect(save.disabled).toBe(false);
  });
});
