import type { DnsEvent, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asBoolean, asNumber, asRecord, asString, asStringArray } from './helpers';

export interface CloudflareGatewayConfig {
  accountId?: string;
  blocklistId?: string;
  allowlistId?: string;
}

interface CloudflareApiResponse<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
  result_info?: Record<string, unknown>;
}

export class CloudflareGatewayProvider implements DnsProvider {
  constructor(
    private readonly apiToken: string,
    private readonly config: CloudflareGatewayConfig
  ) {}

  private requireAccountId(): string {
    if (!this.config.accountId) {
      throw new Error('Cloudflare Gateway integration requires config.accountId');
    }
    return this.config.accountId;
  }

  private async call<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<CloudflareApiResponse<T>> {
    const accountId = this.requireAccountId();
    const response = await requestJson<CloudflareApiResponse<T>>(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          ...(init.headers ?? {})
        }
      }
    );

    if (!response.success) {
      const errors = (response.errors ?? []).map((item) => item.message).filter(Boolean).join('; ');
      throw new Error(errors || 'Cloudflare API request failed');
    }

    return response;
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const perPage = 1000;
    const maxPages = 100;
    const events: DnsEvent[] = [];
    const seenCursors = new Set<string>();
    let page = 1;
    let cursor: string | undefined;

    for (let i = 0; i < maxPages; i++) {
      const query = new URLSearchParams({
        since: since.toISOString(),
        until: until.toISOString(),
        per_page: String(perPage),
      });
      if (cursor) {
        query.set('cursor', cursor);
      } else {
        query.set('page', String(page));
      }

      const payload = await this.call<unknown[]>(`/gateway/logs?${query.toString()}`);
      const result = asArray(payload.result);
      const mapped = result.flatMap((entry): DnsEvent[] => {
        const record = asRecord(entry);
        if (!record) return [];

        const timestampRaw = asString(record.timestamp);
        const domain = asString(record.query_name) ?? asString(record.domain);
        if (!timestampRaw || !domain) return [];

        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) return [];

        const actionRaw = (asString(record.action) ?? '').toLowerCase();
        const categories = asStringArray(record.categories);

        return [{
          timestamp,
          domain,
          queryType: asString(record.query_type) ?? 'A',
          action: actionRaw.includes('block') ? 'blocked' : actionRaw.includes('redirect') ? 'redirected' : 'allowed',
          category: asString(record.category) ?? categories[0],
          sourceIp: asString(record.source_ip) ?? asString(asRecord(record.source)?.ip),
          providerEventId: asString(record.id),
          metadata: record
        }];
      });
      events.push(...mapped);

      const info = asRecord(payload.result_info);
      const nextCursor = asString(info?.cursor)
        ?? asString(info?.next_cursor)
        ?? asString(info?.next);
      const hasMore = asBoolean(info?.has_more);
      const totalPages = asNumber(info?.total_pages);
      const currentPage = asNumber(info?.page) ?? page;

      if (nextCursor) {
        if (seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        continue;
      }

      if (hasMore === true) {
        cursor = undefined;
        page = currentPage + 1;
        continue;
      }

      if (typeof totalPages === 'number' && currentPage < totalPages) {
        cursor = undefined;
        page = currentPage + 1;
        continue;
      }

      if (result.length >= perPage) {
        cursor = undefined;
        page = currentPage + 1;
        continue;
      }

      break;
    }

    return events;
  }

  private requireListId(type: 'block' | 'allow'): string {
    const listId = type === 'block' ? this.config.blocklistId : this.config.allowlistId;
    if (!listId) {
      throw new Error(`Cloudflare ${type}list sync requires ${type}listId in integration config`);
    }
    return listId;
  }

  async addBlocklistDomain(domain: string, reason?: string): Promise<void> {
    const listId = this.requireListId('block');
    await this.call<unknown>(`/gateway/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: domain, description: reason })
    });
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('block');
    const query = new URLSearchParams({ value: domain });
    await this.call<unknown>(`/gateway/lists/${listId}/items?${query.toString()}`, {
      method: 'DELETE'
    });
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('allow');
    await this.call<unknown>(`/gateway/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: domain })
    });
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    const listId = this.requireListId('allow');
    const query = new URLSearchParams({ value: domain });
    await this.call<unknown>(`/gateway/lists/${listId}/items?${query.toString()}`, {
      method: 'DELETE'
    });
  }
}
