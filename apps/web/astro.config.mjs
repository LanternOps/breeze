import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

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
        resources: [
          "'self'",
          'https://cdn.jsdelivr.net',
          'https://static.cloudflareinsights.com',
          "'sha256-dr7co1YqmJP1+caEJBfXkM/oHRwOVAknT+gDygo8nD0='"
        ]
      },
      styleDirective: {
        // 'unsafe-inline' required because xterm.js injects dynamic inline
        // styles at runtime for terminal colors, cursor, and cell rendering.
        // These cannot be pre-hashed at build time.
        resources: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net']
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
        }
      }
    }
  }
});
