import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login?next=/settings/catalog' }));

import TdSynnexCatalogPanel from './TdSynnexCatalogPanel';

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
    environment: 'sandbox',
    region: 'US',
    baseUrl: 'https://digitalbridge.test',
    authType: 'api_key',
    credentials: { apiKey: '********', apiSecret: '********' },
    settings: {
      accountId: 'acct-1',
      testPath: '/health',
      searchPath: '/catalog/search',
      searchMethod: 'GET',
    },
    lastTestStatus: null,
  },
};

const product = {
  source: 'td_synnex_digital_bridge',
  sourceProductId: 'td-1',
  sku: 'SKU-1',
  manufacturerPartNumber: 'MPN-1',
  vendor: 'Lenovo',
  name: 'ThinkPad Dock',
  description: 'USB-C dock',
  cost: '100.00',
  currency: 'USD',
  availability: 5,
  warehouses: [],
  raw: {},
  lastRefreshedAt: '2026-06-18T00:00:00.000Z',
};

describe('TdSynnexCatalogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockResolvedValue(jsonResponse(statusPayload));
  });

  it('loads and renders masked credential status', async () => {
    render(<TdSynnexCatalogPanel />);

    expect(await screen.findByTestId('td-synnex-panel')).toBeTruthy();
    expect((screen.getByTestId('td-synnex-api-key') as HTMLInputElement).value).toBe('********');
    expect(screen.getByTestId('td-synnex-status-label').textContent).toContain('Configured');
  });

  it('saves configuration with runAction', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse(statusPayload));

    render(<TdSynnexCatalogPanel />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-base-url'), { target: { value: 'https://digitalbridge.example.test' } });
    fireEvent.click(screen.getByTestId('td-synnex-save'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex/config',
        expect.objectContaining({ method: 'PUT' })
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('searches and renders pricing and availability', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse({ data: [product] }));

    render(<TdSynnexCatalogPanel />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));

    expect(await screen.findByText('ThinkPad Dock')).toBeTruthy();
    expect(screen.getByText('USD 100.00')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('imports a selected product and calls the imported callback', async () => {
    const onImported = vi.fn();
    fetchWithAuth
      .mockResolvedValueOnce(jsonResponse(statusPayload))
      .mockResolvedValueOnce(jsonResponse({ data: [product] }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'catalog-1' } }));

    render(<TdSynnexCatalogPanel onImported={onImported} />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));
    fireEvent.click(await screen.findByTestId('td-synnex-import-open-td-1'));
    fireEvent.change(screen.getByTestId('td-synnex-import-price'), { target: { value: '125.00' } });
    fireEvent.click(screen.getByTestId('td-synnex-import-save'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex/import',
        expect.objectContaining({ method: 'POST' })
      );
    });
    expect(onImported).toHaveBeenCalledOnce();
  });
});
