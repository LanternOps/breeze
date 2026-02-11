import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.breezermm.com',
  integrations: [
    starlight({
      title: 'Breeze RMM',
      logo: {
        src: './src/assets/logo.svg',
      },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/custom.css'],
      social: {
        github: 'https://github.com/LanternOps/breeze',
      },
      editLink: {
        baseUrl: 'https://github.com/LanternOps/breeze/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'getting-started' },
        },
        {
          label: 'Deployment',
          autogenerate: { directory: 'deploy' },
        },
        {
          label: 'Agent',
          autogenerate: { directory: 'agents' },
        },
        {
          label: 'Security',
          autogenerate: { directory: 'security' },
        },
        {
          label: 'Monitoring',
          autogenerate: { directory: 'monitoring' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
      ],
    }),
  ],
});
