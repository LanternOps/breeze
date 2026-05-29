import type { DnsAction } from '../../db/schema';
import type { DnsEvent, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asNumber, asRecord, asString, asStringArray } from './helpers';

export interface AdGuardHomeConfig {
  apiEndpoint?: string;
}

// AdGuard Home filtering reason enum (see openapi/openapi.yaml in AdguardTeam/AdGuardHome).
// We treat all "Filtered*" reasons except FilteredInvalid/NotFilteredError as blocked.
const BLOCKED_REASONS = new Set([
  'FilteredBlackList',
  'FilteredSafeBrowsing',
  'FilteredParental',
  'FilteredSafeSearch',
  'FilteredBlockedService'
]);

const REDIRECTED_REASONS = new Set([
  'Rewrite',
  'RewriteEtcHosts',
  'RewriteRule'
]);

// Map AdGuard filter list rule prefix → blocklist domain syntax for set_rules.
// We use Adblock Plus-style rules: `||example.com^` blocks, `@@||example.com^` allows.
function toBlockRule(domain: string): string {
  return `||${domain}^`;
}

function toAllowRule(domain: string): string {
  return `@@||${domain}^`;
}

export class AdGuardHomeProvider implements DnsProvider {
  constructor(
    private readonly username: string,
    private readonly password: string | null,
    private readonly config: AdGuardHomeConfig,
    private readonly allowPrivateNetwork = false
  ) {}

  private baseUrl(): string {
    const endpoint = this.config.apiEndpoint;
    if (!endpoint) {
      throw new Error('AdGuard Home integration requires config.apiEndpoint (e.g. https://adguard.client.local)');
    }
    return endpoint.replace(/\/+$/, '');
  }

  private authHeader(): string {
    const pw = this.password ?? '';
    return `Basic ${Buffer.from(`${this.username}:${pw}`).toString('base64')}`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return requestJson<T>(`${this.baseUrl()}${path}`, {
      ...init,
      allowPrivateNetwork: this.allowPrivateNetwork,
      headers: {
        Authorization: this.authHeader(),
        ...(init.headers ?? {})
      }
    });
  }

  // Read current filtering rules so we can splice in additions/removals without
  // clobbering the user's existing rule set. AdGuard's API replaces the full
  // rules array on each set_rules call.
  private async getFilteringRules(): Promise<string[]> {
    const status = await this.call<Record<string, unknown>>('/control/filtering/status');
    return asStringArray(status.user_rules);
  }

  private async setFilteringRules(rules: string[]): Promise<void> {
    await this.call<unknown>('/control/filtering/set_rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules })
    });
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    // AdGuard's querylog is paginated reverse-chronologically. We page back
    // using `older_than` until we cross `since`. Cap pages to keep one sync
    // bounded even on a busy resolver.
    const perPage = 500;
    const maxPages = 50;
    const events: DnsEvent[] = [];
    let olderThan: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ limit: String(perPage) });
      if (olderThan) params.set('older_than', olderThan);

      const payload = await this.call<Record<string, unknown>>(
        `/control/querylog?${params.toString()}`
      );
      const data = asArray(payload.data);
      if (data.length === 0) break;

      let crossedSince = false;
      let oldestTimestamp: string | undefined;

      for (const entry of data) {
        const record = asRecord(entry);
        if (!record) continue;

        const timestampRaw = asString(record.time);
        const question = asRecord(record.question);
        const domain = asString(question?.name);
        if (!timestampRaw || !domain) continue;

        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) continue;

        oldestTimestamp = timestampRaw;

        if (timestamp < since) {
          crossedSince = true;
          continue;
        }
        if (timestamp > until) continue;

        const reason = asString(record.reason) ?? '';
        let action: DnsAction = 'allowed';
        if (BLOCKED_REASONS.has(reason)) action = 'blocked';
        else if (REDIRECTED_REASONS.has(reason)) action = 'redirected';

        const clientIp = asString(record.client);
        const clientInfo = asRecord(record.client_info);
        const clientName = asString(clientInfo?.name);

        // Provider event id: AdGuard doesn't expose one, so synthesize from
        // (timestamp, domain, client, reason). Elapsed-ms helps distinguish
        // back-to-back queries from the same client.
        const elapsedMs = asString(record.elapsedMs) ?? asNumber(record.elapsedMs)?.toString() ?? '';
        const eventId = `${timestampRaw}|${domain}|${clientIp ?? ''}|${reason}|${elapsedMs}`;

        events.push({
          timestamp,
          domain,
          queryType: asString(question?.type) ?? 'A',
          action,
          sourceIp: clientIp,
          sourceHostname: clientName,
          providerEventId: eventId,
          metadata: { reason, cached: record.cached === true, upstream: asString(record.upstream) }
        });
      }

      if (crossedSince) break;
      if (data.length < perPage) break;
      if (!oldestTimestamp) break;
      olderThan = oldestTimestamp;
    }

    return events;
  }

  async addBlocklistDomain(domain: string): Promise<void> {
    const rules = await this.getFilteringRules();
    const blockRule = toBlockRule(domain);
    if (rules.includes(blockRule)) return;
    rules.push(blockRule);
    await this.setFilteringRules(rules);
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    const rules = await this.getFilteringRules();
    const blockRule = toBlockRule(domain);
    const filtered = rules.filter((r) => r !== blockRule);
    if (filtered.length === rules.length) return;
    await this.setFilteringRules(filtered);
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    const rules = await this.getFilteringRules();
    const allowRule = toAllowRule(domain);
    if (rules.includes(allowRule)) return;
    rules.push(allowRule);
    await this.setFilteringRules(rules);
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    const rules = await this.getFilteringRules();
    const allowRule = toAllowRule(domain);
    const filtered = rules.filter((r) => r !== allowRule);
    if (filtered.length === rules.length) return;
    await this.setFilteringRules(filtered);
  }
}
