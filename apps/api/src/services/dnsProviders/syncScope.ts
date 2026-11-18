import type { DnsAction, DnsIntegrationConfig } from '../../db/schema';

/**
 * DNS sync scope (#10054): which provider events Breeze stores.
 *
 * Blocked and redirected events are what Breeze acts on (alerts, the threat
 * timeline, device context) and are always stored. Allowed queries are ~99% of
 * a provider's log (about 1M rows/day on one tenant) and duplicate the
 * provider's own reporting, so they are stored only when the integration opts
 * in with `config.storeAllowedTraffic: true`. The filter applies to new syncs
 * only; allowed rows stored before are kept until retention removes them.
 *
 * This module is the one resolver for the setting: the sync job, the Umbrella
 * upstream verdict filter, `/dns-security/stats` and the `get_dns_security` AI
 * tool all read it from here.
 */

type ScopeConfig = Pick<DnsIntegrationConfig, 'storeAllowedTraffic'> | null | undefined;

/** True only for an explicit boolean opt-in; absent or anything else means "do not store". */
export function storesAllowedTraffic(config: ScopeConfig): boolean {
  return config?.storeAllowedTraffic === true;
}

/** Whether an event with this action is persisted for an integration with this config. */
export function isStoredDnsAction(action: DnsAction, config: ScopeConfig): boolean {
  return action !== 'allowed' || storesAllowedTraffic(config);
}

/**
 * How much of the in-scope DNS data includes allowed traffic:
 * `all` — every active integration stores it; `some` — only part of them do,
 * so allowed totals are partial; `none` — nothing stores it (including no
 * integrations at all), so an allowed count of zero means "not stored", not
 * "no allowed queries".
 */
export type AllowedTrafficCoverage = 'all' | 'some' | 'none';

export function allowedTrafficCoverage(configs: ScopeConfig[]): AllowedTrafficCoverage {
  const storing = configs.filter(storesAllowedTraffic).length;
  if (storing === 0) return 'none';
  return storing === configs.length ? 'all' : 'some';
}

export interface DnsStatsSummary {
  totalQueries: number | null;
  blockedQueries: number;
  allowedQueries: number | null;
  redirectedQueries: number;
  blockedRate: number | null;
}

/**
 * Replace the numbers a stats summary cannot honestly report when no
 * integration in scope stores allowed traffic: the allowed count and the
 * blocked rate (blocked ÷ total is ~100% once allowed rows are missing) become
 * null, as does the total of an allowed-only view. A blocked- or
 * redirected-only view excludes allowed rows by its own filter and is left
 * alone, as are summaries where some or all integrations store allowed traffic
 * (the caller reports `some` alongside the numbers).
 */
export function applyAllowedTrafficCoverage<T extends DnsStatsSummary>(
  summary: T,
  coverage: AllowedTrafficCoverage,
  action: DnsAction | undefined
): T {
  if (coverage !== 'none' || action === 'blocked' || action === 'redirected') return summary;
  return {
    ...summary,
    allowedQueries: null,
    blockedRate: null,
    ...(action === 'allowed' ? { totalQueries: null } : {})
  };
}

/** Plain-language note for API/AI consumers; undefined when the counts are complete. */
export function allowedTrafficNote(coverage: AllowedTrafficCoverage): string | undefined {
  if (coverage === 'none') {
    return 'Allowed DNS traffic is not stored for these integrations (only blocked and redirected queries are synced), '
      + 'so allowed counts and the blocked rate are unavailable. Enable "Store allowed traffic" on an integration to collect them.';
  }
  if (coverage === 'some') {
    return 'Allowed DNS traffic is stored for some integrations only, so allowed counts and the blocked rate are partial.';
  }
  return undefined;
}
