import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

// Base path the portal is served under. Defaults to `/c` so the portal can be
// reverse-proxied behind the main domain (e.g. https://example.com/c/...) without
// a dedicated hostname. Override with PORTAL_BASE_PATH (build-time) — set to `/`
// to serve at the root. See docker/Caddyfile.prod for the matching `/c` carve-out.
const PORTAL_BASE = process.env.PORTAL_BASE_PATH || '/c';

export default defineConfig({
  output: 'server',
  base: PORTAL_BASE,
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
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self' https: ws: wss:"
      ],
      scriptDirective: {
        resources: ["'self'"]
      },
      styleDirective: {
        resources: ["'self'"]
      }
    }
  },
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false
    })
  ],
  server: {
    port: 4322
  },
  vite: {
    ssr: {
      noExternal: ['@tanstack/react-query']
    }
  }
});
