import type { DnsEvent, DnsProvider } from './index';
import { DnsProviderHttpError, requestJson } from './http';
import { asArray, asBoolean, asNumber, asRecord, asString, asStringArray } from './helpers';

export interface UmbrellaProviderConfig {
  organizationId?: string;
  blocklistId?: string;
  allowlistId?: string;
}

/** Cisco's OAuth2 client-credentials token endpoint (Umbrella API). */
const UMBRELLA_TOKEN_URL = 'https://api.umbrella.com/auth/v2/token';

/**
 * Refresh this many ms before the advertised expiry so a token can't lapse
 * mid-request. Umbrella tokens live 3600s, so 60s is ~1.7% of the lifetime.
 */
const TOKEN_EXPIRY_SAFETY_MS = 60_000;

/** Fallback lifetime if Umbrella ever omits `expires_in` (documented as 3600). */
const DEFAULT_TOKEN_LIFETIME_S = 3600;

export class UmbrellaProvider implements DnsProvider {
  private tokenCache: { accessToken: string; expiresAt: number } | null = null;
  /** In-flight exchange, so concurrent calls share one token request. */
  private tokenInFlight: Promise<string> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string | null | undefined,
    private readonly config: UmbrellaProviderConfig
  ) {}

  /**
   * Umbrella retired direct Basic Auth on its APIs: the key/secret now buy a
   * short-lived bearer token from the OAuth2 client-credentials endpoint, and
   * every API call carries that token instead (#3271). Sending Basic straight
   * at the API returns 401 for every key type, which is what made the old code
   * look like a credentials problem rather than an auth-scheme one.
   *
   * One token covers every Umbrella surface — the reporting host and
   * `policies/v2` alike — so it is cached on the provider instance.
   */
  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!this.apiSecret) {
      throw new Error('Cisco Umbrella integration requires apiSecret');
    }

    if (!forceRefresh) {
      const cached = this.tokenCache;
      if (cached && cached.expiresAt > Date.now()) {
        return cached.accessToken;
      }
      if (this.tokenInFlight) return this.tokenInFlight;
    }

    const basic = Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString('base64');
    const exchange = (async (): Promise<string> => {
      const payload = await requestJson<Record<string, unknown>>(UMBRELLA_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      const accessToken = asString(payload.access_token);
      if (!accessToken) {
        // Deliberately body-free: the token response is credential material.
        throw new Error('Cisco Umbrella token endpoint returned no access_token');
      }

      const lifetimeS = asNumber(payload.expires_in) ?? DEFAULT_TOKEN_LIFETIME_S;
      this.tokenCache = {
        accessToken,
        expiresAt: Date.now() + Math.max(0, lifetimeS * 1000 - TOKEN_EXPIRY_SAFETY_MS)
      };
      return accessToken;
    })();

    this.tokenInFlight = exchange;
    try {
      return await exchange;
    } finally {
      if (this.tokenInFlight === exchange) this.tokenInFlight = null;
    }
  }

  /**
   * Run an Umbrella API call with a bearer token, refreshing once if the token
   * turns out to be dead.
   *
   * Note the status: an EXPIRED Umbrella token yields **400** with
   * `{"error":"invalid_request"}`, not 401 — so a plain retry-on-401 would miss
   * exactly the case a cache makes possible. 401 is still handled for a token
   * revoked or scoped away mid-run. Genuine validation 400s (a malformed
   * destination, say) are left alone by matching on the error body.
   */
  private async withAuth<T>(call: (authHeader: string) => Promise<T>): Promise<T> {
    const attempt = async (forceRefresh: boolean): Promise<T> => {
      const token = await this.getAccessToken(forceRefresh);
      return call(`Bearer ${token}`);
    };

    try {
      return await attempt(false);
    } catch (error) {
      if (!this.isAuthFailure(error)) throw error;
      this.tokenCache = null;
      return attempt(true);
    }
  }

  private isAuthFailure(error: unknown): boolean {
    if (!(error instanceof DnsProviderHttpError)) return false;
    if (error.status === 401) return true;
    // Umbrella signals an expired/invalid token as 400 invalid_request.
    return error.status === 400 && /invalid_request|invalid_token|unauthorized/i.test(error.responseBody);
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
      // Cisco's reporting API v2 rejects ISO 8601 strings here with
      // {"errors":[{"param":"from","msg":"invalid timestamp"...}]}; per its
      // OpenAPI spec, from/to must be Unix epoch milliseconds as a numeric
      // string (#4597).
      url.searchParams.set('from', String(since.getTime()));
      url.searchParams.set('to', String(until.getTime()));
      url.searchParams.set('limit', String(limit));
      if (cursor) {
        url.searchParams.set('cursor', cursor);
      } else {
        url.searchParams.set('page', String(page));
      }

      const payload = await this.withAuth((authorization) =>
        requestJson<Record<string, unknown>>(url, {
          headers: { Authorization: authorization }
        })
      );

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
    await this.withAuth((authorization) => requestJson(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        destination: domain,
        comment: reason
      })
    }));
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('block');
    const url = new URL(`https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`);
    url.searchParams.set('destination', domain);

    await this.withAuth((authorization) => requestJson(url, {
      method: 'DELETE',
      headers: {
        Authorization: authorization
      }
    }));
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('allow');
    const url = `https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`;

    await this.withAuth((authorization) => requestJson(url, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        destination: domain
      })
    }));
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    const listId = this.getDestinationListId('allow');
    const url = new URL(`https://api.umbrella.com/policies/v2/destinationlists/${listId}/destinations`);
    url.searchParams.set('destination', domain);

    await this.withAuth((authorization) => requestJson(url, {
      method: 'DELETE',
      headers: {
        Authorization: authorization
      }
    }));
  }
}
