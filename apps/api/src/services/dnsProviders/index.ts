import type { DnsAction, DnsIntegrationConfig, DnsProvider as DnsProviderType } from '../../db/schema';
import { isHosted } from '../../config/env';
import { UmbrellaProvider } from './umbrella';
import { CloudflareGatewayProvider } from './cloudflare';
import { DnsFilterProvider } from './dnsfilter';
import { PiHoleProvider } from './pihole';
import { AdGuardHomeProvider } from './adguardHome';

export interface DnsEvent {
  timestamp: Date;
  domain: string;
  queryType: string;
  action: DnsAction;
  category?: string;
  threatType?: string;
  sourceIp?: string;
  sourceHostname?: string;
  providerEventId?: string;
  metadata?: Record<string, unknown>;
}

export interface DnsProvider {
  syncEvents(since: Date, until: Date): Promise<DnsEvent[]>;
  addBlocklistDomain(domain: string, reason?: string): Promise<void>;
  removeBlocklistDomain(domain: string): Promise<void>;
  addAllowlistDomain(domain: string): Promise<void>;
  removeAllowlistDomain(domain: string): Promise<void>;
}

export interface DnsProviderFactoryInput {
  provider: DnsProviderType;
  apiKey: string | null;
  apiSecret: string | null;
  config: DnsIntegrationConfig;
}

export function createDnsProvider(input: DnsProviderFactoryInput): DnsProvider {
  if (!input.apiKey) {
    throw new Error(`Missing apiKey for DNS provider ${input.provider}`);
  }

  // On-prem appliance providers (Pi-hole / AdGuard Home) legitimately live on
  // the customer LAN, so on SELF-HOSTED deployments they may reach RFC1918/ULA
  // targets. Hosted SaaS stays strict (no private networking). Metadata,
  // loopback, link-local, and CGNAT remain blocked in both modes (see
  // urlSafety.isAlwaysBlockedIp). Cloud providers leave it unset (strict).
  const allowPrivateNetwork = !isHosted();

  switch (input.provider) {
    case 'umbrella':
      return new UmbrellaProvider(input.apiKey, input.apiSecret, input.config);
    case 'cloudflare':
      return new CloudflareGatewayProvider(input.apiKey, input.config);
    case 'dnsfilter':
      return new DnsFilterProvider(input.apiKey, input.config);
    case 'pihole':
      return new PiHoleProvider(input.apiKey, input.config, allowPrivateNetwork);
    case 'adguard_home':
      return new AdGuardHomeProvider(input.apiKey, input.apiSecret, input.config, allowPrivateNetwork);
    case 'opendns':
    case 'quad9':
      throw new Error(`Provider ${input.provider} is not yet supported for API sync`);
    default:
      throw new Error(`Unsupported DNS provider: ${String(input.provider)}`);
  }
}

export {
  UmbrellaProvider,
  CloudflareGatewayProvider,
  DnsFilterProvider,
  PiHoleProvider,
  AdGuardHomeProvider
};
