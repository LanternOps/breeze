import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInvoicePresentation } from './invoicePresentation';

const unstamped = { documentTheme: null, documentPageSize: null };

describe('resolveInvoicePresentation (#6227)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('an issued invoice renders its OWN frozen values, never the partner live ones', () => {
    expect(resolveInvoicePresentation(
      { documentTheme: 'condensed', documentPageSize: 'letter' },
      { documentTheme: 'classic', documentPageSize: 'a4', billingAddressCountry: null, settings: null },
    )).toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('a draft (NULL columns) previews the partner live values', () => {
    expect(resolveInvoicePresentation(unstamped, { documentTheme: 'condensed', documentPageSize: 'letter', billingAddressCountry: null, settings: null }))
      .toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('falls back to classic / the deployment page size when neither level has a value', () => {
    vi.stubEnv('BREEZE_REGION', 'eu');
    expect(resolveInvoicePresentation(unstamped, null)).toEqual({ theme: 'classic', pageSize: 'a4' });
    vi.stubEnv('BREEZE_REGION', 'us');
    expect(resolveInvoicePresentation(unstamped, undefined)).toEqual({ theme: 'classic', pageSize: 'letter' });
  });

  it('resolves each field independently', () => {
    expect(resolveInvoicePresentation(
      { documentTheme: 'condensed', documentPageSize: null },
      { documentTheme: 'classic', documentPageSize: 'letter', billingAddressCountry: null, settings: null },
    )).toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('normalizes an unknown partner value through the shared theme/page-size resolvers', () => {
    expect(resolveInvoicePresentation(unstamped, { documentTheme: 'fancy', documentPageSize: 'legal', billingAddressCountry: 'DE', settings: null }))
      .toEqual({ theme: 'classic', pageSize: 'a4' });
  });

  // #12097: a partner that never chose a page size (NULL) issues on its region default.
  describe('partner with no page-size choice', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    const unset = { documentTheme: 'classic', documentPageSize: null };

    it('US billing country → Letter, even on the EU deployment', () => {
      vi.stubEnv('BREEZE_REGION', 'eu');
      expect(resolveInvoicePresentation(unstamped, { ...unset, billingAddressCountry: 'US', settings: null }).pageSize).toBe('letter');
    });

    it('DE company-details country → A4, even on the US deployment', () => {
      vi.stubEnv('BREEZE_REGION', 'us');
      expect(resolveInvoicePresentation(unstamped, { ...unset, billingAddressCountry: null, settings: { address: { country: 'DE' } } }).pageSize).toBe('a4');
    });

    it('the invoice own frozen value still wins', () => {
      vi.stubEnv('BREEZE_REGION', 'us');
      expect(resolveInvoicePresentation({ documentTheme: null, documentPageSize: 'a4' }, { ...unset, billingAddressCountry: 'US', settings: null }).pageSize).toBe('a4');
    });
  });
});
