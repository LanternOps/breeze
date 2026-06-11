import { describe, expect, it } from 'vitest';
import { DOCS_BASE_URL } from '@breeze/shared';
import { getSafeExternalHref, getSafeHttpHref, isDocsUrl } from './safeHref';

describe('getSafeHttpHref', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example.com/recording',
    'https://user:pass@example.com/recording',
  ])('rejects unsafe recording href %s', (href) => {
    expect(getSafeHttpHref(href, 'https://app.2breeze.app/sessions')).toBeNull();
  });

  it('allows configured http(s) origins and same-origin absolute paths', () => {
    expect(
      getSafeHttpHref(
        'https://cdn.example.com/recording.mp4',
        'https://app.2breeze.app/sessions',
        'https://cdn.example.com',
      ),
    ).toBe('https://cdn.example.com/recording.mp4');
    expect(getSafeHttpHref('/recordings/session-1.mp4', 'https://app.2breeze.app/sessions')).toBe(
      'https://app.2breeze.app/recordings/session-1.mp4',
    );
  });
});

describe('getSafeExternalHref', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example.com/vendor',
    'https://user:pass@vendor.example.com/page',
    'https://vendor.example.com/' + '\u0000' + 'page',
    '',
    '   ',
  ])('rejects unsafe external href %j', (href) => {
    expect(getSafeExternalHref(href)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(getSafeExternalHref(null)).toBeNull();
    expect(getSafeExternalHref(undefined)).toBeNull();
  });

  it('rejects relative paths because external links must be absolute', () => {
    expect(getSafeExternalHref('/vendor/page')).toBeNull();
    expect(getSafeExternalHref('vendor/page')).toBeNull();
  });

  it('accepts http and https absolute vendor URLs', () => {
    expect(getSafeExternalHref('https://vendor.example/page')).toBe('https://vendor.example/page');
    expect(getSafeExternalHref('http://vendor.example/page')).toBe('http://vendor.example/page');
  });

  it('allows an external https origin different from the current origin (key difference from getSafeHttpHref)', () => {
    // getSafeHttpHref would null this out because the origin is not allowlisted;
    // getSafeExternalHref intentionally permits any http(s) origin for vendor links.
    expect(getSafeExternalHref('https://www.mozilla.org/firefox/')).toBe(
      'https://www.mozilla.org/firefox/',
    );
  });
});

describe('isDocsUrl', () => {
  it('accepts the docs origin and any path under it', () => {
    expect(isDocsUrl(DOCS_BASE_URL)).toBe(true);
    expect(isDocsUrl(`${DOCS_BASE_URL}/agents/install`)).toBe(true);
    expect(isDocsUrl(`${DOCS_BASE_URL}/features/device-groups/?x=1#frag`)).toBe(true);
  });

  it.each([
    // Prefix-bypass lookalikes the old startsWith() check let through:
    'https://docs.breezermm.com.evil.com/phish',
    'https://docs.breezermm.com@evil.com/x',
    'https://docs.breezermm.comevil.com',
    // Other unsafe / non-matching values:
    'javascript:alert(1)',
    '//docs.breezermm.com',
    'https://evil.example/x',
    '',
    '   ',
  ])('rejects non-docs-origin value %j', (value) => {
    expect(isDocsUrl(value)).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isDocsUrl(null)).toBe(false);
    expect(isDocsUrl(undefined)).toBe(false);
  });

  it('rejects an http:// docs URL because origin includes the scheme', () => {
    // DOCS_BASE_URL is https; the http variant is a different origin.
    expect(isDocsUrl('http://docs.breezermm.com/agents/install')).toBe(false);
  });
});
