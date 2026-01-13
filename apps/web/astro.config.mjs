import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone'
  }),
  integrations: [
    react(),
    tailwind({
      applyBaseStyles: false
    })
  ],
  server: {
    port: 4321
  },
  vite: {
    ssr: {
      noExternal: ['@tanstack/react-query']
    }
  }
});
