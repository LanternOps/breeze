import { ShieldCheck, type LucideIcon } from 'lucide-react';

export type IntegrationProvider = 'huntress' | 'sentinelone';

export interface ProviderBranding {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the tinted icon tile + chip (theme-aware). NOT a logo. */
  accent: string;
  blurb: string;
  websiteUrl?: string;
}

const BRANDING: Record<IntegrationProvider, ProviderBranding> = {
  huntress: {
    label: 'Huntress',
    icon: ShieldCheck,
    accent: 'bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/40',
    blurb: 'Managed endpoint detection & response — installs the latest agent automatically.',
    websiteUrl: 'https://www.huntress.com',
  },
  sentinelone: {
    label: 'SentinelOne',
    icon: ShieldCheck,
    accent: 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/40',
    blurb: 'Autonomous EDR agent deployed from your uploaded installer.',
    websiteUrl: 'https://www.sentinelone.com',
  },
};

export function getProviderBranding(p: IntegrationProvider): ProviderBranding {
  return BRANDING[p];
}

export function isIntegrationProvider(v: unknown): v is IntegrationProvider {
  return v === 'huntress' || v === 'sentinelone';
}
