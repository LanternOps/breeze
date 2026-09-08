import { render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for the DelegateToOperatorButton wiring in
 * AlertDetailPage.tsx (W08 of #5205, #5246).
 *
 * Spec §5.1: "changing global organization context while drafting cannot
 * retarget the task" — the button must always target the ALERT's own org
 * (`alert.orgId`), never the globally selected org from `useOrgStore`. The
 * failure this guards against: someone swaps `alert.orgId` for the org-store
 * value at the call site — it would compile and pass every other existing
 * test today, since nothing else in the suite exercises this prop.
 *
 * The real DelegateToOperatorButton is stubbed out so this test reads the
 * props the call site actually passed (via data attributes) instead of
 * asserting on rendered dialog text, and so it sidesteps the
 * useAiOperatorTasksGate feature-flag gate inside the real component.
 */
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({ default: () => null }));

vi.mock('../aiOperator/DelegateToOperatorButton', () => ({
  DelegateToOperatorButton: (props: {
    orgId: string;
    deviceId: string;
    deviceLabel: string;
    source: { kind: string; id: string };
  }) => (
    <button
      type="button"
      data-testid="delegate-stub"
      data-org-id={props.orgId}
      data-device-id={props.deviceId}
      data-device-label={props.deviceLabel}
      data-source-kind={props.source.kind}
      data-source-id={props.source.id}
    >
      delegate
    </button>
  ),
}));

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));

import AlertDetailPage from './AlertDetailPage';
import { useOrgStore } from '@/stores/orgStore';

// Deliberately DIFFERENT from every alert's orgId below, so the assertion
// fails if the call site is ever swapped to read the org-store value instead
// of alert.orgId.
const GLOBAL_STORE_ORG_ID = 'org-globally-selected-9999';
const ALERT_ORG_ID = 'org-alert-owner-1111';

type RawAlert = {
  id: string;
  title: string;
  message: string;
  severity: string;
  status: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  triggeredAt: string;
};

const baseAlert: RawAlert = {
  id: 'a-delegate-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  orgId: ALERT_ORG_ID,
  triggeredAt: '2026-08-24T16:00:00Z',
};

function mockFetch(alert: RawAlert) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith('/tickets')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(alert),
    });
  });
}

function renderPage(alert: RawAlert) {
  mockFetch(alert);
  return render(<AlertDetailPage alertId={alert.id} />);
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  useOrgStore.setState({
    currentOrgId: GLOBAL_STORE_ORG_ID,
    serviceManagementMode: 'native',
  } as never);
});

describe('AlertDetailPage — Delegate to Operator wiring (#5246, spec §5.1)', () => {
  it('targets the ALERT\'s own org, not the globally selected org', async () => {
    renderPage(baseAlert);

    const stub = await screen.findByTestId('delegate-stub');

    expect(stub.getAttribute('data-org-id')).toBe(ALERT_ORG_ID);
    expect(stub.getAttribute('data-org-id')).not.toBe(GLOBAL_STORE_ORG_ID);
    expect(stub.getAttribute('data-device-id')).toBe(baseAlert.deviceId);
  });

  it('renders for an active alert', async () => {
    renderPage({ ...baseAlert, status: 'active' });
    await screen.findByTestId('delegate-stub');
  });

  it('renders for an acknowledged alert', async () => {
    renderPage({ ...baseAlert, status: 'acknowledged' });
    await screen.findByTestId('delegate-stub');
  });

  it('does NOT render for a resolved alert', async () => {
    renderPage({ ...baseAlert, status: 'resolved' });

    // Something else from the page must render first, or a query that
    // always finds nothing (because the page never mounted) would pass
    // vacuously.
    await screen.findByRole('heading', { name: baseAlert.title });
    await waitFor(() => {
      expect(screen.queryByTestId('delegate-stub')).toBeNull();
    });
  });

  it('does NOT render for a dismissed (non-actionable) alert', async () => {
    renderPage({ ...baseAlert, status: 'dismissed' });

    await screen.findByRole('heading', { name: baseAlert.title });
    await waitFor(() => {
      expect(screen.queryByTestId('delegate-stub')).toBeNull();
    });
  });
});
