import type { DnsAction } from '../../db/schema';
import type { DnsEvent, DnsEventSlice, DnsProvider } from './index';
import { DnsProviderHttpError, requestJson } from './http';
import { asArray, asNumber, asRecord, asString, asStringArray } from './helpers';
import { storesAllowedTraffic } from './syncScope';

/*
 * DNSFilter provider (#12699), written against DNSFilter's published OpenAPI
 * document (https://api.dnsfilter.com/docs/api.json, version 2026-11-20):
 *
 * - Events: GET /v1/traffic_reports/query_logs ("Query Logs"). Rows are in
 *   `data.values`, paging in `data.page`; there is no per-row id.
 * - Block/allow domains live on a DNSFilter POLICY:
 *   POST /v1/policies/{id}/add_blacklist_domain, remove_blacklist_domain,
 *   add_whitelist_domain, remove_whitelist_domain, body { domain, note }.
 * - Auth: the `Authorization` header carries the API key itself (no scheme).
 * - V1 pagination is the nested `page` object, sent in the query string as
 *   `page[number]` / `page[size]`.
 *
 * The provider it replaces called `/v1/dns-events` and `/v1/lists/{id}/...`,
 * neither of which DNSFilter has, so every sync answered 404.
 */

export interface DnsFilterProviderConfig {
  apiEndpoint?: string;
  /** DNSFilter organization id (an integer). Unset: the API key's own organization. */
  organizationId?: string;
  /**
   * Legacy: the "Account ID" field of the first DNSFilter form. Read as the
   * organization id when it is a whole number and `organizationId` is unset.
   */
  accountId?: string;
  /** DNSFilter policy id (an integer) whose block and allow lists Breeze edits. */
  policyId?: string;
  /** Legacy list ids from the first version; DNSFilter's API has no lists, so these are refused. */
  blocklistId?: string;
  allowlistId?: string;
  storeAllowedTraffic?: boolean;
}

const DEFAULT_BASE_URL = 'https://api.dnsfilter.com';

/**
 * Rows per page. The `page.size` schema documents "default: 10, maximum: 100";
 * the endpoint description separately mentions 1,000. 100 is within both.
 */
export const DNSFILTER_PAGE_SIZE = 100;

/**
 * Pages fetched per sync window (100 x 100 = 10,000 rows). The endpoint is
 * documented as "not designed for bulk or continuous log export", so a window
 * with more rows than this is recorded as truncated rather than paged on.
 */
export const DNSFILTER_MAX_PAGES = 100;

const WHOLE_NUMBER = /^[1-9]\d{0,17}$/;
const BREEZE_NOTE_ADD = 'Added by Breeze DNS policy sync';
const BREEZE_NOTE_REMOVE = 'Removed by Breeze DNS policy sync';
const MAX_PROVIDER_DETAIL_LENGTH = 200;

/** `YYYY-MM-DDThh:mm:ssZ`: the documented `from`/`to` format (milliseconds are not listed). */
function formatDnsFilterTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The documented `result` enum is `allowed | blocked`; anything else is not guessed at. */
function mapResult(result: string | undefined): DnsAction | null {
  if (result === 'blocked') return 'blocked';
  if (result === 'allowed') return 'allowed';
  return null;
}

function mapQueryLogRow(entry: unknown): DnsEvent | null {
  const record = asRecord(entry);
  if (!record) return null;

  const timeRaw = asString(record.time);
  const fqdn = asString(record.fqdn) ?? asString(record.domain);
  if (!timeRaw || !fqdn) return null;
  const timestamp = new Date(timeRaw);
  if (Number.isNaN(timestamp.getTime())) return null;

  const action = mapResult(asString(record.result)?.toLowerCase());
  if (!action) return null;

  const categoryNames = asStringArray(record.categories_names);
  const threat = record.threat === true;

  return {
    timestamp,
    domain: fqdn,
    queryType: asString(record.question_type) ?? 'A',
    action,
    category: categoryNames[0],
    threatType: threat ? (categoryNames[0] ?? 'threat') : undefined,
    // The agent's LAN address matches Breeze devices; request_address is the
    // public address a network-level query arrived from.
    sourceIp: asString(record.local_ipv4_address)
      ?? asString(record.local_ipv6_address)
      ?? asString(record.request_address),
    sourceHostname: asString(record.agentname) ?? asString(record.lan_device_name),
    // Documented rows carry no id: the sync job derives a deterministic
    // fallback id from the event's own fields and dedupes re-synced windows on it.
    providerEventId: undefined,
    metadata: {
      registeredDomain: asString(record.domain),
      threat,
      categories: categoryNames,
      policyName: asString(record.policy_name),
      networkName: asString(record.network_name),
      agentType: asString(record.agenttype)
    }
  };
}

