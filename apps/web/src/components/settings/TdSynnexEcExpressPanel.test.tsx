import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login?next=/settings/catalog' }));

import TdSynnexEcExpressPanel from './TdSynnexEcExpressPanel';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const statusPayload = {
  data: {
    configured: true,
    enabled: true,
    region: 'US',
    credentials: { email: 'buyer@msp.test', password: '********', customerNo: 'CUST-1' },
    settings: { defaultWarehouse: '', hideZeroInv: false, defaultMarkupPercent: 0 },
    lastTestStatus: null,
  },
};

const product = {
  source: 'td_synnex_ec_express',
  synnexSku: 'SNX-1',
  mfgPartNo: 'MPN-1',
  status: 'Active',
  name: 'ThinkPad Dock',
  description: 'USB-C dock',
  currency: 'USD',
  cost: 100,
  msrp: 150,
  discount: null,
  totalQty: 7,
  warehouses: [{ code: 'CA', available: 5, onOrder: 2, bo: 0, eta: '2026-07-01' }],
  weight: null,
  parcelShippable: null,
  raw: {},
};

// Route fetch by URL (not call order) so the panel's extra GET /orgs/partners/me
// on mount can't shift a positional mock queue (the no-positional-mock lesson).
let statusResponse: Response;
let meResponse: Response;
let lookupResponse: Response;
let importResponse: Response;
let testResponse: Response;
let configResponse: Response;

