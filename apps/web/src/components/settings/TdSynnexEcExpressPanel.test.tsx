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
  cost: '100.00',
  msrp: '150.00',
  discount: null,
  totalQty: 7,
  warehouses: [{ code: 'CA', available: 5, onOrder: 2, bo: 0, eta: '2026-07-01' }],
  weight: null,
  parcelShippable: null,
  raw: {},
};

describe('TdSynnexEcExpressPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockResolvedValue(jsonResponse(statusPayload));
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
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse(statusPayload));

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

  it('looks up a SKU and renders pricing, availability, and warehouse stock', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse({ data: [product] }));

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

  it('imports a result with sell price prefilled from msrp', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse({ data: [product] }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'catalog-1' } }));

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
