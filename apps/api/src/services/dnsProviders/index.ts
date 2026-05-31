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
  //
  // Fail closed: only open RFC1918/ULA for on-prem providers when self-host is
  // AFFIRMATIVELY declared (IS_HOSTED explicitly set to a recognized non-truthy
  // value: 'false'/'0'/'no'/'off'). Unset/empty/garbage IS_HOSTED => strict,
  // mirroring the #570 hardening lesson (an unmapped IS_HOSTED must never
  // silently weaken security). We mirror envFlag's truthy set so that any value
  // it would treat as truthy keeps us hosted (strict), and only an explicit
  // recognized falsey signal opens private networking.
  const isHostedRaw = (process.env.IS_HOSTED ?? '').trim().toLowerCase();
  const recognizedSelfHostSignal = new Set(['0', 'false', 'no', 'off']).has(isHostedRaw);
  // `!isHosted()` is implied by the falsey-set membership but kept explicit so
  // the truthy/falsey vocabularies can never drift apart silently.
  const allowPrivateNetwork = recognizedSelfHostSignal && !isHosted();

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

// Re-export so the sync job can identify upstream HTTP errors (and read the
// body off `.responseBody` for server-side logging) without reaching into the
// per-provider http module.
export { DnsProviderHttpError } from './http';
