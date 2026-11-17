import { DNS_SYNC_INTERVAL_MINUTES, type DnsIntegrationConfig } from '../db/schema/dnsSecurity';

/** Effective sync interval of a DNS integration, clamped to the allowed range. Shared by the sync job and connection health. */
export function syncIntervalMinutesFromConfig(config: DnsIntegrationConfig): number {
  const configured = Number(config.syncInterval);
  if (!Number.isFinite(configured)) return DNS_SYNC_INTERVAL_MINUTES.DEFAULT;
  return Math.min(DNS_SYNC_INTERVAL_MINUTES.MAX, Math.max(DNS_SYNC_INTERVAL_MINUTES.MIN, Math.round(configured)));
}
