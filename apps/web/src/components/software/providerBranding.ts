/** Single source of truth for the provider set — the union and the type guard
 *  both derive from this, so adding a provider can't leave one of them stale. */
export const INTEGRATION_PROVIDERS = ['huntress', 'sentinelone'] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export interface ProviderBranding {
  label: string;
  blurb: string;
  /** Where the integration is connected. Connecting it adds the package to the catalog. */
  setupHref: string;
  websiteUrl?: string;
}

const BRANDING: Record<IntegrationProvider, ProviderBranding> = {
  huntress: {
    label: 'Huntress',
    blurb: 'Managed endpoint detection & response — installs the latest agent automatically.',
    setupHref: '/integrations#huntress',
    websiteUrl: 'https://www.huntress.com',
  },
  sentinelone: {
    label: 'SentinelOne',
    blurb: 'Autonomous EDR agent deployed from your uploaded installer.',
    setupHref: '/integrations#sentinelone',
    websiteUrl: 'https://www.sentinelone.com',
  },
};

export function getProviderBranding(p: IntegrationProvider): ProviderBranding {
  return BRANDING[p];
}

export function isIntegrationProvider(v: unknown): v is IntegrationProvider {
  return (INTEGRATION_PROVIDERS as readonly unknown[]).includes(v);
}
