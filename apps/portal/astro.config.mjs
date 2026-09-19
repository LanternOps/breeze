import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';

// Base path the portal is served under. Defaults to `/portal` so the portal can be
// reverse-proxied behind the main domain (e.g. https://example.com/portal/...) without
// a dedicated hostname. Override with PORTAL_BASE_PATH (build-time) — set to `/`
// to serve at the root. See docker/Caddyfile.prod for the matching `/portal` carve-out.
const PORTAL_BASE = process.env.PORTAL_BASE_PATH || '/portal';

/**
 * Dev-only: mount the Vite dev server's module graph under the portal's base path.
 *
 * `astro dev` deliberately keeps Vite base-agnostic. It strips `base` off every
 * incoming request in its own front-of-stack middleware
 * (astro/dist/vite-plugin-astro-server/base.js) and never sets Vite's `base`, so
 * the dev server emits its module URLs from the server root: `/src/*`, `/@fs/*`,
 * `/@id/*`, `/@vite/client`, `/node_modules/.vite/deps/*`.
 *
 * That is fine when the browser talks to the dev server directly, but the
 * worktree/dev stack puts Caddy in front of both Astro apps and routes the portal
 * **by path** (`/portal` and `/portal/*` — docker/Caddyfile.prod). Unprefixed
 * module URLs therefore fell through to the web app: a portal-only file 404'd, and
 * a path both apps happen to share (`/src/lib/utils.ts`, `/node_modules/...`) was
 * silently served from the *wrong app*. Either way no portal island hydrated,
 * while the SSR'd markup still looked correct — so portal e2e specs asserted
 * against dead markup (#3906).
 *
 * Setting Vite's `base` makes Vite emit `/portal/`-prefixed URLs across the whole
 * module graph (import analysis, pre-bundled deps, HMR client, react-refresh), so
 * the existing path-based Caddy route already covers them — no Referer sniffing
 * and no dev-only proxy rules. Astro's own middleware strips the prefix back off on
 * the way in, exactly as it already does for page routes. The handful of entry-point
 * URLs Astro hardcodes into the HTML itself are prefixed in src/middleware.ts
 * (see src/lib/devAssetBase.ts) — Vite's `base` does not reach those.
 *
 * `apply: 'serve'` keeps this out of `astro build`: a production build already emits
 * base-prefixed bundled assets via Astro's own `base`, and forcing Vite's `base`
 * there would double-prefix them.
 */
function portalDevBase(basePath) {
  // Vite wants a trailing slash; the `base` convention here does not carry one.
  const viteBase = basePath === '/' ? '/' : `${basePath.replace(/\/+$/, '')}/`;
  const enabled = viteBase !== '/';

  return {
    name: 'breeze:portal-dev-base',
    apply: 'serve',
    config: () => (enabled ? { base: viteBase } : {}),
    configureServer(server) {
      if (!enabled) return undefined;
      // Post hook — runs after Vite has installed its own middleware stack.
      return () => {
        // Vite installs its own base-stripping middleware whenever `base !== '/'`.
        // Astro has already stripped `/portal` off `req.url` by the time it runs
        // (Astro unshifts its middleware to the front of the stack), so Vite's would
        // reject every request with "The server is configured with a public base URL
        // of /portal/ — did you mean to visit ...". Astro's is the one that has to
        // stay: it also handles `/portal` exactly, trailing slashes and the
        // outside-the-base redirect. Drop the redundant one.
        //
        // Loudness caveat on the throw below: from a cold `astro dev` it
        // propagates uncaught out of `vite.createServer` and kills the process,
        // which is what we want (verified — the container logs the full message
        // and the portal never comes up). On a *live restart* (editing this file
        // while the dev server runs) Vite's own `restartServer` catches it, logs
        // "server restart failed" and keeps serving the previous config, so the
        // signal is two easy-to-miss log lines plus a stale server. Restart the
        // process if a base-path change does not seem to take.
        const stack = server.middlewares.stack;
        const index = stack.findIndex((layer) => layer.handle?.name === 'viteBaseMiddleware');
        if (index === -1) {
          throw new Error(
            "[breeze:portal-dev-base] Vite's base middleware ('viteBaseMiddleware') is not in the " +
              'dev middleware stack. Either Vite stopped installing it or it was renamed — without ' +
              'removing it Astro and Vite both strip the base path and every dev request 404s. ' +
              'Re-check this plugin against the installed Vite version.'
          );
        }
        stack.splice(index, 1);
      };
    }
  };
}

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
    react()
  ],
  server: {
    port: 4322
  },
  vite: {
    plugins: [tailwindcss(), portalDevBase(PORTAL_BASE)]
  }
});
