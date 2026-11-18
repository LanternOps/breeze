/**
 * Pure log-forwarding destination resolution, split out of `logForwarding.ts`
 * (#9762) so settings code can ask the runtime resolver whether a partner
 * Event Logs destination is in force without importing the DB or transport.
 * `logForwarding.ts` re-exports everything here.
 */

export interface LogForwardingConfig {
  enabled: boolean;
  // Field names are retained from the original Elasticsearch-only design to
  // avoid a settings-JSONB migration. The transport speaks the plain
  // Elasticsearch/OpenSearch `_bulk` wire protocol over HTTP (logForwarding.ts), so any
  // compatible sink works (Elasticsearch, OpenSearch, the Wazuh indexer,
  // AWS OpenSearch Service, etc.).
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix: string;
  // True when this destination is the partner-wide one, which is shared by
  // every org under that partner. A shared destination needs per-org index
  // isolation so one org's first document of the day cannot fix a mapping
  // that then rejects another org's documents (or embeds cross-org field
  // names in one index). An org-owned destination is already single-tenant,
  // so its index name is left unchanged for backward compatibility.
  sharedAcrossOrgs?: boolean;
}

export type ForwardingDestinationSource = 'partner' | 'org' | 'none';

/**
 * Pure core of {@link getOrgForwardingConfig}: which destination an org's
 * event logs go to. Only an enabled partner destination with an endpoint
 * overrides the org; otherwise the org's own `settings.logForwarding` applies,
 * and only when it is enabled with an endpoint. Destinations are atomic: org
 * credentials are never combined with a partner URL.
 *
 * Credentials in the returned config are still sealed; the caller opens them
 * with the AAD of the column that owns them (`source`).
 */
export function resolveForwardingDestination(
  partnerEventLogs: unknown,
  orgLogForwarding: unknown,
): { source: ForwardingDestinationSource; config: LogForwardingConfig | null } {
  const partnerForwarding = partnerEventLogs as Partial<LogForwardingConfig> | null | undefined;
  const usePartner = partnerForwarding?.enabled === true && !!partnerForwarding?.elasticsearchUrl;
  const forwarding = usePartner
    ? partnerForwarding
    : orgLogForwarding as Partial<LogForwardingConfig> | null | undefined;

  if (!forwarding?.enabled || !forwarding.elasticsearchUrl) return { source: 'none', config: null };
  return {
    source: usePartner ? 'partner' : 'org',
    config: {
      ...forwarding,
      enabled: true,
      elasticsearchUrl: forwarding.elasticsearchUrl,
      indexPrefix: forwarding.indexPrefix || 'breeze-logs',
      sharedAcrossOrgs: usePartner,
    },
  };
}
