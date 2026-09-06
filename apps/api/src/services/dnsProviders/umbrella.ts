import type { DnsAction } from '../../db/schema';
import type { DnsEvent, DnsProvider } from './index';
import { DnsProviderHttpError, requestJson } from './http';
import { asArray, asNumber, asRecord, asString } from './helpers';

export interface UmbrellaProviderConfig {
  organizationId?: string;
  blocklistId?: string;
  allowlistId?: string;
}

/** Cisco's OAuth2 client-credentials token endpoint (Umbrella API). */
const UMBRELLA_TOKEN_URL = 'https://api.umbrella.com/auth/v2/token';

/**
 * Next-gen Umbrella Reports API activity feed.
 *
 * The legacy "Umbrella Reporting v2" host — `reports.api.umbrella.com`, with
 * the org as a path segment — was retired with an EOL of September 2023 and
 * now 404s at Cisco's own gateway ("no Route matched with those values"),
 * which is the failure #4597 reported once auth (#3271) and the epoch-ms
 * timestamps (#4637) were fixed. The replacement carries no org id at all: the
 * OAuth2 token's `sub` claim (`org/<orgId>/client/<apiKey>`) scopes it.
 */
const UMBRELLA_ACTIVITY_URL = 'https://api.umbrella.com/reports/v2/activity';

/**
 * `/reports/v2/activity` is the COMBINED feed — dns, proxy, firewall and
 * intrusion records share one `data[]`, discriminated by `type`. Only DNS
 * records are DnsEvents, and the documented way to scope the combined feed is
 * this header (valid values: dns, proxy, firewall, ip; default `all`). If a
 * tenant's gateway ignores it, the non-DNS records simply fail to map.
 */
const UMBRELLA_TRAFFIC_TYPE_HEADER = { 'x-traffic-type': 'dns' } as const;

/**
 * "The time range set by the `to` and `from` query parameters cannot exceed 30
 * days" (Cisco Reporting API docs). An integration that has been broken for
 * longer than that — the case in #4597 — otherwise asks for a window the API
 * rejects outright and stays broken after the endpoint fix, so the window is
 * clamped to the most recent 30 days rather than failing the sync.
 */
const UMBRELLA_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One `{ label, type }` pair off an activity record's `categories[]`. */
interface UmbrellaLabel {
  label: string;
  type?: string;
}

/**
 * Read a labelled list (`categories`, `policycategories`, `threats`,
 * `identities`). Next-gen records use `[{ id, label, type }]`; a plain string
 * array is accepted too so a shape change drops to a usable label rather than
 * losing the record. `type` is only read when it is a string — on `identities`
 * it is itself an object, and must not throw.
 */
function asLabels(value: unknown): UmbrellaLabel[] {
  return asArray(value).flatMap((entry): UmbrellaLabel[] => {
    const plain = asString(entry);
    if (plain) return [{ label: plain }];

    const record = asRecord(entry);
    const label = asString(record?.label) ?? asString(record?.name);
    if (!label) return [];
    return [{ label, type: asString(record?.type)?.toLowerCase() }];
  });
}

/**
 * Activity timestamps are epoch milliseconds (`timestamp`). An ISO string is
 * still parsed so a mixed/older payload degrades instead of dropping.
 */
