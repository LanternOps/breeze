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
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/LanternOps/breeze' },
      ],
      lastUpdated: true,
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
          label: 'Remote Management',
          items: [
            { slug: 'features/remote-access' },
            { slug: 'features/scripts' },
            { slug: 'features/script-ai' },
            { slug: 'features/automations' },
            { slug: 'features/playbooks' },
            { slug: 'features/deployments' },
            { slug: 'features/system-tools' },
            { slug: 'features/maintenance-windows' },
          ],
        },
        {
          label: 'Patching & Software',
          items: [
            { slug: 'features/patch-management' },
            { slug: 'features/update-rings' },
            { slug: 'features/software-inventory' },
            { slug: 'features/software-policies' },
          ],
        },
        {
          label: 'Security & Compliance',
          items: [
            { slug: 'features/security' },
            { slug: 'features/cis-hardening' },
            { slug: 'features/audit-baselines' },
            { slug: 'features/browser-security' },
            { slug: 'features/dns-security' },
            { slug: 'features/edr-integrations' },
            { slug: 'features/sensitive-data' },
            { slug: 'features/peripheral-control' },
            { slug: 'features/user-risk' },
            { slug: 'features/management-posture' },
            { slug: 'features/user-sessions' },
            { slug: 'features/device-backup' },
          ],
        },
        {
          label: 'Monitoring & Network',
          items: [
            { slug: 'features/snmp' },
            { slug: 'features/bandwidth-monitoring' },
            { slug: 'features/network-baselines' },
            { slug: 'features/network-intelligence' },
            { slug: 'features/discovery' },
            { slug: 'features/ip-history' },
            { slug: 'features/boot-performance' },
            { slug: 'features/reliability' },
            { slug: 'features/change-tracking' },
            { slug: 'features/filesystem-analysis' },
            { slug: 'features/log-shipping' },
            { slug: 'features/agent-diagnostics' },
          ],
        },
        {
          label: 'AI & Intelligence',
          items: [
            { slug: 'features/ai' },
            { slug: 'features/ai-computer-control' },
            { slug: 'features/mcp-server' },
          ],
        },
        {
          label: 'Fleet & Configuration',
          items: [
            { slug: 'features/device-groups' },
            { slug: 'features/tags' },
            { slug: 'features/custom-fields' },
            { slug: 'features/configuration-policies' },
            { slug: 'features/policy-management' },
            { slug: 'features/notifications' },
            { slug: 'features/reports' },
          ],
        },
        {
          label: 'Platform',
          items: [
            { slug: 'features/integrations' },
            { slug: 'features/webhooks' },
            { slug: 'features/plugins' },
            { slug: 'features/branding' },
            { slug: 'features/portal' },
            { slug: 'features/setup-wizard' },
            { slug: 'features/mobile' },
          ],
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
