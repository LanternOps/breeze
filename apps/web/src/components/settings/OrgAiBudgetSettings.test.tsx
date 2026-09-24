import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, within, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const authState: { canManagePartnerWide: boolean } = { canManagePartnerWide: true };
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ user: { canManagePartnerWide: authState.canManagePartnerWide } }),
}));

const ownerScopeState: { isPartnerScope: boolean } = { isPartnerScope: true };
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: ownerScopeState.isPartnerScope,
    defaultOwnerScope: 'organization' as const,
  }),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import { showToast } from '../shared/Toast';

import OrgAiBudgetSettings from './OrgAiBudgetSettings';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * Scope every query to this render's own container rather than the shared
 * `screen` — same ordering hazard documented in AiUsagePage.test.tsx (#4601).
 */
function renderTab() {
  const { container, ...utils } = render(<OrgAiBudgetSettings orgId="org-1" />);
  return { container, ...utils, ...within(container) };
}

function mockEffective(aiBudgets: Record<string, unknown>, locked: string[] = []) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/orgs/organizations/org-1/effective-settings' && !init) {
      return Promise.resolve(jsonRes({ effective: { aiBudgets }, locked }));
    }
    return Promise.resolve(jsonRes({ success: true }));
  });
}

/** The budget PUT this component issued, parsed. */
function budgetPut() {
  const call = fetchWithAuth.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
  );
  expect(call, 'expected a PUT /ai/budget call').toBeDefined();
  return {
    url: call![0] as string,
    body: JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>,
  };
}

const DEFAULT_BUDGET = {
  enabled: true,
  monthlyBudgetCents: null,
  dailyBudgetCents: null,
  maxTurnsPerSession: 50,
  messagesPerMinutePerUser: 20,
  messagesPerHourPerOrg: 200,
  approvalMode: 'per_step',
  alertThresholdPercents: [50, 80, 95],
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  authState.canManagePartnerWide = true;
  ownerScopeState.isPartnerScope = true;
});

