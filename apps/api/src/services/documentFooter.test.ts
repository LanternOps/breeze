import { describe, expect, it } from 'vitest';
import { resolveDocumentFooter, freezeDocumentFooter, resolveInheritedDocumentFooter } from './documentFooter';

// Settings consolidation W02-API (M11, audit finding 22) + #6232: the ONE
// footer/terms resolver, shared by the invoice render/issue paths and the
// quote render/send paths.
describe('resolveDocumentFooter', () => {
  it.each<[string, { documentTerms: string | null; partnerFooter: string | null; brandingFooter: string | null }, string | null]>([
    ['document terms set — wins over everything', { documentTerms: 'Net 30, document terms', partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Net 30, document terms'],
    // #7510 (settings rule 3): the org's own footer overrides the partner default.
    ['document terms null, org footer set — org override wins over the partner default', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Portal footer'],
    ['document terms null, org footer null — inherits the partner default', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: null }, 'Partner footer'],
    ['document terms null, partner footer null, org footer set — org footer', { documentTerms: null, partnerFooter: null, brandingFooter: 'Portal footer' }, 'Portal footer'],
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
    ['org footer set — frozen over the partner default (#7510)', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: 'Portal footer' }, 'Portal footer'],
    ['org footer unset — inherits the partner footer', { documentTerms: null, partnerFooter: 'Partner footer', brandingFooter: null }, 'Partner footer'],
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

// #7510: what a document prints when it has no footer of its own, and where
// that value comes from — the editor shows it beside a blank override field.
describe('resolveInheritedDocumentFooter', () => {
  it('org footer set — the org override, even when the partner has a default', () => {
    expect(resolveInheritedDocumentFooter({ partnerFooter: 'Partner footer', brandingFooter: 'Org footer' }))
      .toEqual({ text: 'Org footer', source: 'brand' });
  });
  it('org footer unset — the partner default', () => {
    expect(resolveInheritedDocumentFooter({ partnerFooter: 'Partner footer', brandingFooter: null }))
      .toEqual({ text: 'Partner footer', source: 'partner' });
  });
  it('neither level set — null', () => {
    expect(resolveInheritedDocumentFooter({ partnerFooter: null, brandingFooter: null })).toBeNull();
  });
  it('agrees with resolveDocumentFooter for an unfrozen document', () => {
    for (const partnerFooter of ['P', null]) {
      for (const brandingFooter of ['O', null]) {
        expect(resolveInheritedDocumentFooter({ partnerFooter, brandingFooter })?.text ?? null)
          .toBe(resolveDocumentFooter({ documentTerms: null, partnerFooter, brandingFooter }));
      }
    }
  });
});
