import type { DnsAction } from '../../db/schema';
import type { DnsEvent, DnsEventSlice, DnsProvider } from './index';
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

/** Page size requested from `/reports/v2/activity`. */
const UMBRELLA_ACTIVITY_PAGE_LIMIT = 1000;

/**
 * Cisco's hard ceiling on `offset`: "invalid offset: should be integer between
 * 0 and 10000 inclusive" (HTTP 400, #7207). A window can therefore only be
 * walked up to ~10k records; larger ones are split by time instead.
 */
const UMBRELLA_ACTIVITY_OFFSET_CAP = 10_000;

/**
 * Narrowest time slice the walk will split down to. A burst of more records
 * than the offset cap can reach inside one second is kept up to the cap and
 * the remainder dropped with a warning, rather than splitting forever.
 */
const UMBRELLA_MIN_SLICE_MS = 1000;

/**
 * Activity requests per sync run (pages plus offset-cap probes). The job
 * checkpoints `lastSync` after every completed slice, so hitting this ends the
 * run early and the next run resumes where it stopped — nothing is skipped.
 * It must leave room for the worst case before a first slice completes:
 * halving 30 days down to one second is 22 splits at ~2 requests each, plus
 * ≤12 requests to page the slice that fits.
 */
const UMBRELLA_MAX_REQUESTS_PER_RUN = 100;

/** Per-run counters shared across the windows of one sliced sync. */
interface ActivityRunState {
  requests: number;
  skippedUnparseable: number;
  skippedNonDns: number;
}

type ActivityWindowResult =
  /** Every reachable record in the window; `truncated` if some were not. */
  | { kind: 'complete'; events: DnsEvent[]; recordCount: number; truncated: boolean }
  /** More records than the offset cap can reach — split the window. */
  | { kind: 'overflow' }
  /** The per-run request budget ran out before the window finished. */
  | { kind: 'budget' };

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
function mapVerdict(verdict: string | undefined): DnsAction | null {
  // An ABSENT verdict is drift, not a default: Cisco lists `verdict` in the
  // required field set for a DNS activity record, so a record without one is
  // not a shape we know how to read. Dropping and counting it beats inventing
  // an `allowed` that nothing in the payload supports.
  if (!verdict) return null;
  if (verdict.includes('block')) return 'blocked';
  if (verdict.includes('proxied') || verdict.includes('redirect')) return 'redirected';
  if (verdict.includes('allow')) return 'allowed';
  // Anything else is unrecognized. Returning 'allowed' here would relabel a
  // possible detection as clean traffic and leave the dashboard looking
  // healthy — strictly worse than dropping the record and counting it.
  return null;
}

/**
 * The outcome of mapping one record. A single bad record must never fail the
 * whole page, but a dropped record is a lost security event, so the caller
 * counts each reason rather than discarding it silently.
 */
type MappedRecord =
  | { kind: 'event'; event: DnsEvent }
  /** Shape drift, or a verdict we refuse to guess at. */
  | { kind: 'unparseable' }
  /** A proxy/firewall/intrusion record from the combined feed. */
  | { kind: 'non-dns' };