describe('OrgAiBudgetSettings — partner locks', () => {
  it('disables a partner-locked field and links to the partner AI budgets tab', async () => {
    mockEffective({ ...DEFAULT_BUDGET, monthlyBudgetCents: 9900 }, ['aiBudgets.monthlyBudgetCents']);
    const { findByTestId, getByTestId } = renderTab();

    const monthly = (await findByTestId('org-ai-budget-monthly')) as HTMLInputElement;
    expect(monthly.disabled).toBe(true);
    // The partner value is shown as the effective value, not a blank box.
    expect(monthly.value).toBe('99.00');

    const note = getByTestId('org-ai-budget-locked-monthlyBudgetCents');
    expect(note.textContent).toContain('Managed by partner');
    const link = within(note).getByRole('link');
    expect(link.getAttribute('href')).toBe('/settings/partner#ai-budgets');
  });

  it('omits the partner link for a user who cannot manage partner-wide policies', async () => {
    authState.canManagePartnerWide = false;
    mockEffective({ ...DEFAULT_BUDGET, monthlyBudgetCents: 9900 }, ['aiBudgets.monthlyBudgetCents']);
    const { findByTestId } = renderTab();

    const note = await findByTestId('org-ai-budget-locked-monthlyBudgetCents');
    expect(note.textContent).toContain('Managed by partner');
    expect(within(note).queryByRole('link')).toBeNull();
  });

  it('disables Save when every field is partner-locked', async () => {
    mockEffective(
      { ...DEFAULT_BUDGET },
      [
        'aiBudgets.enabled', 'aiBudgets.monthlyBudgetCents', 'aiBudgets.dailyBudgetCents',
        'aiBudgets.maxTurnsPerSession', 'aiBudgets.messagesPerMinutePerUser',
        'aiBudgets.messagesPerHourPerOrg', 'aiBudgets.approvalMode', 'aiBudgets.alertThresholdPercents',
        'aiBudgets.toolRateLimitMultiplier',
      ],
    );
    const { findByTestId } = renderTab();

    const save = (await findByTestId('org-ai-budget-save')) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe('OrgAiBudgetSettings — inherited values are never pinned', () => {
  it('shows a "Default (…)" placeholder instead of pre-filling an inherited value', async () => {
    mockEffective({ ...DEFAULT_BUDGET });
    const { findByTestId, getByTestId } = renderTab();

    const maxTurns = (await findByTestId('org-ai-budget-max-turns')) as HTMLInputElement;
    expect(maxTurns.value).toBe('');
    expect(maxTurns.placeholder).toBe('Default (50)');

    const perMinute = getByTestId('org-ai-budget-messages-minute') as HTMLInputElement;
    expect(perMinute.value).toBe('');
    expect(perMinute.placeholder).toBe('Default (20)');
  });

  it('pre-fills a value the org row has already set', async () => {
    mockEffective({ ...DEFAULT_BUDGET, maxTurnsPerSession: 12, monthlyBudgetCents: 2500 });
    const { findByTestId, getByTestId } = renderTab();

    expect(((await findByTestId('org-ai-budget-max-turns')) as HTMLInputElement).value).toBe('12');
    expect((getByTestId('org-ai-budget-monthly') as HTMLInputElement).value).toBe('25.00');
  });

  it('sends ONLY the fields the user touched', async () => {
    mockEffective({ ...DEFAULT_BUDGET, maxTurnsPerSession: 12 });
    const { findByTestId, getByTestId } = renderTab();

    const monthly = (await findByTestId('org-ai-budget-monthly')) as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: '25' } });
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({ monthlyBudgetCents: 2500 }));
    // maxTurnsPerSession was rendered with the org's own 12 and left alone —
    // re-sending it would be harmless, but every OTHER field was showing an
    // inherited default and sending those is exactly the #5592 pinning bug.
    expect(budgetPut().body).not.toHaveProperty('maxTurnsPerSession');
    expect(budgetPut().body).not.toHaveProperty('approvalMode');
    expect(budgetPut().body).not.toHaveProperty('alertThresholdPercents');
  });

  it('sends nothing but still reports success when the user saves without editing', async () => {
    mockEffective({ ...DEFAULT_BUDGET });
    const { findByTestId } = renderTab();

    fireEvent.click(await findByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({}));
  });

  it('clears a value back to inherited by sending null', async () => {
    mockEffective({ ...DEFAULT_BUDGET, monthlyBudgetCents: 2500 });
    const { findByTestId, getByTestId } = renderTab();

    const monthly = (await findByTestId('org-ai-budget-monthly')) as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: '' } });
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({ monthlyBudgetCents: null }));
  });

  it('sends a newly typed alert threshold ladder', async () => {
    mockEffective({ ...DEFAULT_BUDGET });
    const { findByTestId, getByTestId } = renderTab();

    const input = await findByTestId('org-ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '60, 90' } });
    fireEvent.blur(input);
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({ alertThresholdPercents: [60, 90] }));
  });

  it('sends the edited alert threshold ladder, and null when it is cleared', async () => {
    mockEffective({ ...DEFAULT_BUDGET, alertThresholdPercents: [60, 90] });
    const { findByTestId, getByTestId } = renderTab();

    const input = await findByTestId('org-ai-budget-thresholds-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({ alertThresholdPercents: null }));
  });

  it('disables Save while the threshold ladder text does not parse', async () => {
    mockEffective({ ...DEFAULT_BUDGET });
    const { findByTestId, getByTestId } = renderTab();

    const input = await findByTestId('org-ai-budget-thresholds-input');
    const save = getByTestId('org-ai-budget-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(save.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '95' } });
    fireEvent.blur(input);
    expect(save.disabled).toBe(false);
  });
});