/**
 * DNSFilter's own error text, for the tenant-visible sync error. V1 errors are
 * `{ "error": "string" }`, V2 `{ "error": { "message": "string" } }`, and the
 * policy endpoints answer 422 with an array of strings.
 */
function providerErrorDetail(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const raw = Array.isArray(parsed)
    ? asStringArray(parsed).join('; ')
    : asString(record?.error) ?? asString(asRecord(record?.error)?.message);
  if (!raw) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, MAX_PROVIDER_DETAIL_LENGTH) : undefined;
}

function isDnsFilterHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'dnsfilter.com' || host.endsWith('.dnsfilter.com');
  } catch {
    return false;
  }
}

type Operation = 'query logs' | 'policy update';

function statusHint(operation: Operation, status: number): string | undefined {
  if (status === 401) return 'Check that the DNSFilter API key is valid';
  if (status === 403) {
    return operation === 'query logs'
      ? 'The API key cannot read the configured DNSFilter organization ID'
      : 'The API key cannot edit the configured DNSFilter policy';
  }
  if (status === 404 && operation === 'policy update') {
    return 'DNSFilter has no policy with the configured policy ID';
  }
  if (status === 429) return 'DNSFilter rate limit reached; the next sync tries again';
  return undefined;
}

export class DnsFilterProvider implements DnsProvider {
  constructor(
    private readonly apiToken: string,
    private readonly config: DnsFilterProviderConfig
  ) {}

  private baseUrl(): string {
    return (this.config.apiEndpoint ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private async call<T>(operation: Operation, path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = this.baseUrl();
    try {
      return await requestJson<T>(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: this.apiToken,
          ...(init.headers ?? {})
        }
      });
    } catch (error) {
      if (!(error instanceof DnsProviderHttpError)) throw error;
      // The message reaches the tenant-visible sync-error column. DNSFilter's
      // error text is included only when the request went to DNSFilter itself
      // (the create route pins apiEndpoint to *.dnsfilter.com over HTTPS):
      // an upstream body from any other host must not be reflected.
      const detail = isDnsFilterHost(baseUrl) ? providerErrorDetail(error.responseBody) : undefined;
      const hint = statusHint(operation, error.status);
      const message = `DNSFilter ${operation} failed: HTTP ${error.status} ${error.statusText}`
        + (detail ? ` (${detail})` : '')
        + (hint ? `. ${hint}` : '');
      throw new DnsProviderHttpError(error.status, error.statusText, error.responseBody, message);
    }
  }

  /** The `organization_id` to send, or undefined for the API key's own organization. */
  private organizationId(): string | undefined {
    const configured = this.config.organizationId?.trim();
    if (configured) {
      if (!WHOLE_NUMBER.test(configured)) {
        throw new Error(
          'The DNSFilter organization ID on this integration is not a whole number. '
          + 'Enter the numeric DNSFilter organization ID under Stored data on the integration, or clear it to use the API key\'s own organization.'
        );
      }
      return configured;
    }
    const legacy = this.config.accountId?.trim();
    if (!legacy) return undefined;
    if (!WHOLE_NUMBER.test(legacy)) {
      throw new Error(
        'This integration has an "Account ID" from an earlier version that is not a DNSFilter organization ID (a whole number). '
        + 'Enter the numeric DNSFilter organization ID under Stored data on the integration, or clear it to use the API key\'s own organization.'
      );
    }
    return legacy;
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const events: DnsEvent[] = [];
    for await (const slice of this.syncEventSlices(since, until)) {
      events.push(...slice.events);
    }
    return events;
  }