/** Map one `data[]` record from the next-gen activity feed onto a `DnsEvent`. */
function mapActivityRecord(entry: unknown): MappedRecord {
  const record = asRecord(entry);
  if (!record) return { kind: 'unparseable' };

  // Defence in depth for the x-traffic-type header: a proxy record carries a
  // domain and a timestamp too, so without this it would be ingested as a DNS
  // event whenever the header is ignored. A record with NO discriminator is
  // still kept — a strict check would blank the entire feed if Cisco ever
  // dropped the field.
  const recordType = asString(record.type)?.toLowerCase();
  if (recordType && recordType !== 'dns') return { kind: 'non-dns' };

  const domain = asString(record.domain) ?? asLabels(record.domains)[0]?.label;
  const timestamp = parseActivityTimestamp(record.timestamp ?? record.datetime);
  if (!domain || !timestamp) return { kind: 'unparseable' };

  const action = mapVerdict(asString(record.verdict)?.toLowerCase());
  if (!action) return { kind: 'unparseable' };

  const categories = asLabels(record.categories);
  const categoryLabels = categories.map((category) => category.label);
  // A DNS-security event is classified by its SECURITY category; the content
  // category ("Business Services") is usually listed first and would
  // otherwise win and normalize to `unknown` downstream.
  const primaryCategory = categories.find((category) => category.type === 'security')?.label
    ?? asLabels(record.policycategories).find((category) => category.type === 'security')?.label
    ?? categoryLabels[0];

  return { kind: 'event', event: {
    timestamp,
    domain,
    queryType: asString(record.querytype) ?? asString(record.query_type) ?? 'A',
    action,
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
  } };
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

  /**
   * Every in-window DNS event, collected from {@link syncEventSlices}. The sync
   * job consumes the slices directly so it can checkpoint between them; this
   * all-at-once form stays for the {@link DnsProvider} contract. Like the
   * slices, it can stop short of `until` at the per-run request budget.
   */
  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const allEvents: DnsEvent[] = [];
    for await (const slice of this.syncEventSlices(since, until)) {
      for (const event of slice.events) allEvents.push(event);
    }
    return allEvents;
  }

  /**
   * Walk the activity feed in time slices small enough to page under Cisco's
   * offset cap (#7207).
   *
   * `/reports/v2/activity` rejects any `offset` above 10000, so a window
   * holding more than ~10k events cannot be walked by offset alone — the old
   * single walk hit a 400 on the page past the cap and failed the whole sync.
   * Instead: try the window; if it holds more than the cap can reach, halve it
   * and retry the earlier half; once a slice fits, yield it and move on to the
   * next stretch (doubling the width again after a light slice, so one burst
   * doesn't pin the rest of the run to tiny windows).
   *
   * Slices come out in chronological order and each is COMPLETE — everything
   * between the previous slice's `until` and its own — which is what lets the
   * job persist each one and advance `lastSync` to it. Adjacent slices share
   * their boundary millisecond (the API window is inclusive at both ends as
   * far as we can tell); the job's deterministic event id dedupes that overlap
   * the same way it dedupes its own one-minute `lastSync` overlap.
   */
  async *syncEventSlices(since: Date, until: Date): AsyncGenerator<DnsEventSlice> {
    // `organizationId` is deliberately NOT read here. The next-gen Reports API
    // takes no org path segment — the OAuth2 token's own `sub` claim
    // (`org/<orgId>/client/<apiKey>`) scopes the request — so requiring it
    // would reject a perfectly valid integration. It stays on the config type
    // for backward compatibility with rows created before this change (#4597).
    const to = until.getTime();
    const from = Math.max(since.getTime(), to - UMBRELLA_MAX_WINDOW_MS);

    if (from > since.getTime()) {
      // The skipped stretch is never revisited — it is not fetchable from
      // this endpoint at all. Say so rather than narrowing the window mutely.
      console.warn(
        `[UmbrellaProvider] requested sync window exceeds Cisco's 30-day maximum; ` +
        `clamped to ${new Date(from).toISOString()}..${new Date(to).toISOString()} — ` +
        'earlier activity cannot be fetched from the reporting API.'
      );
    }

    const run: ActivityRunState = { requests: 0, skippedUnparseable: 0, skippedNonDns: 0 };
    try {
      let cursor = from;
      let width = to - from;
      do {
        const end = Math.min(to, cursor + width);
        const splittable = end - cursor > UMBRELLA_MIN_SLICE_MS;
        const result = await this.fetchActivityWindow(cursor, end, splittable, run);

        if (result.kind === 'budget') {
          // Nothing from the unfinished slice is yielded, so the caller's
          // checkpoint stays at the last complete one and the next run
          // resumes from there — no hole, just a later catch-up.
          console.warn(
            `[UmbrellaProvider] activity sync reached the ${UMBRELLA_MAX_REQUESTS_PER_RUN}-request budget; ` +
            `${new Date(cursor).toISOString()}..${new Date(to).toISOString()} was not fetched this run ` +
            'and is resumed on the next one.'
          );
          return;
        }

        if (result.kind === 'overflow') {
          // Too many events for the offset cap: retry the earlier half.
          width = Math.max(UMBRELLA_MIN_SLICE_MS, Math.floor((end - cursor) / 2));
          continue;
        }

        if (result.truncated) {
          console.warn(
            `[UmbrellaProvider] ${new Date(cursor).toISOString()}..${new Date(end).toISOString()} holds ` +
            `more than ${result.recordCount} activity records in under ${UMBRELLA_MIN_SLICE_MS} ms — ` +
            `too many to split further and page under Cisco's offset cap of ${UMBRELLA_ACTIVITY_OFFSET_CAP}. ` +
            `Kept the ${result.recordCount} reachable records; the rest of that window cannot be fetched ` +
            'and was dropped.'
          );
        }

        yield { events: result.events, until: new Date(end) };

        cursor = end;
        if (result.recordCount < UMBRELLA_ACTIVITY_OFFSET_CAP / 4) width *= 2;
      } while (cursor < to);
    } finally {
      // Every record we fail to map is a lost security event. Counting them by
      // reason keeps an upstream shape change — which would otherwise return
      // [] and be recorded as a healthy "success" sync — visible in the logs.
      if (run.skippedUnparseable > 0) {
        console.warn(
          `[UmbrellaProvider] activity sync skipped ${run.skippedUnparseable} unparseable record(s) ` +
          '(possible API shape drift, or an unrecognized verdict).'
        );
      }
      if (run.skippedNonDns > 0) {
        console.warn(
          `[UmbrellaProvider] activity sync skipped ${run.skippedNonDns} non-DNS record(s); the ` +
          'x-traffic-type: dns header did not scope the combined feed.'
        );
      }
    }
  }

  /**
   * Page one `[from, to]` window by limit/offset, staying inside Cisco's
   * offset cap.
   *
   * A `splittable` window reports `overflow` as soon as it is known to hold
   * more than the cap can reach, so the caller can halve it. That is usually
   * known after two requests: a FULL first page triggers a probe at the cap
   * offset, and a non-empty probe means the walk could never finish. The probe
   * is a shortcut, not the guarantee — a server capping `limit` below ours
   * never looks "full", and events can land mid-walk — so the walk itself also
   * stops before any offset past the cap. A window that cannot be split
   * further keeps what the cap allows and reports itself `truncated`.
   */
  private async fetchActivityWindow(
    from: number,
    to: number,
    splittable: boolean,
    run: ActivityRunState
  ): Promise<ActivityWindowResult> {
    const events: DnsEvent[] = [];
    let skippedUnparseable = 0;
    let skippedNonDns = 0;
    let offset = 0;

    for (;;) {
      if (run.requests >= UMBRELLA_MAX_REQUESTS_PER_RUN) return { kind: 'budget' };
      const records = await this.fetchActivityPage(from, to, offset, UMBRELLA_ACTIVITY_PAGE_LIMIT, run);

      // An EMPTY page is the end of the collection — not a short one. Cisco
      // documents no maximum for `limit`, so a server-side cap below ours
      // would make every page look "short" and silently truncate the sync.
      // Advancing by the records actually returned (never `page * limit`)
      // keeps the walk correct whatever page size the API decides to serve.
      if (records.length === 0) break;

      for (const entry of records) {
        const mapped = mapActivityRecord(entry);
        if (mapped.kind === 'event') events.push(mapped.event);
        else if (mapped.kind === 'non-dns') skippedNonDns++;
        else skippedUnparseable++;
      }

      if (offset === 0 && splittable && records.length >= UMBRELLA_ACTIVITY_PAGE_LIMIT) {
        if (run.requests >= UMBRELLA_MAX_REQUESTS_PER_RUN) return { kind: 'budget' };
        const probe = await this.fetchActivityPage(from, to, UMBRELLA_ACTIVITY_OFFSET_CAP, 1, run);
        if (probe.length > 0) return { kind: 'overflow' };
      }

      const nextOffset = offset + records.length;
      if (nextOffset > UMBRELLA_ACTIVITY_OFFSET_CAP) {
        if (splittable) return { kind: 'overflow' };
        run.skippedUnparseable += skippedUnparseable;
        run.skippedNonDns += skippedNonDns;
        return { kind: 'complete', events, recordCount: nextOffset, truncated: true };
      }
      offset = nextOffset;
    }

    // Skip counts only land for a window that is kept — a discarded overflow
    // window is re-fetched in halves and would otherwise be counted twice.
    run.skippedUnparseable += skippedUnparseable;
    run.skippedNonDns += skippedNonDns;
    return { kind: 'complete', events, recordCount: offset, truncated: false };
  }

  private async fetchActivityPage(
    from: number,
    to: number,
    offset: number,
    limit: number,
    run: ActivityRunState
  ): Promise<unknown[]> {
    run.requests++;
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
    // has-more to read. `offset` must stay within 0..10000 (#7207).
    url.searchParams.set('offset', String(offset));

    const payload = await this.withAuth((authorization) =>
      requestJson<Record<string, unknown>>(url, {
        headers: { Authorization: authorization, ...UMBRELLA_TRAFFIC_TYPE_HEADER }
      })
    );
    return asArray(payload.data);
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