describe('OrgAiBudgetSettings — request shape', () => {
  it('pins the PUT to the org being edited, never the ambient switcher scope', async () => {
    mockEffective({ ...DEFAULT_BUDGET });
    const { findByTestId, getByTestId } = renderTab();

    const enabled = (await findByTestId('org-ai-budget-enabled')) as HTMLSelectElement;
    fireEvent.change(enabled, { target: { value: 'false' } });
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().url).toBe('/ai/budget?orgId=org-1'));
    expect(budgetPut().body).toEqual({ enabled: false });
  });

  it('renders nothing actionable and issues no request without an org', async () => {
    fetchWithAuth.mockImplementation(() => Promise.resolve(jsonRes({})));
    const { queryByTestId } = render(<OrgAiBudgetSettings orgId={null} />);

    await waitFor(() => expect(queryByTestId('org-ai-budget-save')).toBeNull());
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe('OrgAiBudgetSettings — a failed read is never a usable form', () => {
  it('blocks the form when effective settings cannot be read', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/orgs/organizations/org-1/effective-settings') {
        return Promise.resolve(jsonRes({ error: 'nope' }, 500));
      }
      return Promise.resolve(jsonRes({ success: true }));
    });
    const { findByTestId, queryByTestId } = renderTab();

    await findByTestId('org-ai-budget-unavailable');
    // Rendering the form here would show every partner-LOCKED field as
    // editable (locked would still be []) and every value as inherited.
    expect(queryByTestId('org-ai-budget-save')).toBeNull();
    expect(queryByTestId('org-ai-budget-monthly')).toBeNull();
  });
});

describe('OrgAiBudgetSettings — save failures are surfaced', () => {
  it('reports a rejected save and leaves the edit in place', async () => {
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/orgs/organizations/org-1/effective-settings' && !init) {
        return Promise.resolve(jsonRes({ effective: { aiBudgets: DEFAULT_BUDGET }, locked: [] }));
      }
      return Promise.resolve(jsonRes({ error: 'Field is managed by your partner' }, 403));
    });
    const { findByTestId, getByTestId } = renderTab();

    const monthly = (await findByTestId('org-ai-budget-monthly')) as HTMLInputElement;
    fireEvent.change(monthly, { target: { value: '25' } });
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Field is managed by your partner' }),
      ),
    );
    // The form is still editable and still holds what the user typed — a
    // failed save must not look like a successful one.
    expect((getByTestId('org-ai-budget-monthly') as HTMLInputElement).value).toBe('25');
  });
});

describe('OrgAiBudgetSettings — per-tool rate-limit multiplier (#6476)', () => {
  it('renders empty with a "Default (1)" placeholder when inherited', async () => {
    mockEffective({ ...DEFAULT_BUDGET, toolRateLimitMultiplier: 1 });
    const { findByTestId } = renderTab();

    const input = (await findByTestId('org-ai-budget-tool-rate-limit-multiplier')) as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Default (1)');
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
  });

  it('sends the multiplier when the user sets it', async () => {
    mockEffective({ ...DEFAULT_BUDGET, toolRateLimitMultiplier: 1 });
    const { findByTestId, getByTestId } = renderTab();

    const input = (await findByTestId('org-ai-budget-tool-rate-limit-multiplier')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(getByTestId('org-ai-budget-save'));

    await waitFor(() => expect(budgetPut().body).toEqual({ toolRateLimitMultiplier: 3 }));
  });

  it('is disabled and never sent when the partner locks it', async () => {
    mockEffective({ ...DEFAULT_BUDGET, toolRateLimitMultiplier: 2 }, ['aiBudgets.toolRateLimitMultiplier']);
    const { findByTestId, getByTestId } = renderTab();

    const input = (await findByTestId('org-ai-budget-tool-rate-limit-multiplier')) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('2');
    expect(getByTestId('org-ai-budget-locked-toolRateLimitMultiplier').textContent).toContain('Managed by partner');
  });
});
