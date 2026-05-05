import { describe, expect, it } from 'vitest';
import { getSafeHttpHref } from './safeHref';

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
