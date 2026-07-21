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
      components: {
        // Site-wide CTA that points docs readers back to the product.
        Banner: './src/components/DocsCTABanner.astro',
      },
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
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Deployment',
          items: [{ autogenerate: { directory: 'deploy' } }],
        },
        {
          label: 'Contributing',
          items: [{ autogenerate: { directory: 'contributing' } }],
        },
        {
          label: 'Agent',
          items: [{ autogenerate: { directory: 'agents' } }],
        },
        {
          label: 'Security Architecture',
          items: [{ autogenerate: { directory: 'security' } }],
        },
        {
          label: 'Features',
          items: [
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
                { slug: 'features/vulnerability-management' },
                { slug: 'features/pam' },
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
                { slug: 'features/approval-security' },
              ],
            },
            {
              label: 'Billing & Invoicing',
              items: [
                { slug: 'features/product-catalog' },
                { slug: 'features/invoices' },
                { slug: 'features/quotes' },
                { slug: 'features/contracts' },
                { slug: 'features/online-payments' },
              ],
            },
            {
              label: 'Backup & Recovery',
              items: [{ autogenerate: { directory: 'backup' } }],
            },
            {
              label: 'Monitoring & Alerting',
              items: [
                { slug: 'features/alerts' },
                { slug: 'features/alert-templates' },
                { slug: 'features/network-monitors' },
                { slug: 'features/service-monitoring' },
                { slug: 'features/performance-metrics' },
                { slug: 'features/network-connections' },
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
                { slug: 'features/event-log-forwarding' },
                { slug: 'features/agent-diagnostics' },
              ],
            },
            {
              label: 'AI & Intelligence',
              items: [
                { slug: 'features/ai' },
                { slug: 'features/ml-insights' },
                { slug: 'features/ai-computer-control' },
                { slug: 'features/ai-for-office' },
                { slug: 'features/mcp-server' },
              ],
            },
            {
              label: 'Fleet & Configuration',
              items: [
                { slug: 'features/devices' },
                { slug: 'features/device-groups' },
                { slug: 'features/linked-profiles' },
                { slug: 'features/tags' },
                { slug: 'features/custom-fields' },
                { slug: 'features/configuration-policies' },
                { slug: 'features/policy-management' },
                { slug: 'features/onedrive-helper' },
                { slug: 'features/warranty-tracking' },
                { slug: 'features/notifications' },
                { slug: 'features/reports' },
              ],
            },
            {
              label: 'Platform',
              items: [
                { slug: 'features/integrations' },
                {
                  label: 'Integration Connectors',
                  items: [
                    { slug: 'features/psa-integrations' },
                    { slug: 'features/identity-integrations' },
                    { slug: 'features/monitoring-integrations' },
                    { slug: 'features/distributor-integrations' },
                    { slug: 'features/accounting-integrations' },
                    { slug: 'features/unifi-integration' },
                  ],
                },
                { slug: 'features/identity-console' },
                { slug: 'features/webhooks' },
                { slug: 'features/plugins' },
                { slug: 'features/branding' },
                { slug: 'features/portal' },
                { slug: 'features/setup-wizard' },
                { slug: 'features/mobile' },
              ],
            },
          ],
        },
        {
          label: 'Monitoring',
          items: [
            { slug: 'monitoring/alerts' },
            { slug: 'monitoring/health' },
            { slug: 'monitoring/stack' },
          ],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
});
