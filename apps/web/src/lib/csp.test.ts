import { describe, expect, it } from 'vitest';
import { resolveConnectSrcDirective, resolveUnsafeInlineCspOptions } from './csp';

describe('web CSP helpers', () => {
  it('does not allow arbitrary HTTPS or WebSocket endpoints in production', () => {
    const directive = resolveConnectSrcDirective({
      isDev: false,
      env: {
        PUBLIC_API_URL: 'https://api.2breeze.app',
        PUBLIC_SENTRY_DSN_WEB: 'https://key@o123.ingest.sentry.io/456',
      },
    });

    expect(directive).toBe("connect-src 'self' https://api.2breeze.app wss://api.2breeze.app https://o123.ingest.sentry.io");
    expect(directive).not.toMatch(/connect-src[^;]*\bhttps:(\s|$)/);
    expect(directive).not.toMatch(/connect-src[^;]*\bws:(\s|$)/);
    expect(directive).not.toMatch(/connect-src[^;]*\bwss:(\s|$)/);
  });

  it('ignores unsafe-inline env flags outside development', () => {
    expect(
      resolveUnsafeInlineCspOptions({
        isDev: false,
        strictDevCsp: false,
        env: {
          CSP_ALLOW_UNSAFE_INLINE: 'true',
          CSP_ALLOW_UNSAFE_INLINE_SCRIPT: 'true',
          CSP_ALLOW_UNSAFE_INLINE_STYLE: 'true',
        },
      }),
    ).toEqual({ allowInlineScript: false, allowInlineStyle: false });
  });

  it('keeps explicit unsafe-inline development escape hatches', () => {
    expect(
      resolveUnsafeInlineCspOptions({
        isDev: true,
        strictDevCsp: true,
        env: { CSP_ALLOW_DEV_UNSAFE_INLINE: '1' },
      }),
    ).toEqual({ allowInlineScript: true, allowInlineStyle: true });
  });
});
