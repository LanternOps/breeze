import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEntitlements, type UseEntitlementsResult } from '../../hooks/useEntitlement';
import type { ClientEntitlement } from '../../lib/entitlementsCache';
import PlanAndFeaturesPage from './PlanAndFeaturesPage';

vi.mock('../../hooks/useEntitlement', () => ({ useEntitlements: vi.fn() }));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchMock(...args) }));

function capacityResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const useEntitlementsMock = vi.mocked(useEntitlements);

const DAY = 24 * 60 * 60 * 1000;

const ent = (overrides: Partial<ClientEntitlement> & { key: string }): ClientEntitlement => ({
  label: overrides.key,
  why: `why-${overrides.key}`,
  state: 'enabled',
  source: 'plan',
  limits: null,
  expiresAt: null,
  graceUntil: null,
  reason: null,
  ...overrides,
});

function mockResult(partial: Partial<UseEntitlementsResult>): UseEntitlementsResult {
  const result: UseEntitlementsResult = { snapshot: null, loading: false, failed: false, reload: vi.fn(), ...partial };
  useEntitlementsMock.mockReturnValue(result);
  return result;
}

const proSnapshot = (wisp: Partial<ClientEntitlement> = {}) => ({
  plan: 'pro',
  entitlements: [
    ent({ key: 'onboarding_supervisor', state: 'disabled' }),
    ent({ key: 'verified_library', state: 'disabled' }),
    ent({
      key: 'wisp',
      limits: { maxGrants: 25, budgetCentsPerDayCeiling: 1000, minFloorTickMinutes: 15 },
      ...wisp,
    }),
  ],
});

describe('PlanAndFeaturesPage', () => {
  beforeEach(() => {
    useEntitlementsMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(capacityResponse({ limit: 110, activeCount: 12, enrollmentPaused: false }));
  });

  it('renders the plan badge and one row per registry key', () => {
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByTestId('plan-badge')).toHaveTextContent('Pro');
    for (const key of ['onboarding_supervisor', 'verified_library', 'wisp']) {
      expect(screen.getByTestId(`entitlement-row-${key}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId(/^entitlement-row-/)).toHaveLength(3);
  });

  it('enabled row shows Included + source badge Plan default', () => {
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByTestId('entitlement-state-wisp')).toHaveTextContent('Included');
    expect(screen.getByTestId('entitlement-source-wisp')).toHaveTextContent('Plan default');
    const row = screen.getByTestId('entitlement-row-wisp');
    // Limits are rendered as key: value pairs, never a raw JSON dump.
    expect(within(row).getByText('maxGrants: 25')).toBeInTheDocument();
    expect(row.textContent).not.toContain('{');
  });

  it('a null limit value (no cap) renders the placeholder, not an empty value', () => {
    mockResult({
      snapshot: {
        plan: 'pro',
        entitlements: [ent({ key: 'verified_library', limits: { maxVerifiedPackages: null } })],
      },
    });
    render(<PlanAndFeaturesPage />);

    expect(within(screen.getByTestId('entitlement-row-verified_library')).getByText('maxVerifiedPackages: —')).toBeInTheDocument();
  });

  it('locked row shows Locked and the why line', () => {
    mockResult({ snapshot: proSnapshot({ state: 'disabled' }) });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByTestId('entitlement-state-wisp')).toHaveTextContent('Locked');
    expect(
      within(screen.getByTestId('entitlement-row-wisp')).getByText(
        'Wisp triages your fleet continuously and nudges the right person; available on Pro and above.',
      ),
    ).toBeInTheDocument();
  });

  it('manual row shows Manual source and the reason', () => {
    mockResult({ snapshot: proSnapshot({ state: 'disabled', source: 'manual', reason: 'Paused at customer request' }) });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByTestId('entitlement-source-wisp')).toHaveTextContent('Manual');
    expect(screen.getByTestId('entitlement-reason-wisp')).toHaveTextContent('Reason: Paused at customer request');
  });

  it('expired-within-grace row shows the grace warning', () => {
    const now = Date.now();
    mockResult({
      snapshot: proSnapshot({
        source: 'billing',
        expiresAt: new Date(now - DAY).toISOString(),
        graceUntil: new Date(now + 13 * DAY).toISOString(),
      }),
    });
    render(<PlanAndFeaturesPage />);

    const grace = screen.getByTestId('entitlement-grace-wisp');
    expect(grace).toHaveTextContent(/grace until/);
  });

  it('no grace warning when not expired', () => {
    const now = Date.now();
    mockResult({
      snapshot: proSnapshot({
        source: 'billing',
        expiresAt: new Date(now + 30 * DAY).toISOString(),
        graceUntil: new Date(now + 44 * DAY).toISOString(),
      }),
    });
    render(<PlanAndFeaturesPage />);

    expect(screen.queryByTestId('entitlement-grace-wisp')).toBeNull();
  });

  it('failed load shows the error and Retry calls reload', () => {
    const result = mockResult({ failed: true });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByText('Could not load your plan.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('plan-features-retry'));
    expect(result.reload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(/^entitlement-state-/)).toBeNull();
  });

  it('loading shows no state badges', () => {
    mockResult({ loading: true });
    render(<PlanAndFeaturesPage />);

    expect(screen.queryByTestId(/^entitlement-state-/)).toBeNull();
    expect(screen.queryByTestId('plan-badge')).toBeNull();
    expect(screen.getByTestId('plan-features-loading')).toBeInTheDocument();
  });
  it('links to /billing/plans', () => {
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    const link = screen.getByTestId('plan-change-link');
    expect(link).toHaveTextContent('Change plan');
    expect(link).toHaveAttribute('href', '/billing/plans');
  });

  it('keeps the Change plan link when the plan fails to load', () => {
    mockResult({ failed: true });
    render(<PlanAndFeaturesPage />);

    expect(screen.getByTestId('plan-change-link')).toHaveAttribute('href', '/billing/plans');
  });

  it('shows the paused message with counts', async () => {
    fetchMock.mockResolvedValue(capacityResponse({ limit: 110, activeCount: 110, enrollmentPaused: true }));
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    const paused = await screen.findByTestId('plan-enrollment-paused');
    expect(paused).toHaveTextContent(
      'New device enrollment is paused: 110 of 110 devices. Change your plan to add more.',
    );
    expect(fetchMock).toHaveBeenCalledWith('/partner/device-capacity', { skipOrgIdInjection: true });
  });

  it('shows no paused message while enrollment is open', async () => {
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('plan-enrollment-paused')).toBeNull();
  });

  it('shows no paused message when the capacity read fails', async () => {
    fetchMock.mockResolvedValue(capacityResponse({ error: 'boom' }, false));
    mockResult({ snapshot: proSnapshot() });
    render(<PlanAndFeaturesPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('plan-enrollment-paused')).toBeNull();
    expect(screen.getByTestId('plan-change-link')).toBeInTheDocument();
  });
});