  /**
   * One slice for the whole window. Sliced only so a window with more rows
   * than {@link DNSFILTER_MAX_PAGES} pages can be reported as truncated
   * (lastSyncStatus 'truncated') instead of silently cut short.
   */
  async *syncEventSlices(since: Date, until: Date): AsyncGenerator<DnsEventSlice, void, undefined> {
    const organizationId = this.organizationId();
    const events: DnsEvent[] = [];
    let skipped = 0;
    let rowsSeen = 0;
    let pageNumber = 1;
    let truncated = false;

    try {
      for (let fetched = 0; ; fetched++) {
        if (fetched >= DNSFILTER_MAX_PAGES) {
          truncated = true;
          break;
        }

        const query = new URLSearchParams({
          from: formatDnsFilterTime(since),
          to: formatDnsFilterTime(until),
          result: storesAllowedTraffic(this.config) ? 'all' : 'blocked',
          'page[number]': String(pageNumber),
          'page[size]': String(DNSFILTER_PAGE_SIZE)
        });
        if (organizationId) query.set('organization_id', organizationId);

        const payload = await this.call<Record<string, unknown>>('query logs', `/v1/traffic_reports/query_logs?${query.toString()}`);
        const data = asRecord(payload.data);
        if (!data || !Array.isArray(data.values)) {
          // A shape we do not know must not be recorded as a successful empty sync.
          throw new Error('DNSFilter query logs returned no data.values list (unexpected response shape)');
        }

        const rows = asArray(data.values);
        rowsSeen += rows.length;
        for (const row of rows) {
          const event = mapQueryLogRow(row);
          if (event) events.push(event);
          else skipped++;
        }

        const page = asRecord(data.page);
        const current = asNumber(page?.self) ?? pageNumber;
        const next = asNumber(page?.next);
        const last = asNumber(page?.last);
        const nextPage = next !== undefined && next > current
          ? next
          : next === undefined && last !== undefined && current < last
            ? current + 1
            : undefined;
        if (nextPage === undefined || rows.length === 0) break;
        pageNumber = nextPage;
      }
    } finally {
      if (skipped > 0) {
        console.warn(
          `[DnsFilterProvider] query-log sync skipped ${skipped} unparseable row(s) `
          + '(possible API shape drift, or an unrecognized result).'
        );
      }
    }

    yield {
      events,
      until,
      ...(truncated ? { truncated: { from: since, to: until, reachableRecords: rowsSeen } } : {})
    };
  }

  private requirePolicyId(): string {
    const policyId = this.config.policyId?.trim();
    if (policyId) {
      if (!WHOLE_NUMBER.test(policyId)) {
        throw new Error(
          'The DNSFilter policy ID on this integration is not a whole number. '
          + 'Enter the numeric DNSFilter policy ID under Stored data on the integration.'
        );
      }
      return policyId;
    }
    if (this.config.blocklistId || this.config.allowlistId) {
      throw new Error(
        'DNSFilter keeps blocked and allowed domains on a policy, not a list. This integration still has a list ID from an earlier version, '
        + 'which DNSFilter\'s API does not use. Enter the DNSFilter policy ID under Stored data on the integration.'
      );
    }
    throw new Error(
      'Syncing a block or allow list to DNSFilter needs the DNSFilter policy ID. '
      + 'Enter it under Stored data on the integration.'
    );
  }

  private async updatePolicyDomain(
    action: 'add_blacklist_domain' | 'remove_blacklist_domain' | 'add_whitelist_domain' | 'remove_whitelist_domain',
    domain: string,
    note: string
  ): Promise<void> {
    const policyId = this.requirePolicyId();
    await this.call('policy update', `/v1/policies/${policyId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, note, include_relationships: false })
    });
  }

  async addBlocklistDomain(domain: string, reason?: string): Promise<void> {
    await this.updatePolicyDomain('add_blacklist_domain', domain, reason?.trim() || BREEZE_NOTE_ADD);
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    await this.updatePolicyDomain('remove_blacklist_domain', domain, BREEZE_NOTE_REMOVE);
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    await this.updatePolicyDomain('add_whitelist_domain', domain, BREEZE_NOTE_ADD);
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    await this.updatePolicyDomain('remove_whitelist_domain', domain, BREEZE_NOTE_REMOVE);
  }
}
