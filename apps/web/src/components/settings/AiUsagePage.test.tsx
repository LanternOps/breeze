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

    await waitFor(() => expect(getByText('Recent Sessions')).toBeInTheDocument());
    expect(queryByTestId('ai-usage-billed-to-note')).toBeNull();
  });

  it('does not render the note when the response omits billedTo (older API)', async () => {
    mockUsage(undefined);
    const { getByText, queryByTestId } = renderPage();

    await waitFor(() => expect(getByText('Recent Sessions')).toBeInTheDocument());
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

    await waitFor(() => expect(getByText('Recent Sessions')).toBeInTheDocument());
    expect(queryByText('Breeze AI credits remaining')).toBeNull();
  });

  it('does not render the credits stat card when the response omits credits (older API)', async () => {
    mockUsage('platform');
    const { getByText, queryByText } = renderPage();

    await waitFor(() => expect(getByText('Recent Sessions')).toBeInTheDocument());
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

// #6004: the org budget FORM moved to the org settings AI tab. What is left
// here is a read-only panel whose job is to say where each effective value
// comes from — and, crucially, a page that can never issue a budget PUT.
describe('AiUsagePage effective budget panel (#6004)', () => {
  const EFFECTIVE_DEFAULTS = {
    enabled: true,
    monthlyBudgetCents: null,
    dailyBudgetCents: null,
    maxTurnsPerSession: 50,
    messagesPerMinutePerUser: 20,
    messagesPerHourPerOrg: 200,
    approvalMode: 'per_step',
    alertThresholdPercents: [50, 80, 95],
  };

  function mockOrg(aiBudgets: Record<string, unknown>, locked: string[] = []) {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ai/usage') return Promise.resolve(jsonRes(usageBody('platform')));
      if (url.startsWith('/ai/admin/sessions')) return Promise.resolve(jsonRes({ data: [] }));
      if (url === '/orgs/organizations/org-1/effective-settings') {
        return Promise.resolve(jsonRes({ effective: { aiBudgets }, locked }));
      }
      return Promise.resolve(jsonRes({}));
    });
  }

  beforeEach(() => { orgState.currentOrgId = 'org-1'; });
  afterEach(() => { orgState.currentOrgId = null; });

  it('no longer renders the Budget Configuration form', async () => {
    mockOrg(EFFECTIVE_DEFAULTS);
    const { findByTestId, queryByText, queryByTestId } = renderPage();

    await findByTestId('ai-effective-budget');
    expect(queryByText('Budget Configuration')).toBeNull();
    expect(queryByTestId('ai-budget-save')).toBeNull();
    expect(queryByTestId('ai-budget-thresholds-input')).toBeNull();
  });

  it('renders each field\'s effective value, not just its provenance', async () => {
    mockOrg({
      ...EFFECTIVE_DEFAULTS,
      enabled: false,
      approvalMode: 'auto_approve',
      dailyBudgetCents: 1250,
      alertThresholdPercents: [60, 90],
    });
    const { findByTestId, getByTestId } = renderPage();

    expect((await findByTestId('ai-effective-budget-value-enabled')).textContent).toBe('Disabled');
    expect(getByTestId('ai-effective-budget-value-approvalMode').textContent).toBe('Auto Approve');
    expect(getByTestId('ai-effective-budget-value-dailyBudgetCents').textContent).toContain('12.50');
    expect(getByTestId('ai-effective-budget-value-monthlyBudgetCents').textContent).toBe('No limit');
    expect(getByTestId('ai-effective-budget-value-alertThresholdPercents').textContent).toBe('60%, 90%');
    expect(getByTestId('ai-effective-budget-value-maxTurnsPerSession').textContent).toBe('50');
  });

  it('renders an empty threshold ladder as off rather than as a blank cell', async () => {
    mockOrg({ ...EFFECTIVE_DEFAULTS, alertThresholdPercents: [] });
    const { findByTestId } = renderPage();

    expect((await findByTestId('ai-effective-budget-value-alertThresholdPercents')).textContent).toBe('Off');
  });

  it('marks a partner-locked field as partner-sourced and links to the partner tab', async () => {
    mockOrg({ ...EFFECTIVE_DEFAULTS, monthlyBudgetCents: 9900 }, ['aiBudgets.monthlyBudgetCents']);
    const { findByTestId } = renderPage();

    const chip = await findByTestId('ai-effective-budget-source-monthlyBudgetCents');
    expect(chip.textContent).toContain('Set by partner');
    expect(chip.getAttribute('href')).toBe('/settings/partner#ai-budgets');
    expect((await findByTestId('ai-effective-budget-value-monthlyBudgetCents')).textContent).toContain('99');
  });

  it('marks an org-set field as organization-sourced and links to the org AI tab', async () => {
    mockOrg({ ...EFFECTIVE_DEFAULTS, maxTurnsPerSession: 12 });
    const { findByTestId } = renderPage();

    const chip = await findByTestId('ai-effective-budget-source-maxTurnsPerSession');
    expect(chip.textContent).toContain('Set by organization');
    expect(chip.getAttribute('href')).toBe('/settings/organizations/org-1#ai');
  });

  it('marks an untouched field as coming from the defaults, with no link', async () => {
    mockOrg(EFFECTIVE_DEFAULTS);
    const { findByTestId } = renderPage();

    const chip = await findByTestId('ai-effective-budget-source-messagesPerHourPerOrg');
    expect(chip.textContent).toContain('Default');
    expect(chip.tagName).not.toBe('A');
  });
});

describe('AiUsagePage with the switcher on All organizations (#6004)', () => {
  beforeEach(() => { orgState.currentOrgId = null; });

  it('prompts for an org instead of rendering a form, and never PUTs a budget', async () => {
    mockUsage('platform');
    const { findByTestId, queryByTestId, queryByText } = renderPage();

    const prompt = await findByTestId('ai-usage-select-org-prompt');
    expect(prompt.textContent).toContain('Select an organization');
    expect(within(prompt).getByRole('link').getAttribute('href')).toBe('/settings/partner#ai-budgets');

    expect(queryByTestId('ai-effective-budget')).toBeNull();
    expect(queryByTestId('ai-budget-save')).toBeNull();
    expect(queryByText('Budget Configuration')).toBeNull();

    // The 400 in the report came from a Save this page can no longer issue.
    const puts = fetchWithAuth.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    );
    expect(puts).toEqual([]);
  });
});

describe('AiUsagePage when effective settings cannot be read (#6004)', () => {
  beforeEach(() => { orgState.currentOrgId = 'org-1'; });
  afterEach(() => { orgState.currentOrgId = null; });

  it('names the failure instead of showing the All-organizations prompt', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ai/usage') return Promise.resolve(jsonRes(usageBody('platform')));
      if (url.startsWith('/ai/admin/sessions')) return Promise.resolve(jsonRes({ data: [] }));
      if (url === '/orgs/organizations/org-1/effective-settings') return Promise.reject(new Error('boom'));
      return Promise.resolve(jsonRes({}));
    });
    const { findByTestId, queryByTestId } = renderPage();

    await findByTestId('ai-effective-budget-unavailable');
    expect(queryByTestId('ai-usage-select-org-prompt')).toBeNull();
    expect(queryByTestId('ai-effective-budget')).toBeNull();
  });
});