describe('TdSynnexEcExpressPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusResponse = jsonResponse(statusPayload);
    meResponse = jsonResponse({ defaultMarkupPercent: null, autoTaxHardware: true });
    lookupResponse = jsonResponse({ data: [] });
    importResponse = jsonResponse({ data: { id: 'catalog-1' } });
    testResponse = jsonResponse(statusPayload);
    configResponse = jsonResponse(statusPayload);
    fetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === 'string') {
        if (url.includes('/orgs/partners/me')) return Promise.resolve(meResponse);
        if (url.includes('/td-synnex-ec/lookup')) return Promise.resolve(lookupResponse);
        if (url.includes('/td-synnex-ec/import')) return Promise.resolve(importResponse);
        if (url.includes('/td-synnex-ec/test')) return Promise.resolve(testResponse);
        if (url.includes('/td-synnex-ec/config')) return Promise.resolve(configResponse);
        if (url.includes('/td-synnex-ec/status')) return Promise.resolve(statusResponse);
      }
      return Promise.resolve(statusResponse);
    });
  });

  it('renders config fields and the SKU lookup box after loading status', async () => {
    render(<TdSynnexEcExpressPanel />);
    await waitFor(() => expect(screen.getByLabelText(/Customer No/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/SYNNEX SKU or mfg part/i)).toBeInTheDocument();
  });

  it('loads and renders masked credential status', async () => {
    render(<TdSynnexEcExpressPanel />);
    expect(await screen.findByTestId('td-synnex-ec-panel')).toBeTruthy();
    expect((screen.getByTestId('td-synnex-ec-password') as HTMLInputElement).value).toBe('********');
  });

  it('saves configuration with runAction', async () => {
    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');
    fireEvent.change(screen.getByTestId('td-synnex-ec-customer-no'), { target: { value: 'CUST-2' } });
    fireEvent.click(screen.getByTestId('td-synnex-ec-save'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-ec/config',
        expect.objectContaining({ method: 'PUT' })
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders the success indicator after a test without blanking the form', async () => {
    const testResult = {
      data: {
        configured: true,
        enabled: true,
        region: 'US',
        credentials: { email: '********', password: '********', customerNo: 'CUST-1' },
        settings: { defaultWarehouse: '', hideZeroInv: false, defaultMarkupPercent: 0 },
        lastTestStatus: 'success',
        lastTestAt: '2026-06-23T00:00:00.000Z',
        lastTestError: null,
      },
    };
    testResponse = jsonResponse(testResult); // POST /test

    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');

    fireEvent.click(screen.getByTestId('td-synnex-ec-test'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-ec/test',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Success indicator renders (was never reached when the service returned the
    // old { ok } shape with lastTestStatus 'ok' instead of 'success').
    await waitFor(() =>
      expect(within(screen.getByTestId('td-synnex-ec-status-label')).getByText(/Last test succeeded/i)).toBeTruthy()
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // Form/credentials are NOT blanked out by the response mapping.
    expect((screen.getByTestId('td-synnex-ec-customer-no') as HTMLInputElement).value).toBe('CUST-1');
    expect((screen.getByTestId('td-synnex-ec-password') as HTMLInputElement).value).toBe('********');
  });

  it('renders the failure error state after a failed test without blanking the form', async () => {
    const failedResult = {
      data: {
        configured: true,
        enabled: true,
        region: 'US',
        credentials: { email: '********', password: '********', customerNo: 'CUST-1' },
        settings: { defaultWarehouse: '', hideZeroInv: false, defaultMarkupPercent: 0 },
        lastTestStatus: 'failed',
        lastTestAt: '2026-06-23T00:00:00.000Z',
        lastTestError: 'TD SYNNEX authentication failed',
      },
    };
    testResponse = jsonResponse({ error: 'TD SYNNEX authentication failed', code: 'EC_AUTH_FAILED' }, 422); // POST /test fails

    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');

    // After the failed test, testConnection reloads status — surface the failure state.
    statusResponse = jsonResponse(failedResult);
    fireEvent.click(screen.getByTestId('td-synnex-ec-test'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-ec/test',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // The failure error state renders (status reload surfaces lastTestStatus 'failed').
    const errorEl = await screen.findByTestId('td-synnex-ec-test-error');
    expect(errorEl.textContent).toMatch(/authentication failed/i);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // Form/credentials are not blanked out.
    expect((screen.getByTestId('td-synnex-ec-customer-no') as HTMLInputElement).value).toBe('CUST-1');
  });

  it('looks up a SKU and renders pricing, availability, and warehouse stock', async () => {
    lookupResponse = jsonResponse({ data: [product] });

    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');
    fireEvent.change(screen.getByTestId('td-synnex-ec-lookup-query'), { target: { value: 'SNX-1' } });
    fireEvent.click(screen.getByTestId('td-synnex-ec-lookup'));

    const card = await screen.findByTestId('td-synnex-ec-result-SNX-1');
    expect(within(card).getByText('ThinkPad Dock')).toBeTruthy();
    expect(within(card).getByText(/USB-C dock/)).toBeTruthy();
    expect(within(card).getByText(/100\.00/)).toBeTruthy();
    expect(within(card).getByText(/150\.00/)).toBeTruthy();
    expect(within(card).getByText('CA')).toBeTruthy();
  });

  it('pre-fills the sell price from the partner default markup and shows the margin calc', async () => {
    lookupResponse = jsonResponse({ data: [product] });
    meResponse = jsonResponse({ defaultMarkupPercent: 25, autoTaxHardware: true });

    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');
    fireEvent.change(screen.getByTestId('td-synnex-ec-lookup-query'), { target: { value: 'SNX-1' } });
    fireEvent.click(screen.getByTestId('td-synnex-ec-lookup'));

    const card = await screen.findByTestId('td-synnex-ec-result-SNX-1');
    // cost 100 + 25% markup -> 125.00 (overrides the MSRP default of 150).
    expect((within(card).getByTestId('td-synnex-ec-sell-price') as HTMLInputElement).value).toBe('125.00');
    const margin = within(card).getByTestId('td-synnex-ec-margin-SNX-1');
    expect(margin.textContent).toContain('Markup 25.0%');
    expect(margin.textContent).toContain('Margin 20.0%');
  });

  it('imports a result with sell price prefilled from msrp', async () => {
    lookupResponse = jsonResponse({ data: [product] });

    render(<TdSynnexEcExpressPanel />);
    await screen.findByTestId('td-synnex-ec-panel');
    fireEvent.change(screen.getByTestId('td-synnex-ec-lookup-query'), { target: { value: 'SNX-1' } });
    fireEvent.click(screen.getByTestId('td-synnex-ec-lookup'));

    const card = await screen.findByTestId('td-synnex-ec-result-SNX-1');
    expect((within(card).getByTestId('td-synnex-ec-sell-price') as HTMLInputElement).value).toBe('150.00');
    fireEvent.click(within(card).getByTestId('td-synnex-ec-import'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-ec/import',
        expect.objectContaining({ method: 'POST' })
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
});
