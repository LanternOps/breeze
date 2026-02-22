import type { DnsEvent, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asNumber, asRecord, asString } from './helpers';

export interface PiHoleProviderConfig {
  apiEndpoint?: string;
}

export class PiHoleProvider implements DnsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly config: PiHoleProviderConfig
  ) {}

  private baseUrl(): string {
    const endpoint = this.config.apiEndpoint;
    if (!endpoint) {
      throw new Error('Pi-hole integration requires config.apiEndpoint');
    }
    return endpoint.replace(/\/+$/, '');
  }

  private async callApi(params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.baseUrl()}/admin/api.php`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set('auth', this.apiKey);
    return requestJson<Record<string, unknown>>(url);
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const payload = await this.callApi({
      getAllQueries: 'true'
    });

    const rows = asArray(payload.data);
    return rows.flatMap((entry): DnsEvent[] => {
      if (!Array.isArray(entry)) return [];

      const epoch = asNumber(entry[0]);
      const queryType = asString(entry[1]) ?? 'A';
      const domain = asString(entry[2]);
      const sourceIp = asString(entry[3]);
      const status = asString(entry[4]) ?? '';

      if (!epoch || !domain) return [];

      const timestamp = new Date(epoch * 1000);
      if (Number.isNaN(timestamp.getTime())) return [];
      if (timestamp < since || timestamp > until) return [];

      return [{
        timestamp,
        domain,
        queryType,
        action: status.toLowerCase().includes('block') ? 'blocked' : 'allowed',
        sourceIp,
        providerEventId: `${epoch}-${domain}-${sourceIp ?? 'unknown'}`,
        metadata: {
          raw: entry
        }
      }];
    });
  }

  async addBlocklistDomain(domain: string): Promise<void> {
    await this.callApi({
      list: 'black',
      add: domain
    });
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    await this.callApi({
      list: 'black',
      sub: domain
    });
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    await this.callApi({
      list: 'white',
      add: domain
    });
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    await this.callApi({
      list: 'white',
      sub: domain
    });
  }
}
