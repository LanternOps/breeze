import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';
import sentry from '@sentry/astro';

const sentryDsn = process.env.PUBLIC_SENTRY_DSN_WEB ?? process.env.SENTRY_DSN_WEB;
const sentryIntegration = sentryDsn
  ? [
      sentry({
        dsn: sentryDsn,
        environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
        release: process.env.SENTRY_RELEASE,
        sourceMapsUploadOptions: {
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          enabled: Boolean(process.env.SENTRY_AUTH_TOKEN)
        }
      })
    ]
  : [];

// HelpPanel.tsx embeds the docs site in an <iframe>; without an explicit
// frame-src the browser falls back to `default-src 'self'` and blocks it.
// This config is plain ESM evaluated before the TS pipeline, so we can't reuse
// resolveFrameSrcDirective from ./src/lib/csp.ts — keep the semantics in sync.
const frameSrcDirective = (() => {
  const sources = new Set(["'self'", 'https://docs.breezermm.com']);
  try {
    if (process.env.PUBLIC_DOCS_URL) {
      const { protocol, origin } = new URL(process.env.PUBLIC_DOCS_URL);
      if (protocol === 'http:' || protocol === 'https:') sources.add(origin);
    }
  } catch {
    // Ignore invalid PUBLIC_DOCS_URL and fall back to the default origin.
  }
  return `frame-src ${Array.from(sources).join(' ')}`;
})();

export default defineConfig({
  output: 'server',
  devToolbar: {
    enabled: false
  },
  adapter: node({
    mode: 'standalone'
  }),
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        frameSrcDirective,
        "worker-src 'self' blob:",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self' https: ws: wss:"
      ],
      scriptDirective: {
        // Astro auto-hashes its own inline scripts, but is:inline scripts in
        // Layout.astro and certain hydration bootstrap fragments may not be
        // covered.  Add their sha256 hashes here so they pass CSP validation.
        // If a CSP script-src-elem violation appears in the browser console,
        // copy the suggested sha256 hash from the error into this array.
        //
        // ClientRouter swap script: this hash is for the inline script Astro's
        // <ClientRouter> injects during view-transition swaps (issue #618).
        // It is constant per Astro version; if you bump astro, re-verify and
        // update.  Hash-chasing here is a known-fragile workaround --
        // longer-term we should migrate to a nonce-based CSP.
        resources: [
          "'self'",
          'https://static.cloudflareinsights.com',
          "'sha256-dr7co1YqmJP1+caEJBfXkM/oHRwOVAknT+gDygo8nD0='",
          "'sha256-6wgjuQN80bYuvy8C2/v+mFX1HAEgrfvSs+beElRyx+8='"
        ]
      },
      styleDirective: {
        // 'unsafe-inline' required because xterm.js injects dynamic inline
        // styles at runtime for terminal colors, cursor, and cell rendering.
        // These cannot be pre-hashed at build time.
        resources: ["'self'", "'unsafe-inline'"]
      }
    }
  },
  integrations: [
    ...sentryIntegration,
    react(),
    tailwind({
      applyBaseStyles: false
    })
  ],
  server: {
    port: 4321,
    host: '0.0.0.0',
    allowedHosts: ['2breeze.app']
  },
  vite: {
    resolve: {
      dedupe: ['react', 'react-dom']
    },
    optimizeDeps: {
      include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zustand', 'zustand/middleware']
    },
    ssr: {
      noExternal: ['@tanstack/react-query'],
      external: ['@novnc/novnc']
    },
    server: {
      allowedHosts: 'all',
      proxy: {
        '/api': {
          target: process.env.API_URL || 'http://localhost:3001',
          changeOrigin: true,
          ws: true,
          rewrite: (path) => (path.startsWith('/api/v1') ? path : path.replace(/^\/api/, '/api/v1'))
        },
        '^/s/': {
          target: process.env.API_URL || 'http://localhost:3001',
          changeOrigin: true
        }
      }
    }
  }
});
