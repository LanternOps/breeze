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

// Route fetch by URL (not call order) so the panel's extra GET /orgs/partners/me
// on mount can't shift a positional mock queue (the no-positional-mock lesson).
let statusResponse: Response;
let meResponse: Response;
let searchResponse: Response;
let importResponse: Response;
let testResponse: Response;
let configResponse: Response;
let enrichResponse: Response;

describe('TdSynnexCatalogPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusResponse = jsonResponse(statusPayload);
    meResponse = jsonResponse({ defaultMarkupPercent: null, autoTaxHardware: true });
    searchResponse = jsonResponse({ data: [] });
    importResponse = jsonResponse({ data: { id: 'catalog-1' } });
    testResponse = jsonResponse(statusPayload);
    configResponse = jsonResponse(statusPayload);
    enrichResponse = jsonResponse({
      data: {
        draft: {
          name: 'Dell Pro 14 Laptop (Ultra 5 235U, 16GB, 512GB SSD)',
          description: 'Dell Pro 14 business laptop with Intel Core Ultra 5 235U, 16 GB RAM, 512 GB SSD, and a 14" FHD+ non-touch display.',
          itemType: 'hardware',
          unitOfMeasure: 'each',
          taxable: true,
          taxCategory: null,
        },
        priceGuidance: 'Typical street price 900-1100 USD',
        provenance: {
          source: 'ai_enrich',
          model: 'test-model',
          query: 'Dell Pro 14',
          suggestion: {},
          enrichedAt: '2026-06-26T00:00:00.000Z',
          enrichedBy: 'user-1',
        },
      },
    });
    fetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === 'string') {
        if (url.includes('/orgs/partners/me')) return Promise.resolve(meResponse);
        if (url.includes('/catalog/enrich')) return Promise.resolve(enrichResponse);
        if (url.includes('/td-synnex/search')) return Promise.resolve(searchResponse);
        if (url.includes('/td-synnex/import')) return Promise.resolve(importResponse);
        if (url.includes('/td-synnex/test')) return Promise.resolve(testResponse);
        if (url.includes('/td-synnex/config')) return Promise.resolve(configResponse);
        if (url.includes('/td-synnex/status')) return Promise.resolve(statusResponse);
      }
      return Promise.resolve(statusResponse);
    });
  });

  it('loads and renders masked credential status', async () => {
    render(<TdSynnexCatalogPanel />);

    expect(await screen.findByTestId('td-synnex-panel')).toBeTruthy();
    expect((screen.getByTestId('td-synnex-api-key') as HTMLInputElement).value).toBe('********');
    expect(screen.getByTestId('td-synnex-status-label').textContent).toContain('Configured');
  });

  it('saves configuration with runAction', async () => {
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
    searchResponse = jsonResponse({ data: [product] });

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
    searchResponse = jsonResponse({ data: [product] });

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

  it('surfaces an import failure and does not fire the imported callback', async () => {
    const onImported = vi.fn();
    searchResponse = jsonResponse({ data: [product] });
    importResponse = jsonResponse({ error: 'An item with this SKU already exists', code: 'DUPLICATE_SKU' }, 409);

    render(<TdSynnexCatalogPanel onImported={onImported} />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));
    fireEvent.click(await screen.findByTestId('td-synnex-import-open-td-1'));
    fireEvent.change(screen.getByTestId('td-synnex-import-price'), { target: { value: '125.00' } });
    fireEvent.click(screen.getByTestId('td-synnex-import-save'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(onImported).not.toHaveBeenCalled();
  });

  it('pre-fills the sell price from the partner default markup and shows the margin calc', async () => {
    searchResponse = jsonResponse({ data: [product] });
    meResponse = jsonResponse({ defaultMarkupPercent: 25, autoTaxHardware: true });

    render(<TdSynnexCatalogPanel />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));
    fireEvent.click(await screen.findByTestId('td-synnex-import-open-td-1'));

    // cost 100 + 25% markup -> 125.00 sell price.
    expect((screen.getByTestId('td-synnex-import-price') as HTMLInputElement).value).toBe('125');
    const margin = screen.getByTestId('td-synnex-import-margin');
    expect(margin.textContent).toContain('Markup 25.0%');
    expect(margin.textContent).toContain('Margin 20.0%');
    expect(margin.textContent).toContain('Profit USD 25.00');
  });

  it('applies an AI enrich result to the description without changing the sell price', async () => {
    searchResponse = jsonResponse({ data: [product] });
    meResponse = jsonResponse({ defaultMarkupPercent: 25, autoTaxHardware: true });

    render(<TdSynnexCatalogPanel />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));
    fireEvent.click(await screen.findByTestId('td-synnex-import-open-td-1'));

    // cost 100 + 25% markup -> 125.00 sell price (pre-fill must survive the enrich).
    expect((screen.getByTestId('td-synnex-import-price') as HTMLInputElement).value).toBe('125');

    fireEvent.change(screen.getByTestId('catalog-enrich-input-td-synnex-import'), { target: { value: 'Dell Pro 14' } });
    fireEvent.click(screen.getByTestId('catalog-enrich-btn-td-synnex-import'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/enrich',
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect((screen.getByTestId('td-synnex-import-description') as HTMLTextAreaElement).value)
        .toContain('Dell Pro 14 business laptop');
    });
    // Name also refreshed from the cleaned-up draft.
    expect((screen.getByTestId('td-synnex-import-name') as HTMLInputElement).value)
      .toBe('Dell Pro 14 Laptop (Ultra 5 235U, 16GB, 512GB SSD)');
    // Pricing/margin logic stays intact — sell price unchanged by enrich.
    expect((screen.getByTestId('td-synnex-import-price') as HTMLInputElement).value).toBe('125');
  });

  it('treats an HTTP-200 { success:false } search body as a failure', async () => {
    searchResponse = jsonResponse({ success: false, error: 'Search backend down' }, 200);

    render(<TdSynnexCatalogPanel />);
    await screen.findByTestId('td-synnex-panel');
    fireEvent.change(screen.getByTestId('td-synnex-search-query'), { target: { value: 'dock' } });
    fireEvent.click(screen.getByTestId('td-synnex-search'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(screen.queryByText('ThinkPad Dock')).toBeNull();
  });
});
