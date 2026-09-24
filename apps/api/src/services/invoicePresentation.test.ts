import { describe, expect, it } from 'vitest';
import { resolveInvoicePresentation } from './invoicePresentation';

const unstamped = { documentTheme: null, documentPageSize: null };

describe('resolveInvoicePresentation (#6227)', () => {
  it('an issued invoice renders its OWN frozen values, never the partner live ones', () => {
    expect(resolveInvoicePresentation(
      { documentTheme: 'condensed', documentPageSize: 'letter' },
      { documentTheme: 'classic', documentPageSize: 'a4' },
    )).toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('a draft (NULL columns) previews the partner live values', () => {
    expect(resolveInvoicePresentation(unstamped, { documentTheme: 'condensed', documentPageSize: 'letter' }))
      .toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('falls back to classic / a4 when neither level has a value', () => {
    expect(resolveInvoicePresentation(unstamped, null)).toEqual({ theme: 'classic', pageSize: 'a4' });
    expect(resolveInvoicePresentation(unstamped, undefined)).toEqual({ theme: 'classic', pageSize: 'a4' });
  });

  it('resolves each field independently', () => {
    expect(resolveInvoicePresentation(
      { documentTheme: 'condensed', documentPageSize: null },
      { documentTheme: 'classic', documentPageSize: 'letter' },
    )).toEqual({ theme: 'condensed', pageSize: 'letter' });
  });

  it('normalizes an unknown partner value through the shared theme/page-size resolvers', () => {
    expect(resolveInvoicePresentation(unstamped, { documentTheme: 'fancy', documentPageSize: 'legal' }))
      .toEqual({ theme: 'classic', pageSize: 'a4' });
  });
});
