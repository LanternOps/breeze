import { describe, expect, it } from 'vitest';
import { getSafeExternalHref, getSafeHttpHref } from './safeHref';

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
