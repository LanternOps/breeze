import type { DnsAction, DnsIntegrationConfig, DnsProvider as DnsProviderType } from '../../db/schema';
import { isHosted } from '../../config/env';
import { UmbrellaProvider } from './umbrella';
import { CloudflareGatewayProvider } from './cloudflare';
import { DnsFilterProvider } from './dnsfilter';
import { PiHoleProvider } from './pihole';
import { PiHoleV6Provider } from './piholeV6';
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

/**
 * One completed stretch of a sliced event sync: every event the provider holds
 * between the previous slice's `until` (or the requested `since`) and this
 * slice's `until` — so the caller can persist it and checkpoint `until`.
 */
export interface DnsEventSlice {
  events: DnsEvent[];
  until: Date;
}

/** Hints a sliced walk can use from the previous run (#10018). */
export interface DnsEventSliceOptions {
  /**
   * The slice width the previous run ended on ({@link DnsEventSliceWalkEnd.sliceWidthMs}).
   * The walk starts at this width instead of the whole window, so a backlog
   * does not pay its splitting cost again every run. Out-of-range values are
   * ignored.
   */
  initialSliceMs?: number;
}

/** What a sliced walk reports when it ends: the generator's return value. */
export interface DnsEventSliceWalkEnd {
  /**
   * Set when the walk stopped before `until` because it ran out of its
   * per-run request budget. `from` is the last checkpoint (the last yielded
   * slice's `until`, or `since` if none was yielded) and `to` the requested
   * `until`: that stretch was not fetched and is resumed on the next run.
   */
  stoppedShort?: { from: Date; to: Date };
  /** Width to start the next run at; passed back as {@link DnsEventSliceOptions.initialSliceMs}. */
  sliceWidthMs?: number;
}

export interface DnsProvider {
  syncEvents(since: Date, until: Date): Promise<DnsEvent[]>;
  /**
   * Optional sliced variant of {@link syncEvents}, for providers whose API
   * cannot return an arbitrarily large window in one walk (Cisco Umbrella's
   * offset cap, #7207). Slices are yielded in chronological order and are
   * contiguous from `since`; once a slice is yielded, its `until` is a safe
   * resume point. It may end before `until` (a per-run request budget) — the
   * caller then resumes from the last slice's `until` on the next run, and the
   * walk's return value says so ({@link DnsEventSliceWalkEnd.stoppedShort}),
   * so the run can be recorded as partial rather than as a success (#10018).
   * When present, the sync job uses this instead of `syncEvents` and persists
   * each slice as it arrives, so a late failure no longer discards earlier pages.
   */
  syncEventSlices?(
    since: Date,
    until: Date,
    options?: DnsEventSliceOptions
  ): AsyncGenerator<DnsEventSlice, DnsEventSliceWalkEnd | void, undefined>;
  addBlocklistDomain(domain: string, reason?: string): Promise<void>;
  removeBlocklistDomain(domain: string): Promise<void>;
  addAllowlistDomain(domain: string): Promise<void>;
  removeAllowlistDomain(domain: string): Promise<void>;
  /**
   * Optional teardown — release any session/connection the provider holds.
   * Stateless providers (v5 Pi-hole token, AdGuard HTTP Basic, cloud APIs) omit
   * it; the session-based Pi-hole v6 client implements it to free its seat.
   * Callers must treat it as best-effort and not let it mask the operation
   * result. Invoked once after a sync run / mutation batch completes.
   */
  dispose?(): Promise<void>;
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
  // The carrier-NAT (Tailscale, 100.64/10) opt-in is per-integration and only
  // takes effect on a self-hosted deployment: it is ANDed with the self-host
  // private-network allowance above, so it can never widen egress on hosted.
  const allowCarrierNat = allowPrivateNetwork && input.config.allowCarrierNatEgress === true;

  switch (input.provider) {
    case 'umbrella':
      return new UmbrellaProvider(input.apiKey, input.apiSecret, input.config);
    case 'cloudflare':
      return new CloudflareGatewayProvider(input.apiKey, input.config);
    case 'dnsfilter':
      return new DnsFilterProvider(input.apiKey, input.config);
    case 'pihole':
      // v6 reworked the admin API into a session-based REST surface; v5 (default
      // when unset) keeps the legacy /admin/api.php?...&auth= token endpoint.
      return input.config.piholeVersion === 'v6'
        ? new PiHoleV6Provider(input.apiKey, input.config, allowPrivateNetwork, allowCarrierNat)
        : new PiHoleProvider(input.apiKey, input.config, allowPrivateNetwork, allowCarrierNat);
    case 'adguard_home':
      return new AdGuardHomeProvider(input.apiKey, input.apiSecret, input.config, allowPrivateNetwork, allowCarrierNat);
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
  PiHoleV6Provider,
  AdGuardHomeProvider
};

// Re-export so the sync job can identify upstream HTTP errors (and read the
// body off `.responseBody` for server-side logging) without reaching into the
// per-provider http module.
export { DnsProviderHttpError } from './http';
