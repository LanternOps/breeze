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
  experimental: {
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
        resources: ["'self'", 'https://cdn.jsdelivr.net', 'https://static.cloudflareinsights.com']
      },
      styleDirective: {
        resources: ["'self'", 'https://cdn.jsdelivr.net']
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
    ssr: {
      noExternal: ['@tanstack/react-query']
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
