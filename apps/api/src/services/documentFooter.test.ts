import { describe, expect, it } from 'vitest';
import { resolveDocumentFooter, freezeDocumentFooter } from './documentFooter';

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

// #7216: the value STAMPED at issue/send. `''` is the frozen "no footer"
// marker, distinct from NULL ("not frozen yet — resolve live"), so a document
// that went out with no footer can never pick up one added afterwards.
describe('freezeDocumentFooter', () => {
  it.each<[string, { documentTerms: string | null; partnerFooter: string | null; brandingFooter: string | null }, string]>([
    ['document terms set — frozen verbatim', { documentTerms: 'Quote footer', partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Quote footer'],
    ['inherits the partner footer', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Partner footer'],
    ['inherits the portal footer', { documentTerms: null, partnerFooter: null, brandingFooter: 'Portal footer' }, 'Portal footer'],
    ['no footer at any level — stamps the explicit empty marker, never NULL', { documentTerms: null, partnerFooter: null, brandingFooter: null }, ''],
    ['an explicit empty document footer stays empty', { documentTerms: '', partnerFooter: 'Partner footer', brandingFooter: null }, ''],
  ])('%s', (_name, input, expected) => {
    expect(freezeDocumentFooter(input)).toBe(expected);
  });

  it('a frozen "no footer" stays empty when a footer is configured after the stamp', () => {
    const stamped = freezeDocumentFooter({ documentTerms: null, partnerFooter: null, brandingFooter: null });
    // Later render, after a partner AND a portal footer were added:
    expect(resolveDocumentFooter({ documentTerms: stamped, partnerFooter: 'Added later', brandingFooter: 'Also later' })).toBe('');
  });

  it('an unfrozen (NULL) document still resolves live — drafts and pre-#7216 rows', () => {
    expect(resolveDocumentFooter({ documentTerms: null, partnerFooter: 'Added later', brandingFooter: null })).toBe('Added later');
  });
});
