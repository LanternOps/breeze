import { defineMiddleware } from 'astro:middleware';

function readFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function isProductionEnvironment(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

function resolveConnectSrcDirective(): string {
  const sources = new Set<string>(["'self'", 'https:', 'ws:', 'wss:']);
  const configuredApiUrl = process.env.PUBLIC_API_URL;

  if (configuredApiUrl) {
    try {
      const parsed = new URL(configuredApiUrl);
      sources.add(parsed.origin);
      if (parsed.protocol === 'http:') {
        sources.add(`ws://${parsed.host}`);
      } else if (parsed.protocol === 'https:') {
        sources.add(`wss://${parsed.host}`);
      }
    } catch {
      // Ignore invalid URL configuration and fall back to default policy.
    }
  }

  if (import.meta.env.DEV) {
    sources.add('http://localhost:3001');
    sources.add('ws://localhost:3001');
  }

  return `connect-src ${Array.from(sources).join(' ')}`;
}

const cspDirectives = [
  // Keep development usable by default; enforce strict CSP defaults in production.
  // Operators can still override per-directive behavior with explicit env flags.
  (() => {
    const isProduction = isProductionEnvironment();
    const allowInlineScript = readFlag('CSP_ALLOW_UNSAFE_INLINE_SCRIPT') || !isProduction;
    const allowInlineStyle = readFlag('CSP_ALLOW_UNSAFE_INLINE_STYLE') || !isProduction;
    return {
      allowInlineScript,
      allowInlineStyle
    };
  })(),
].flatMap((mode) => [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  mode.allowInlineScript
    ? "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
    : "script-src 'self' https://cdn.jsdelivr.net",
  mode.allowInlineStyle
    ? "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
    : "style-src 'self' https://cdn.jsdelivr.net",
  mode.allowInlineStyle ? null : "style-src-attr 'unsafe-inline'",
  "script-src-attr 'none'",
  "worker-src 'self' blob:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  resolveConnectSrcDirective()
]).filter(Boolean).join('; ');

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);

  headers.set('Content-Security-Policy', cspDirectives);
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
});
