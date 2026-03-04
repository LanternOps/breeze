import { defineMiddleware } from 'astro:middleware';

function readFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
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

function buildFallbackCspDirectives(options: {
  allowInlineScript: boolean;
  allowInlineStyle: boolean;
}): string {
  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    options.allowInlineScript
      ? "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://static.cloudflareinsights.com"
      : "script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
    options.allowInlineStyle
      ? "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net"
      : "style-src 'self' https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    resolveConnectSrcDirective()
  ];

  if (!options.allowInlineStyle) {
    directives.push("style-src-attr 'none'");
  }

  if (!options.allowInlineScript) {
    directives.push("script-src-attr 'none'");
  }

  return directives.join('; ');
}

const strictFallbackCspDirectives = buildFallbackCspDirectives({
  allowInlineScript: false,
  allowInlineStyle: false
});

function relaxExistingCsp(
  csp: string,
  options: { allowInlineScript: boolean; allowInlineStyle: boolean }
): string {
  const directives = csp
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const patchDirective = (name: string, token: string): void => {
    const index = directives.findIndex((directive) => directive.toLowerCase().startsWith(`${name} `));
    if (index === -1) {
      directives.push(`${name} ${token}`);
      return;
    }

    const current = directives[index];
    if (!new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(current)) {
      directives[index] = `${current} ${token}`.trim();
    }
  };

  if (options.allowInlineScript) {
    patchDirective('script-src', "'unsafe-inline'");
  }

  if (options.allowInlineStyle) {
    patchDirective('style-src', "'unsafe-inline'");
  }

  if (options.allowInlineScript) {
    const filtered = directives.filter((directive) => !directive.toLowerCase().startsWith('script-src-attr '));
    directives.length = 0;
    directives.push(...filtered);
  } else if (!directives.some((directive) => directive.toLowerCase().startsWith('script-src-attr '))) {
    directives.push("script-src-attr 'none'");
  }

  if (options.allowInlineStyle) {
    const filtered = directives.filter((directive) => !directive.toLowerCase().startsWith('style-src-attr '));
    directives.length = 0;
    directives.push(...filtered);
  } else if (!directives.some((directive) => directive.toLowerCase().startsWith('style-src-attr '))) {
    directives.push("style-src-attr 'none'");
  }

  return directives.join('; ');
}

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  const headers = new Headers(response.headers);
  const strictDevCsp = import.meta.env.DEV && readFlag('CSP_STRICT_DEV');

  // Default dev behavior: do not enforce CSP so Vite/HMR styles and scripts work.
  // Use CSP_STRICT_DEV=1 when you explicitly want CSP enforcement in local dev.
  if (import.meta.env.DEV && !strictDevCsp) {
    headers.delete('Content-Security-Policy');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  const allowUnsafeInlineInDev =
    import.meta.env.DEV && (readFlag('CSP_ALLOW_DEV_UNSAFE_INLINE') || !strictDevCsp);
  const allowUnsafeInlineScriptFlag =
    readFlag('CSP_ALLOW_UNSAFE_INLINE') || readFlag('CSP_ALLOW_UNSAFE_INLINE_SCRIPT');
  const allowUnsafeInlineStyleFlag =
    readFlag('CSP_ALLOW_UNSAFE_INLINE') || readFlag('CSP_ALLOW_UNSAFE_INLINE_STYLE');
  const allowUnsafeInlineScript = allowUnsafeInlineInDev || allowUnsafeInlineScriptFlag;
  const allowUnsafeInlineStyle = allowUnsafeInlineInDev || allowUnsafeInlineStyleFlag;

  // Production is strict by default. Dev allows inline by default because Vite/Astro
  // inject inline script/style for HMR and hydration bootstrap.
  // Set CSP_STRICT_DEV=1 to force strict CSP locally, or use CSP_ALLOW_* flags to opt out.
  if (allowUnsafeInlineScript || allowUnsafeInlineStyle) {
    const existingCsp = headers.get('Content-Security-Policy');
    if (existingCsp) {
      headers.set(
        'Content-Security-Policy',
        relaxExistingCsp(existingCsp, {
          allowInlineScript: allowUnsafeInlineScript,
          allowInlineStyle: allowUnsafeInlineStyle
        })
      );
    } else {
      headers.set(
        'Content-Security-Policy',
        buildFallbackCspDirectives({
          allowInlineScript: allowUnsafeInlineScript,
          allowInlineStyle: allowUnsafeInlineStyle
        })
      );
    }
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  const existingCsp = headers.get('Content-Security-Policy');

  // Astro experimental.csp sets hash-based CSP for HTML responses.
  // Keep this strict fallback for non-HTML responses or routes without Astro rendering.
  if (!existingCsp) {
    headers.set('Content-Security-Policy', strictFallbackCspDirectives);
  } else {
    let patchedCsp = existingCsp;
    if (!/\bscript-src-attr\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; script-src-attr 'none'`;
    }
    if (!/\bstyle-src-attr\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; style-src-attr 'none'`;
    }
    headers.set('Content-Security-Policy', patchedCsp);
  }
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
