import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// SOC 2 header hardening (RoboShadow/ZAP scan, 2026-10-18). Static assets
// (/_astro/*, theme-bootstrap.js) are served by the Astro node server without
// running the web middleware, so Caddy is the only place that can put
// Permissions-Policy and Cross-Origin-Resource-Policy on every response.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const whole = readFileSync(path.join(REPO_ROOT, 'docker/Caddyfile.prod'), 'utf8').replace(/#[^\n]*/g, '');
// Only the app site block. The tunnel site block (TUNNEL_SITE_ADDRESS) has its
// own, deliberately narrower header policy.
const tunnelStart = whole.indexOf('{$TUNNEL_SITE_ADDRESS');
const caddy = tunnelStart === -1 ? whole : whole.slice(0, tunnelStart);

describe('docker/Caddyfile.prod security headers', () => {
  it('defaults Permissions-Policy on every response (static assets included)', () => {
    expect(caddy).toMatch(/^\s*\?Permissions-Policy\s+"camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)"/m);
  });

  it('defaults Cross-Origin-Resource-Policy same-site, but not on API routes (public trust badge is embedded cross-origin)', () => {
    const block = caddy.match(/^\s*header\s+@corp\s*\{([^}]*)\}/m);
    expect(block, 'header @corp block').not.toBeNull();
    expect(block![1]).toMatch(/\?Cross-Origin-Resource-Policy\s+"same-site"/);
    expect(caddy).toMatch(/^\s*@corp\s*\{\s*\n\s*not path\s+\/api\/\*/m);
  });

  it('replaces (defers) HSTS and nosniff instead of appending a duplicate to the upstream copy', () => {
    expect(caddy).toMatch(/^\s*>Strict-Transport-Security\s+"max-age=31536000; includeSubDomains; preload"/m);
    expect(caddy).toMatch(/^\s*>X-Content-Type-Options\s+"nosniff"/m);
    expect(caddy).not.toMatch(/^\s*Strict-Transport-Security\s/m);
    expect(caddy).not.toMatch(/^\s*X-Content-Type-Options\s/m);
  });
});
