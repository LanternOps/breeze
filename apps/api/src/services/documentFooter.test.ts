import { describe, expect, it } from 'vitest';
import { resolveDocumentFooter } from './documentFooter';

// Settings consolidation W02-API (M11, audit finding 22) + #6232: the ONE
// footer/terms resolver, shared by the invoice render/issue paths and the
// quote render/send paths.
describe('resolveDocumentFooter', () => {
  it.each<[string, { documentTerms: string | null; partnerFooter: string | null; brandingFooter: string | null }, string | null]>([
    ['document terms set — wins over everything', { documentTerms: 'Net 30, document terms', partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Net 30, document terms'],
    ['document terms null, partner footer set — partner wins over portal', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Partner footer'],
    ['document terms null, partner footer null, portal footer set — portal is the last resort', { documentTerms: null, partnerFooter: null, brandingFooter: 'Portal footer' }, 'Portal footer'],
    ['all three null — no footer at all', { documentTerms: null, partnerFooter: null, brandingFooter: null }, null],
    ['empty string is an explicit value, not "unset" (?? semantics)', { documentTerms: '', partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, ''],
  ])('%s', (_name, input, expected) => {
    expect(resolveDocumentFooter(input)).toBe(expected);
  });
});
