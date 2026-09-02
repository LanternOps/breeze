import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// The dashboard and `useApproximateTotal` both reach the network through the
// same auth store module, so one mock serves the portfolio payload AND the
// reporting-totals stub.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import PartnerDashboard from './PartnerDashboard';
import { resetApproximateTotalCache } from '@/lib/useApproximateTotal';
import type { ReportingTotalResponse } from '@/lib/reporting/approximateTotal';

const json = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as Response;

type Group = { currencyCode: string; amount: string };

const org = (id: string, name: string, mrrByCurrency: Group[]) => ({
  id,
  name,
  healthScore: 90,
  deviceCount: 3,
  alertCount: 0,
  compliancePercent: 100,
  mrr: 0, // deprecated wave-7 field: always 0, must never reach the UI
  mrrByCurrency,
  devices: [],
});

const AVAILABLE: ReportingTotalResponse = {
  status: 'available',
  targetCurrencyCode: 'CAD',
  requestedDate: '2026-08-21',
  maxStalenessDays: 7,
  rateDate: '2026-08-19',
  total: '22940.00',
  groups: [],
  unavailableCurrencyCodes: [],
};

/** Wire the portfolio payload plus whatever the reporting endpoint should answer. */
function wire(customers: unknown[], rates: (() => Response) | null = null) {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/billing/reporting-totals')) {
      if (!rates) return json({ error: { code: 'BOOM' } }, 500);
      return rates();
    }
    if (url.startsWith('/partner/dashboard')) return json({ data: { customers } });
    return json({ data: [] });
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  resetApproximateTotalCache();
});

describe('PartnerDashboard MRR (multi-currency, wave 7)', () => {
  it('labels a single-currency portfolio with its own currency, never USD', async () => {
    wire([org('o1', 'Acme', [{ currencyCode: 'EUR', amount: '410.00' }])]);
    render(<PartnerDashboard />);

    const cell = await screen.findByTestId('partner-dashboard-mrr-o1');
    expect(cell.textContent).toBe('€410.00');
    expect(cell.textContent).not.toContain('$');
    const total = screen.getByTestId('partner-dashboard-total-mrr');
    expect(total.textContent).toBe('€410.00');
    expect(total.textContent).not.toContain('$');
  });

  it('segments a mixed portfolio instead of summing it under one label', async () => {
    wire([
      org('o1', 'Acme', [{ currencyCode: 'USD', amount: '12300.00' }]),
      org('o2', 'Globex', [{ currencyCode: 'EUR', amount: '4100.00' }]),
    ]);
    render(<PartnerDashboard />);

    const total = await screen.findByTestId('partner-dashboard-total-mrr');
    expect(total.textContent).toBe('$12,300.00 + €4,100.00');
    // 12300 + 4100 = 16400 — the blind sum this wave removes.
    expect(total.textContent).not.toContain('16,400');
    expect(total.textContent).not.toContain('16400');
    expect(screen.getByTestId('partner-dashboard-mrr-o1').textContent).toBe('$12,300.00');
    expect(screen.getByTestId('partner-dashboard-mrr-o2').textContent).toBe('€4,100.00');
  });

  it('renders a dash for an org with no MRR, never $0', async () => {
    wire([org('o1', 'Acme', [])]);
    render(<PartnerDashboard />);

    const cell = await screen.findByTestId('partner-dashboard-mrr-o1');
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toContain('$');
    expect(cell.textContent).not.toContain('0');
    expect(screen.getByTestId('partner-dashboard-total-mrr').textContent).toBe('—');
  });

  it('IGNORES the deprecated scalar `mrr` when no per-currency groups are sent', async () => {
    // A bundle talking to an older API (or a payload that simply omits the new
    // field) must render "no MRR" — never the deprecated scalar under an
    // assumed USD label. This is the whole reason the scalar is not a fallback.
    wire([{ id: 'o1', name: 'Acme', healthScore: 90, deviceCount: 1, alertCount: 0, compliancePercent: 100, mrr: 999, devices: [] }]);
    render(<PartnerDashboard />);

    const cell = await screen.findByTestId('partner-dashboard-mrr-o1');
    expect(cell.textContent).toBe('—');
    expect(cell.textContent).not.toContain('999');
    expect(screen.getByTestId('partner-dashboard-total-mrr').textContent).toBe('—');
  });

  it('reads the groups from a nested `billing.mrrByCurrency` payload shape', async () => {
    wire([{ id: 'o1', name: 'Acme', healthScore: 90, deviceCount: 1, alertCount: 0, compliancePercent: 100, mrr: 0, billing: { mrr: 0, mrrByCurrency: [{ currencyCode: 'GBP', amount: '77.50' }] }, devices: [] }]);
    render(<PartnerDashboard />);

    expect((await screen.findByTestId('partner-dashboard-mrr-o1')).textContent).toBe('£77.50');
  });

  it('hangs the approximate line BENEATH the segmented total when rates resolve', async () => {
    wire([
      org('o1', 'Acme', [{ currencyCode: 'USD', amount: '12300.00' }]),
      org('o2', 'Globex', [{ currencyCode: 'EUR', amount: '4100.00' }]),
    ], () => json({ data: AVAILABLE }));
    render(<PartnerDashboard />);

    const approx = await screen.findByTestId('partner-dashboard-mrr-approx');
    expect(approx.textContent).toContain('CA$22,940.00');
    expect(approx.textContent).toContain('2026-08-19');
    // The authoritative segmentation stays visible above it, unchanged.
    const total = screen.getByTestId('partner-dashboard-total-mrr');
    expect(total.textContent).toBe('$12,300.00 + €4,100.00');
    expect(total.compareDocumentPosition(approx) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the segmented total and SAYS the approximate line is unavailable when the rates endpoint fails', async () => {
    wire([
      org('o1', 'Acme', [{ currencyCode: 'USD', amount: '12300.00' }]),
      org('o2', 'Globex', [{ currencyCode: 'EUR', amount: '4100.00' }]),
    ], null);
    render(<PartnerDashboard />);

    const total = await screen.findByTestId('partner-dashboard-total-mrr');
    await waitFor(() => expect(fetchWithAuth)
      .toHaveBeenCalledWith(expect.stringContaining('/billing/reporting-totals'), { skipOrgIdInjection: true }));
    // The authoritative segmentation is untouched by the FX failure...
    expect(total.textContent).toBe('$12,300.00 + €4,100.00');
    // ...and the companion line reports the failure instead of vanishing (#4415).
    const approx = await screen.findByTestId('partner-dashboard-mrr-approx');
    expect(approx.textContent).toBe('≈ total unavailable — could not load exchange rates');
    expect(approx.dataset.approxState).toBe('failed');
    expect(approx.textContent).not.toContain('CA$');
  });
});
