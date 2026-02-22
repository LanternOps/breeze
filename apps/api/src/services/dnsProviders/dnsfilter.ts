import type { DnsEvent, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asBoolean, asNumber, asRecord, asString, asStringArray } from './helpers';

export interface DnsFilterProviderConfig {
  apiEndpoint?: string;
  accountId?: string;
  blocklistId?: string;
  allowlistId?: string;
}

export class DnsFilterProvider implements DnsProvider {
  constructor(
    private readonly apiToken: string,
    private readonly config: DnsFilterProviderConfig
  ) {}

  private baseUrl(): string {
    return (this.config.apiEndpoint ?? 'https://api.dnsfilter.com').replace(/\/+$/, '');
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl()}${path}`;
    return requestJson<T>(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(init.headers ?? {})
      }
    });
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const limit = 1000;
    const maxPages = 100;
    const allEvents: DnsEvent[] = [];
    const seenPageKeys = new Set<string>();
    let page = 1;
    let cursor: string | undefined;

    for (let i = 0; i < maxPages; i++) {
      const query = new URLSearchParams({
        from: since.toISOString(),
        to: until.toISOString(),
        limit: String(limit)
      });

      if (this.config.accountId) {
        query.set('accountId', this.config.accountId);
      }

      if (cursor) {
        query.set('cursor', cursor);
      } else {
        query.set('page', String(page));
      }

      const payload = await this.call<Record<string, unknown>>(`/v1/dns-events?${query.toString()}`);
      const rows = asArray(payload.events ?? payload.data ?? payload.results);
      const mapped = rows.flatMap((entry): DnsEvent[] => {
        const record = asRecord(entry);
        if (!record) return [];

        const timestampRaw = asString(record.timestamp) ?? asString(record.datetime);
        const domain = asString(record.domain) ?? asString(record.query);
        if (!timestampRaw || !domain) return [];

        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) return [];

        const actionRaw = (asString(record.action) ?? asString(record.decision) ?? '').toLowerCase();
        const categories = asStringArray(record.categories);

        return [{
          timestamp,
          domain,
          queryType: asString(record.query_type) ?? asString(record.queryType) ?? 'A',
          action: actionRaw.includes('block') ? 'blocked' : actionRaw.includes('redirect') ? 'redirected' : 'allowed',
          category: asString(record.category) ?? categories[0],
          threatType: asString(record.threat_type),
          sourceIp: asString(record.source_ip),
          sourceHostname: asString(record.source_hostname),
          providerEventId: asString(record.id) ?? asString(record.event_id),
          metadata: record
        }];
      });
      allEvents.push(...mapped);

      const paging = asRecord(payload.paging)
        ?? asRecord(payload.meta)
        ?? asRecord(payload.metadata)
        ?? asRecord(payload.result_info);
      const links = asRecord(payload.links);

      const nextCursor = asString(payload.next_cursor)
        ?? asString(paging?.next_cursor)
        ?? asString(paging?.cursor)
        ?? asString(links?.next)
        ?? asString(payload.next);
      const nextPage = asNumber(payload.next_page) ?? asNumber(paging?.next_page);
      const hasMore = asBoolean(payload.has_more) ?? asBoolean(paging?.has_more);
      const totalPages = asNumber(payload.total_pages) ?? asNumber(paging?.total_pages);
      const currentPage = asNumber(payload.page) ?? asNumber(paging?.page) ?? page;

      if (nextCursor) {
        const key = `cursor:${nextCursor}`;
        if (seenPageKeys.has(key)) break;
        seenPageKeys.add(key);

        if (nextCursor.startsWith('http')) {
          const nextUrl = new URL(nextCursor);
          cursor = asString(nextUrl.searchParams.get('cursor')) ?? undefined;
          page = asNumber(nextUrl.searchParams.get('page')) ?? (page + 1);
        } else if (/^\d+$/.test(nextCursor)) {
          cursor = undefined;
          page = Number(nextCursor);
        } else {
          cursor = nextCursor;
        }
        continue;
      }

      if (typeof nextPage === 'number' && nextPage > currentPage) {
        const key = `page:${nextPage}`;
        if (seenPageKeys.has(key)) break;
        seenPageKeys.add(key);
        cursor = undefined;
        page = nextPage;
        continue;
      }

      if (typeof totalPages === 'number' && currentPage < totalPages) {
        const candidate = currentPage + 1;
        const key = `page:${candidate}`;
        if (seenPageKeys.has(key)) break;
        seenPageKeys.add(key);
        cursor = undefined;
        page = candidate;
        continue;
      }

      if (hasMore === true && rows.length >= limit) {
        const candidate = currentPage + 1;
        const key = `page:${candidate}`;
        if (seenPageKeys.has(key)) break;
        seenPageKeys.add(key);
        cursor = undefined;
        page = candidate;
        continue;
      }

      break;
    }

    return allEvents;
  }

  private requireListId(type: 'block' | 'allow'): string {
    const listId = type === 'block' ? this.config.blocklistId : this.config.allowlistId;
    if (!listId) {
      throw new Error(`DNSFilter ${type}list sync requires ${type}listId in integration config`);
    }
    return listId;
  }

  async addBlocklistDomain(domain: string, reason?: string): Promise<void> {
    const listId = this.requireListId('block');
    await this.call(`/v1/lists/${listId}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, reason })
    });
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('block');
    await this.call(`/v1/lists/${listId}/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE'
    });
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('allow');
    await this.call(`/v1/lists/${listId}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain })
    });
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('allow');
    await this.call(`/v1/lists/${listId}/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE'
    });
  }
}
