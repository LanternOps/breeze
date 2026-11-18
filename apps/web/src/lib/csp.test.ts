import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  resolveConnectSrcDirective,
  resolveFrameSrcDirective,
  resolveUnsafeInlineCspOptions,
} from './csp';

describe('web CSP helpers', () => {
  it('does not allow arbitrary HTTPS or WebSocket endpoints in production', () => {
    const directive = resolveConnectSrcDirective({
      isDev: false,
      env: {
        PUBLIC_API_URL: 'https://api.2breeze.app',
        PUBLIC_SENTRY_DSN_WEB: 'https://key@o123.ingest.sentry.io/456',
      },
    });

    expect(directive).toBe("connect-src 'self' https://api.2breeze.app wss://api.2breeze.app https://o123.ingest.sentry.io https://cloudflareinsights.com");
    expect(directive).not.toMatch(/connect-src[^;]*\bhttps:(\s|$)/);
    expect(directive).not.toMatch(/connect-src[^;]*\bws:(\s|$)/);
    expect(directive).not.toMatch(/connect-src[^;]*\bwss:(\s|$)/);
  });

  it('allows the hosted docs origin so the in-app help panel iframe loads', () => {
    const directive = resolveFrameSrcDirective({ env: {} });

    expect(directive).toBe("frame-src 'self' blob: https://docs.breezermm.com");
  });

  it('allows blob: so the auth-fetched quote/invoice PDF preview iframe loads', () => {
    const directive = resolveFrameSrcDirective({ env: {} });

    expect(directive).toContain('blob:');
  });

  it('also allows a self-hosted docs origin from PUBLIC_DOCS_URL without duplicating the default', () => {
    expect(
      resolveFrameSrcDirective({ env: { PUBLIC_DOCS_URL: 'https://docs.example.com/help/' } }),
    ).toBe("frame-src 'self' blob: https://docs.breezermm.com https://docs.example.com");

    expect(
      resolveFrameSrcDirective({ env: { PUBLIC_DOCS_URL: 'https://docs.breezermm.com' } }),
    ).toBe("frame-src 'self' blob: https://docs.breezermm.com");
  });

  it('ignores an invalid PUBLIC_DOCS_URL and never widens to a bare scheme', () => {
    const directive = resolveFrameSrcDirective({ env: { PUBLIC_DOCS_URL: 'not a url' } });

    expect(directive).toBe("frame-src 'self' blob: https://docs.breezermm.com");
    expect(directive).not.toMatch(/frame-src[^;]*\bhttps:(\s|$)/);
  });

  // #11300: Network Proxy host mode frames device web UIs from a per-tunnel
  // origin (`https://<id>.<suffix>`). Without that origin in frame-src the
  // browser refuses the iframe before any request reaches the tunnel host.
  it('allows the Network Proxy tunnel origin from TUNNEL_ORIGIN_TEMPLATE', () => {
    expect(
      resolveFrameSrcDirective({ env: { TUNNEL_ORIGIN_TEMPLATE: 'https://{id}.breeze.tunnel.example.net' } }),
    ).toBe("frame-src 'self' blob: https://docs.breezermm.com https://*.breeze.tunnel.example.net");

    // Surrounding whitespace in .env is tolerated, as the API does.
    expect(
      resolveFrameSrcDirective({ env: { TUNNEL_ORIGIN_TEMPLATE: '  https://{id}.us.tunnel.example.net  ' } }),
    ).toBe("frame-src 'self' blob: https://docs.breezermm.com https://*.us.tunnel.example.net");
  });

  it('keeps the port of a local *.localhost tunnel template', () => {
    expect(
      resolveFrameSrcDirective({ env: { TUNNEL_ORIGIN_TEMPLATE: 'http://{id}.tunnel.localhost:8080' } }),
    ).toBe("frame-src 'self' blob: https://docs.breezermm.com http://*.tunnel.localhost:8080");
  });

  it.each([
    ['no {id} label', 'https://tunnel.example.net'],
    ['{id} not the leftmost label', 'https://tunnel.{id}.example.net'],
    ['a path', 'https://{id}.tunnel.example.net/x'],
    ['a single-label suffix', 'https://{id}.localhost'],
    ['uppercase', 'https://{id}.Tunnel.Example.net'],
    ['plain http off localhost', 'http://{id}.tunnel.example.net'],
    ['a port off localhost', 'https://{id}.tunnel.example.net:8443'],
    ['a directive injection', "https://{id}.tunnel.example.net; script-src 'unsafe-inline'"],
    ['a bare wildcard', 'https://*'],
  ])('adds nothing for a malformed TUNNEL_ORIGIN_TEMPLATE (%s)', (_label, template) => {
    const directive = resolveFrameSrcDirective({ env: { TUNNEL_ORIGIN_TEMPLATE: template } });

    expect(directive).toBe("frame-src 'self' blob: https://docs.breezermm.com");
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

// Once the middleware narrows connect-src at runtime, the Cloudflare Web
// Analytics beacon (loaded from static.cloudflareinsights.com, allowed in
// script-src) must still be able to POST its RUM payload.
describe('connect-src allows the Cloudflare Web Analytics beacon endpoint', () => {
  it('includes https://cloudflareinsights.com in production', () => {
    const directive = resolveConnectSrcDirective({ isDev: false, env: { PUBLIC_API_URL: 'https://us.example.app' } });
    expect(directive.split(' ')).toContain('https://cloudflareinsights.com');
    expect(directive).not.toMatch(/\bhttps:(\s|$)/);
  });
});

// #11300: the GHCR web image is built once for every region, so the tunnel
// origin can only reach the CSP from the web container's runtime env. Both
// compose files must hand TUNNEL_ORIGIN_TEMPLATE to the `web` service (the API
// already gets it through the x-api-env anchor).
describe('compose passes the tunnel origin template to the web service', () => {
  // vitest runs with cwd at the apps/web package root.
  const repoRoot = join(process.cwd(), '..', '..');

  function webServiceBlock(composePath: string): string {
    const source = readFileSync(join(repoRoot, composePath), 'utf8');
    const block = source.match(/\n {2}web:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|\n[^\s#][^\n]*:\n|$)/);
    expect(block, `web service not found in ${composePath}`).not.toBeNull();
    return block![1];
  }

  it.each(['docker-compose.yml', 'deploy/docker-compose.prod.yml'])('%s', (composePath) => {
    expect(webServiceBlock(composePath)).toMatch(
      /^ {6}TUNNEL_ORIGIN_TEMPLATE: \$\{TUNNEL_ORIGIN_TEMPLATE:-\}$/m,
    );
  });
});
