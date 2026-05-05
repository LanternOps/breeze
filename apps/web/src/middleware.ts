import { defineMiddleware } from 'astro:middleware';
import { resolveConnectSrcDirective, resolveUnsafeInlineCspOptions } from './lib/csp';

function readFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function buildFallbackCspDirectives(options: {
  allowInlineScript: boolean;
  allowInlineStyle: boolean;
  isDev: boolean;
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
    resolveConnectSrcDirective({ isDev: options.isDev })
  ];

  // Monaco Editor and xterm.js inject both inline style attributes and <style>
  // elements at runtime (cursor positioning, syntax highlighting, terminal cell
  // colors/themes).  Astro's experimental.csp auto-generates sha256 hashes for
  // build-time <style> blocks, which per CSP Level 3 causes 'unsafe-inline' in
  // style-src to be silently ignored.  The granular style-src-elem and
  // style-src-attr directives are evaluated independently and don't inherit the
  // hashes from style-src, so 'unsafe-inline' works in both.
  directives.push("style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
  directives.push("style-src-attr 'unsafe-inline'");

  if (!options.allowInlineScript) {
    directives.push("script-src-attr 'none'");
  }

  return directives.join('; ');
}

const strictFallbackCspDirectives = buildFallbackCspDirectives({
  allowInlineScript: false,
  allowInlineStyle: false,
  isDev: import.meta.env.DEV
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

  // Monaco Editor and xterm.js require both inline style attributes and <style>
  // elements.  Always ensure style-src-elem and style-src-attr are set with
  // 'unsafe-inline' (see buildFallbackCspDirectives comment for rationale).
  const filteredStyleGranular = directives.filter(
    (directive) =>
      !directive.toLowerCase().startsWith('style-src-elem ') &&
      !directive.toLowerCase().startsWith('style-src-attr ')
  );
  directives.length = 0;
  directives.push(...filteredStyleGranular);
  directives.push("style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net");
  directives.push("style-src-attr 'unsafe-inline'");

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

  const {
    allowInlineScript: allowUnsafeInlineScript,
    allowInlineStyle: allowUnsafeInlineStyle,
  } = resolveUnsafeInlineCspOptions({
    isDev: import.meta.env.DEV,
    strictDevCsp,
  });

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
          allowInlineStyle: allowUnsafeInlineStyle,
          isDev: import.meta.env.DEV
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
    // Monaco Editor and xterm.js inject <style> elements and inline style
    // attributes at runtime.  Astro's hashes in style-src nullify 'unsafe-inline'
    // there, but these granular directives are evaluated independently.
    if (!/\bstyle-src-elem\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net`;
    }
    if (!/\bstyle-src-attr\b/i.test(patchedCsp)) {
      patchedCsp = `${patchedCsp}; style-src-attr 'unsafe-inline'`;
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
