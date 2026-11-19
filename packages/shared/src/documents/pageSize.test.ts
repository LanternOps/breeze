import { describe, expect, it } from 'vitest';
import {
  pageSizeForCountry,
  partnerDocumentPageSizeDefault,
  resolvePartnerDocumentPageSize,
} from './pageSize';

describe('pageSizeForCountry (#12097)', () => {
  it('prints Letter for the US and Canada', () => {
    expect(pageSizeForCountry('US')).toBe('letter');
    expect(pageSizeForCountry('CA')).toBe('letter');
  });

  it('prints A4 everywhere else', () => {
    for (const country of ['DE', 'GB', 'FR', 'AU', 'BR', 'MX', 'JP']) {
      expect(pageSizeForCountry(country)).toBe('a4');
    }
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(pageSizeForCountry(' us ')).toBe('letter');
    expect(pageSizeForCountry('de')).toBe('a4');
  });

  it('treats a missing or blank country as unknown', () => {
    expect(pageSizeForCountry(null)).toBeNull();
    expect(pageSizeForCountry(undefined)).toBeNull();
    expect(pageSizeForCountry('')).toBeNull();
    expect(pageSizeForCountry('   ')).toBeNull();
    expect(pageSizeForCountry(42)).toBeNull();
  });
});

describe('resolvePartnerDocumentPageSize (#12097)', () => {
  it('US billing country → Letter', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: null, billingAddressCountry: 'US' }, 'a4'))
      .toEqual({ pageSize: 'letter', source: 'billing_address' });
  });

  it('CA billing country → Letter', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: null, billingAddressCountry: 'CA' }, 'a4'))
      .toEqual({ pageSize: 'letter', source: 'billing_address' });
  });

  it('DE billing country → A4', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: null, billingAddressCountry: 'DE' }, 'letter'))
      .toEqual({ pageSize: 'a4', source: 'billing_address' });
  });

  it('falls back to the company-details country when the billing letterhead has none', () => {
    expect(resolvePartnerDocumentPageSize(
      { documentPageSize: null, billingAddressCountry: null, settings: { address: { country: 'GB' } } },
      'letter',
    )).toEqual({ pageSize: 'a4', source: 'company_address' });
    expect(resolvePartnerDocumentPageSize(
      { documentPageSize: null, billingAddressCountry: '', settings: { address: { country: 'CA' } } },
      'a4',
    )).toEqual({ pageSize: 'letter', source: 'company_address' });
  });

  it('the billing letterhead country outranks the company-details country', () => {
    expect(resolvePartnerDocumentPageSize(
      { documentPageSize: null, billingAddressCountry: 'US', settings: { address: { country: 'DE' } } },
      'a4',
    )).toEqual({ pageSize: 'letter', source: 'billing_address' });
  });

  it('unknown country → the deployment fallback, whichever it is', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: null }, 'letter'))
      .toEqual({ pageSize: 'letter', source: 'deployment_region' });
    expect(resolvePartnerDocumentPageSize({ documentPageSize: null, settings: { address: 'junk' } }, 'a4'))
      .toEqual({ pageSize: 'a4', source: 'deployment_region' });
    expect(resolvePartnerDocumentPageSize(null, 'a4')).toEqual({ pageSize: 'a4', source: 'deployment_region' });
  });

  it('an explicit choice wins over every region signal', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: 'a4', billingAddressCountry: 'US' }, 'letter'))
      .toEqual({ pageSize: 'a4', source: 'partner' });
    expect(resolvePartnerDocumentPageSize(
      { documentPageSize: 'letter', billingAddressCountry: 'DE', settings: { address: { country: 'FR' } } },
      'a4',
    )).toEqual({ pageSize: 'letter', source: 'partner' });
  });

  it('an unrecognised stored value is not a choice', () => {
    expect(resolvePartnerDocumentPageSize({ documentPageSize: 'legal', billingAddressCountry: 'DE' }, 'letter'))
      .toEqual({ pageSize: 'a4', source: 'billing_address' });
  });
});

describe('partnerDocumentPageSizeDefault (#12097)', () => {
  it('ignores the explicit choice, so the form can show what "region default" means', () => {
    expect(partnerDocumentPageSizeDefault({ documentPageSize: 'letter', billingAddressCountry: 'DE' }, 'letter'))
      .toEqual({ pageSize: 'a4', source: 'billing_address' });
  });
});
