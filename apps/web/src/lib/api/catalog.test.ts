import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import {
  computeMargin, formatMargin, marginTone,
  getBundleEconomics, setItemPrice, removeItemPrice, listItemPrices, setOrgPriceOverride,
  resolveCatalogPrice,
} from './catalog';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

describe('computeMargin', () => {
  it('returns gross margin percent from price and cost in the same currency', () => {
    expect(computeMargin(100, 60, 'USD', 'USD')).toBeCloseTo(40);
    expect(computeMargin('200.00', '50.00', 'EUR', 'EUR')).toBeCloseTo(75);
    expect(computeMargin('100', '50', 'USD', 'USD')).toBe(50);
  });

  it('is negative when cost exceeds price (loss leader)', () => {
    expect(computeMargin(80, 100, 'USD', 'USD')).toBeCloseTo(-25);
  });

  it('returns null when the price and cost currencies differ (never converts)', () => {
    expect(computeMargin('100', '50', 'USD', 'CAD')).toBeNull();
    expect(computeMargin(100, 50, 'USD', null)).toBeNull();
    expect(computeMargin(100, 50, null, 'USD')).toBeNull();
  });

  it('tolerates case / whitespace differences in the currency codes', () => {
    expect(computeMargin(100, 50, 'usd ', 'USD')).toBe(50);
  });

  it('returns null when cost basis is absent or blank', () => {
    expect(computeMargin(100, null, 'USD', 'USD')).toBeNull();
    expect(computeMargin(100, undefined, 'USD', 'USD')).toBeNull();
    expect(computeMargin(100, '', 'USD', 'USD')).toBeNull();
  });

  it('returns null when price is zero, negative, absent or non-numeric (no divide-by-zero)', () => {
    expect(computeMargin(0, 10, 'USD', 'USD')).toBeNull();
    expect(computeMargin(-5, 10, 'USD', 'USD')).toBeNull();
    expect(computeMargin(null, 10, 'USD', 'USD')).toBeNull();
    expect(computeMargin('abc', 10, 'USD', 'USD')).toBeNull();
    expect(computeMargin(100, 'abc', 'USD', 'USD')).toBeNull();
  });
});

describe('formatMargin', () => {
  it('renders one-decimal percent, em-dash for null', () => {
    expect(formatMargin(42.5)).toBe('42.5%');
    expect(formatMargin(-8)).toBe('-8.0%');
    expect(formatMargin(null)).toBe('—');
  });
});

describe('marginTone', () => {
  it('flags negative margins as destructive, others neutral', () => {
    expect(marginTone(-1)).toBe('text-destructive');
    expect(marginTone(30)).toBe('text-foreground');
    expect(marginTone(null)).toBe('text-muted-foreground');
  });
});

describe('price-book requests', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as Response);
  });

  it('setItemPrice PUTs { unitPrice } to /catalog/:id/prices/:currencyCode', async () => {
    await setItemPrice('ID', 'EUR', 10);
    expect(fetchMock).toHaveBeenCalledWith('/catalog/ID/prices/EUR', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ unitPrice: 10 }),
    }));
  });

  it('removeItemPrice DELETEs the currency row; listItemPrices GETs the book', async () => {
    await removeItemPrice('ID', 'EUR');
    expect(fetchMock).toHaveBeenCalledWith('/catalog/ID/prices/EUR', { method: 'DELETE' });
    await listItemPrices('ID');
    expect(fetchMock).toHaveBeenCalledWith('/catalog/ID/prices');
  });

  it('resolveCatalogPrice GETs /catalog/:id/resolve with the currency and (always) the org', async () => {
    // orgId is passed explicitly so fetchWithAuth's active-org injection can
    // never substitute a different org's overrides for the contract's.
    await resolveCatalogPrice('ID', 'EUR', 'org-1');
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/resolve?currencyCode=EUR&orgId=org-1');
    await resolveCatalogPrice('ID', 'cad', null);
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/resolve?currencyCode=CAD', { skipOrgIdInjection: true });
  });

  it('getBundleEconomics passes currencyCode / orgId as query params', async () => {
    await getBundleEconomics('ID', { currencyCode: 'EUR' });
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/economics?currencyCode=EUR');
    await getBundleEconomics('ID', { orgId: 'org-1', currencyCode: 'CAD' });
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/economics?orgId=org-1&currencyCode=CAD');
    await getBundleEconomics('ID');
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/economics');
  });

  it('setOrgPriceOverride sends currencyCode only when given', async () => {
    await setOrgPriceOverride('ID', 'org-1', 70, 'CAD');
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/pricing/org-1', expect.objectContaining({
      method: 'PUT', body: JSON.stringify({ unitPrice: 70, currencyCode: 'CAD' }),
    }));
    await setOrgPriceOverride('ID', 'org-1', 70);
    expect(fetchMock).toHaveBeenLastCalledWith('/catalog/ID/pricing/org-1', expect.objectContaining({
      body: JSON.stringify({ unitPrice: 70 }),
    }));
  });
});
