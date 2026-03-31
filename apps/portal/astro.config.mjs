import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
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