function parseActivityTimestamp(value: unknown): Date | null {
  const epochMs = asNumber(value);
  const parsed = epochMs !== undefined ? new Date(epochMs) : new Date(asString(value) ?? '');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The activity record schema documents `verdict` as `allowed | blocked`, while
 * the `verdict` FILTER parameter is documented with `allowed,blocked,proxied`.
 * `proxied` (sent to the intelligent proxy for inspection) is therefore
 * handled but not assumed: if it ever appears it maps to the distinct
 * `redirected` action rather than being silently counted as allowed traffic.
 */
function mapVerdict(verdict: string | undefined): DnsAction {
  if (!verdict) return 'allowed';
  if (verdict.includes('block')) return 'blocked';
  if (verdict.includes('proxied') || verdict.includes('redirect')) return 'redirected';
  return 'allowed';
}

/**
 * Map one `data[]` record from the next-gen activity feed onto a `DnsEvent`.
 *
 * Returns `[]` for anything unusable so a single malformed record costs that
 * record, not the whole sync page.
 */
function mapActivityRecord(entry: unknown): DnsEvent[] {
  const record = asRecord(entry);
  if (!record) return [];

  const domain = asString(record.domain) ?? asLabels(record.domains)[0]?.label;
  const timestamp = parseActivityTimestamp(record.timestamp ?? record.datetime);
  if (!domain || !timestamp) return [];

  const categories = asLabels(record.categories);
  const categoryLabels = categories.map((category) => category.label);
  // A DNS-security event is classified by its SECURITY category; the content
  // category ("Business Services") is usually listed first and would
  // otherwise win and normalize to `unknown` downstream.
  const primaryCategory = categories.find((category) => category.type === 'security')?.label
    ?? asLabels(record.policycategories).find((category) => category.type === 'security')?.label
    ?? categoryLabels[0];

  return [{
    timestamp,
    domain,
    queryType: asString(record.querytype) ?? asString(record.query_type) ?? 'A',
    action: mapVerdict(asString(record.verdict)?.toLowerCase()),
    category: primaryCategory,
    threatType: asLabels(record.threats)[0]?.label ?? asString(record.threattype),
    sourceIp: asString(record.internalip) ?? asString(record.externalip) ?? asString(record.internal_ip),
    sourceHostname: asLabels(record.identities)[0]?.label ?? asString(record.identity),
    // Deliberately unset: the dns/proxy activity schemas document NO per-record
    // id (no id/requestid/eventid — only intrusion records carry a sessionid),
    // so the sync job derives a deterministic fallback id from the event's own
    // fields and dedupes re-synced windows on that.
    providerEventId: undefined,
    metadata: {
      categories: categoryLabels,
      verdict: asString(record.verdict)
    }
  }];
}

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
    // `organizationId` is deliberately NOT read here. The next-gen Reports API
    // takes no org path segment — the OAuth2 token's own `sub` claim
    // (`org/<orgId>/client/<apiKey>`) scopes the request — so requiring it
    // would reject a perfectly valid integration. It stays on the config type
    // for backward compatibility with rows created before this change (#4597).
    const limit = 1000;
    const maxRequests = 100;
    const allEvents: DnsEvent[] = [];

    const to = until.getTime();
    const from = Math.max(since.getTime(), to - UMBRELLA_MAX_WINDOW_MS);
    let offset = 0;

    for (let request = 0; request < maxRequests; request++) {
      const url = new URL(UMBRELLA_ACTIVITY_URL);
      // Epoch milliseconds, not ISO 8601: Cisco rejects ISO strings here with
      // {"errors":[{"param":"from","error":"invalid timestamp specified"}]}
      // (#4597 / #4637). Relative forms ("-7days", "now") are also accepted
      // upstream; explicit bounds keep the sync window deterministic.
      url.searchParams.set('from', String(from));
      url.searchParams.set('to', String(to));
      url.searchParams.set('limit', String(limit));
      // This endpoint pages by limit/offset only — no cursor, no page token,
      // and `meta` is documented as an empty object, so there is no total or
      // has-more to read.
      url.searchParams.set('offset', String(offset));

      const payload = await this.withAuth((authorization) =>
        requestJson<Record<string, unknown>>(url, {
          headers: { Authorization: authorization, ...UMBRELLA_TRAFFIC_TYPE_HEADER }
        })
      );

      const records = asArray(payload.data);
      allEvents.push(...records.flatMap(mapActivityRecord));

      // An EMPTY page is the end of the collection — not a short one. Cisco
      // documents no maximum for `limit`, so a server-side cap below ours
      // would make every page look "short" and silently truncate the sync.
      // Advancing by the records actually returned (never `page * limit`)
      // keeps the walk correct whatever page size the API decides to serve.
      if (records.length === 0) break;
      offset += records.length;
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
