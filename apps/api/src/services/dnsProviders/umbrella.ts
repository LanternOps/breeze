import type { DnsEvent, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asBoolean, asNumber, asRecord, asString, asStringArray } from './helpers';

export interface UmbrellaProviderConfig {
  organizationId?: string;
  blocklistId?: string;
  allowlistId?: string;
}

export class UmbrellaProvider implements DnsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string | null | undefined,
    private readonly config: UmbrellaProviderConfig
  ) {}

  private basicAuthHeader(): string {
    if (!this.apiSecret) {
      throw new Error('Cisco Umbrella integration requires apiSecret');
    }
    const token = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
    return `Basic ${token}`;
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const orgId = this.config.organizationId;
    if (!orgId) {
      throw new Error('Cisco Umbrella integration requires config.organizationId');
    }

    const limit = 1000;
    const maxPages = 100;
    const allEvents: DnsEvent[] = [];
    const seenPageKeys = new Set<string>();
    let page = 1;
    let cursor: string | undefined;

    for (let i = 0; i < maxPages; i++) {
      const url = new URL(`https://reports.api.umbrella.com/v2/organizations/${orgId}/security-activity`);
      url.searchParams.set('from', since.toISOString());
      url.searchParams.set('to', until.toISOString());
      url.searchParams.set('limit', String(limit));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      } else {
        url.searchParams.set('page', String(page));
      }

      const payload = await requestJson<Record<string, unknown>>(url, {
        headers: {
          Authorization: this.basicAuthHeader(),
        }
      });

      const requests = asArray(payload.requests ?? payload.data);
      const mapped = requests.flatMap((entry): DnsEvent[] => {
        const record = asRecord(entry);
        if (!record) return [];

        const timestampRaw = asString(record.datetime);
        const domain = asString(record.domain);
        if (!timestampRaw || !domain) return [];

        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) return [];

        const verdict = asString(record.verdict)?.toLowerCase();
        const categories = asStringArray(record.categories);

        return [{
          timestamp,
          domain,
          queryType: asString(record.query_type) ?? 'A',
          action: verdict?.includes('block') ? 'blocked' : 'allowed',
          category: categories[0],
          threatType: asString(record.threat_type),
          sourceIp: asString(record.internal_ip) ?? asString(record.src_ip),
          sourceHostname: asString(record.identity),
          providerEventId: asString(record.request_id),
          metadata: {
            categories
          }
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

      if (typeof nextPage === 'number' && nextPage > page) {
        const key = `page:${nextPage}`;
        if (seenPageKeys.has(key)) break;
        seenPageKeys.add(key);
        cursor = undefined;
        page = nextPage;
        continue;
      }

      if (hasMore === true && requests.length >= limit) {
        const candidate = page + 1;
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

  private getDestinationListId(type: 'block' | 'allow'): string {
    const listId = type === 'block' ? this.config.blocklistId : this.config.allowlistId;
    if (!listId) {
      throw new Error(`Cisco Umbrella ${type}list sync requires ${type}listId in integration config`);
    }
    return listId;
  }

  async addBlocklistDomain(domain: string, reason?: string): Promise<void> {
    const listId = this.getDestinationListId('block');
    const url = `https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`;
    await requestJson(url, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        destination: domain,
        comment: reason
      })
    });
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('block');
    const url = new URL(`https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`);
    url.searchParams.set('destination', domain);

    await requestJson(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.basicAuthHeader()
      }
    });
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('allow');
    const url = `https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`;

    await requestJson(url, {
      method: 'POST',
      headers: {
        Authorization: this.basicAuthHeader(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        destination: domain
      })
    });
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('allow');
    const url = new URL(`https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`);
    url.searchParams.set('destination', domain);

    await requestJson(url, {
      method: 'DELETE',
      headers: {
        Authorization: this.basicAuthHeader()
      }
    });
  }
}
