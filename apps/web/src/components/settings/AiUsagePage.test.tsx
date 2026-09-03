import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, within, waitFor, act } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const orgState: { currentOrgId: string | null } = { currentOrgId: null };
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: orgState.currentOrgId }) }));

import AiUsagePage from './AiUsagePage';

// Every test below scopes its queries to its OWN render's container via
// `within(container)` instead of the shared `screen` (which binds to
// `document.body`). Under real suite-order/CPU-load conditions a previous
// test's `cleanup()` can still be settling when this test's body starts (both
// are async and RTL's afterEach isn't guaranteed to have unmounted yet), so a
// global `screen` query can silently match the PRIOR test's still-mounted
// instance instead of this one. Scoping to `container` makes every query
// order-independent regardless of how fast a neighbouring test's teardown
// runs (#4601).
function renderPage() {
  const { container, ...utils } = render(<AiUsagePage />);
  return { container, ...utils, ...within(container) };
}

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
    const { getByTestId } = renderPage();

    await waitFor(() => expect(getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(getByTestId('ai-usage-billed-to-note').textContent)
      .toContain('Billed to your key — AI usage goes to your own Anthropic account, not Breeze AI credits');
  });

  it('does not render the note when usage is billed to the platform', async () => {
    mockUsage('platform');
    const { getByText, queryByTestId } = renderPage();

    await waitFor(() => expect(getByText('Budget Configuration')).toBeInTheDocument());
    expect(queryByTestId('ai-usage-billed-to-note')).toBeNull();
  });

  it('does not render the note when the response omits billedTo (older API)', async () => {
    mockUsage(undefined);
    const { getByText, queryByTestId } = renderPage();

    await waitFor(() => expect(getByText('Budget Configuration')).toBeInTheDocument());
    expect(queryByTestId('ai-usage-billed-to-note')).toBeNull();
  });

  it('names the catalog endpoint when session provenance carries one (#3922 W4)', async () => {
    mockUsage('partner_key', 'OpenRouter');
    const { getByTestId } = renderPage();

    await waitFor(() => expect(getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(getByTestId('ai-usage-billed-to-note').textContent).toContain('OpenRouter');
  });

  it('falls back to the generic partner-key note when no catalog endpoint is named', async () => {
    mockUsage('partner_key', null);
    const { getByTestId } = renderPage();

    await waitFor(() => expect(getByTestId('ai-usage-billed-to-note')).toBeInTheDocument());
    expect(getByTestId('ai-usage-billed-to-note').textContent)
      .toContain('Billed to your key — AI usage goes to your own Anthropic account, not Breeze AI credits');
  });
});

// #4388 W04: the credits StatCard only appears when the API actually sent a
// cached partner balance: the existing `usageBody()` fixture never sets it,
// so every other describe block in this file keeps proving the card stays
// hidden by default.
describe('AiUsagePage credits stat card (#4388 W04)', () => {
  function mockUsageWithCredits(credits: { remaining: number; includedBalance: number; purchasedBalance: number; fetchedAt: string } | null) {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ai/usage') return Promise.resolve(jsonRes({ ...usageBody(), credits }));
      if (url.startsWith('/ai/admin/sessions')) return Promise.resolve(jsonRes({ data: [] }));
      return Promise.resolve(jsonRes({ data: [] }));
    });
  }

  it('renders the credits remaining stat card when usage.credits is present', async () => {
    mockUsageWithCredits({ remaining: 1240, includedBalance: 0, purchasedBalance: 1240, fetchedAt: '2026-09-01T00:00:00.000Z' });
    const { getByText } = renderPage();

    await waitFor(() => expect(getByText('Breeze AI credits remaining')).toBeInTheDocument());
    expect(getByText('1,240')).toBeInTheDocument();
  });

  // A zero balance is exactly when the card matters most: the object is
  // present, so the card must render "0" rather than vanish the way a
  // truthiness check on `remaining` would make it.
  it('still renders the card, showing 0, when the balance is exhausted', async () => {
    mockUsageWithCredits({ remaining: 0, includedBalance: 0, purchasedBalance: 0, fetchedAt: '2026-09-01T00:00:00.000Z' });
    const { getByText } = renderPage();

    await waitFor(() => expect(getByText('Breeze AI credits remaining')).toBeInTheDocument());
    expect(getByText('0')).toBeInTheDocument();
  });

  it('does not render the credits stat card when usage.credits is null', async () => {
    mockUsageWithCredits(null);
    const { getByText, queryByText } = renderPage();

    await waitFor(() => expect(getByText('Budget Configuration')).toBeInTheDocument());
    expect(queryByText('Breeze AI credits remaining')).toBeNull();
  });

  it('does not render the credits stat card when the response omits credits (older API)', async () => {
    mockUsage('platform');
    const { getByText, queryByText } = renderPage();

    await waitFor(() => expect(getByText('Budget Configuration')).toBeInTheDocument());
    expect(queryByText('Breeze AI credits remaining')).toBeNull();
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

    renderPage();

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
    const { findByTestId, getByTestId } = renderPage();

    const input = await findByTestId('ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    fireEvent.click(getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('alertThresholdPercents', null));
  });

  it('sends the edited ladder', async () => {
    mockUsageWithBudget(undefined);
    const { findByTestId, getByTestId } = renderPage();

    const input = await findByTestId('ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '60, 90' } });
    fireEvent.blur(input);
    fireEvent.click(getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('alertThresholdPercents', [60, 90]));
  });

  // The form seeds from the EFFECTIVE budget, so an untouched field is showing
  // whatever the org inherits. Sending it back would pin that inherited ladder
  // onto the org row as an explicit choice.
  it('omits alertThresholdPercents entirely when the field was never edited', async () => {
    mockUsageWithBudget([50, 80, 95]);
    const { findByTestId, getByTestId } = renderPage();

    await findByTestId('ai-budget-thresholds-input');
    fireEvent.click(getByTestId('ai-budget-save'));

    await waitFor(() => expect(budgetPutBody()).toHaveProperty('monthlyBudgetCents', 5000));
    expect(budgetPutBody()).not.toHaveProperty('alertThresholdPercents');
  });

  it('disables Save while the ladder text does not parse', async () => {
    mockUsageWithBudget([50, 80, 95]);
    const { findByTestId, getByTestId } = renderPage();

    const input = await findByTestId('ai-budget-thresholds-input');
    const save = getByTestId('ai-budget-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(getByTestId('ai-budget-thresholds-error')).toBeInTheDocument();
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '95' } });
    fireEvent.blur(input);
    expect(save.disabled).toBe(false);
  });
});
