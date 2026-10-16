import { createHash } from 'node:crypto';
import type { DnsEvent, DnsEventSlice, DnsProvider } from './index';
import { requestJson } from './http';
import { asArray, asNumber, asRecord, asString, asStringArray } from './helpers';

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

interface CloudflareGraphqlResponse {
  data?: unknown;
  errors?: Array<{ message?: string }> | null;
}

const API_BASE = 'https://api.cloudflare.com/client/v4';

// Gateway DNS data has no REST logs endpoint (`/gateway/logs` does not exist and
// returns 404). It lives in the GraphQL Analytics API as an adaptively sampled
// grouped dataset, which is available on every Zero Trust plan. Per-query
// activity logs with device attribution are Enterprise-only (Logpush
// `gateway_dns`), so `sourceIp` stays empty here. Needs Account Analytics: Read.
const DNS_QUERIES_GQL = `query BreezeGatewayDns($accountTag: string!, $since: Time!, $until: Time!, $limit: uint64!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      gatewayResolverQueriesAdaptiveGroups(
        limit: $limit
        filter: { datetime_geq: $since, datetime_leq: $until }
        orderBy: [datetime_ASC]
      ) {
        count
        dimensions {
          datetime
          queryName
          resolverDecision
          categoryNames
          locationName
          policyName
          resourceRecordTypes
        }
      }
    }
  }
}`;

// How far back this account may query the dataset (`notOlderThan`, seconds).
// It depends on the Zero Trust plan, so it is read rather than assumed.
const DNS_SETTINGS_GQL = `query BreezeGatewayDnsSettings($accountTag: string!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      settings {
        gatewayResolverQueriesAdaptiveGroups {
          notOlderThan
        }
      }
    }
  }
}`;

// Observed against the live API (2026-09-30): on a low-volume account a window
// longer than ~90 minutes returns zero groups with no error, even though the
// dataset reports a 31-day maxDuration (adaptive sampling drops small counts on
// wide windows). One-hour slices return every group.
const SLICE_MS = 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
// Analytics land a little after the query happens. Stopping short of now keeps
// the newest slice from being checkpointed with a partial `count`, which the
// providerEventId dedupe would otherwise keep for good.
const INGEST_LAG_MS = 5 * 60 * 1000;
// Used when the settings lookup fails: the shortest (Free plan) retention.
const FALLBACK_RETENTION_MS = 24 * 60 * 60 * 1000;
// Keep the clamped start clear of the retention edge while the request is in flight.
const RETENTION_MARGIN_MS = 5 * 60 * 1000;
// One request per hour slice: a day of catch-up is 24 requests. Past the budget
// the run stops at its last checkpoint and the next run resumes from there.
const MAX_REQUESTS_PER_RUN = 100;

// resolverDecision enum, from the dataset schema: 0 unknown, 1 allowedByQueryName,
// 2 blockedByQueryName, 3 blockedByCategory, 4 allowedOnNoLocation,
// 5 allowedOnNoPolicyMatch, 6 blockedAlwaysCategory, 7 overrideForSafeSearch,
// 8 overrideApplied, 9 blockedRule, 10 allowedRule.
const BLOCKED_DECISIONS = new Set([2, 3, 6, 9]);
const REDIRECTED_DECISIONS = new Set([7, 8]);

export function cloudflareDecisionToAction(decision: number | undefined): DnsEvent['action'] {
  if (decision !== undefined && BLOCKED_DECISIONS.has(decision)) return 'blocked';
  if (decision !== undefined && REDIRECTED_DECISIONS.has(decision)) return 'redirected';
  return 'allowed';
}

/** Cloudflare answered, with GraphQL `errors` (as opposed to a transport failure). */
class CloudflareGraphqlError extends Error {}

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
      `${API_BASE}/accounts/${accountId}${path}`,
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

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const response = await requestJson<CloudflareGraphqlResponse>(`${API_BASE}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query, variables })
    });

    const errors = (response.errors ?? []).map((item) => item.message).filter(Boolean);
    if (errors.length > 0) {
      throw new CloudflareGraphqlError(`Cloudflare GraphQL error: ${errors.join('; ')}`);
    }
    return response.data;
  }

  /**
   * Every in-window DNS event, collected from {@link syncEventSlices}. The sync
   * job consumes the slices directly so it can checkpoint between them; this
   * all-at-once form stays for the {@link DnsProvider} contract. Like the
   * slices, it can stop short of `until`.
   */
  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const events: DnsEvent[] = [];
    for await (const slice of this.syncEventSlices(since, until)) {
      for (const event of slice.events) events.push(event);
    }
    return events;
  }

  /**
   * Walk the dataset in one-hour slices, oldest first, each yielded once it is
   * complete so the sync job can persist it and checkpoint its `until`.
   *
   * The walk starts no earlier than the dataset's retention edge (an older
   * `since` is clamped, with a warning naming the gap that cannot be fetched),
   * ends {@link INGEST_LAG_MS} short of now, and stops at a per-run request
   * budget. A full page is checkpointed at its last timestamp and the walk
   * re-reads from there (`datetime_geq`; the boundary rows dedupe on
   * providerEventId). A full page that cannot advance — {@link PAGE_LIMIT} or
   * more groups at one timestamp — fails the sync rather than dropping rows.
   */
  async *syncEventSlices(since: Date, until: Date): AsyncGenerator<DnsEventSlice> {
    const accountTag = this.requireAccountId();
    const now = Date.now();
    const end = Math.min(until.getTime(), now - INGEST_LAG_MS);

    const horizon = now - (await this.retentionMs(accountTag)) + RETENTION_MARGIN_MS;
    let cursor = since.getTime();
    if (horizon > cursor) {
      console.warn(
        `[CloudflareGatewayProvider] sync window starts before the Gateway analytics retention edge; ` +
        `${since.toISOString()}..${new Date(horizon).toISOString()} is no longer held by Cloudflare and cannot be fetched. ` +
        `Syncing from ${new Date(horizon).toISOString()}.`
      );
      cursor = horizon;
    }

    const seen = new Set<string>();
    let requests = 0;
    while (cursor < end) {
      if (requests >= MAX_REQUESTS_PER_RUN) {
        console.warn(
          `[CloudflareGatewayProvider] event sync reached the ${MAX_REQUESTS_PER_RUN}-request budget; ` +
          `${new Date(cursor).toISOString()}..${new Date(end).toISOString()} is resumed on the next run.`
        );
        return;
      }
      const sliceEnd = Math.min(cursor + SLICE_MS, end);
      const page = await this.fetchPage(accountTag, new Date(cursor), new Date(sliceEnd), seen);
      requests++;

      if (page.rowCount < PAGE_LIMIT) {
        yield { events: page.events, until: new Date(sliceEnd) };
        cursor = sliceEnd;
        continue;
      }

      // Full page: more groups may follow in this slice. Everything before the
      // last timestamp is complete, so checkpoint there and re-read from it.
      if (!page.lastTimestamp || page.lastTimestamp <= cursor) {
        throw new Error(
          `Cloudflare Gateway returned ${PAGE_LIMIT} or more groups at ${new Date(cursor).toISOString()}; ` +
          'the analytics API cannot page past a single timestamp, so the sync stops here rather than drop rows.'
        );
      }
      yield { events: page.events, until: new Date(page.lastTimestamp) };
      cursor = page.lastTimestamp;
    }
  }

  /**
   * The dataset's query horizon for this account. When Cloudflare ANSWERS but
   * the answer carries no usable horizon (a GraphQL-level error, or no
   * `notOlderThan`), assume the Free-plan minimum. A transport failure (timeout,
   * 5xx) is rethrown instead: clamping on a blip would checkpoint past a
   * backlog the account still holds, and the next run would never fetch it.
   */
  private async retentionMs(accountTag: string): Promise<number> {
    let data: unknown;
    try {
      data = await this.graphql(DNS_SETTINGS_GQL, { accountTag });
    } catch (error) {
      if (!(error instanceof CloudflareGraphqlError)) throw error;
      console.warn(`[CloudflareGatewayProvider] could not read dataset retention (${error.message}); assuming 24h retention.`);
      return FALLBACK_RETENTION_MS;
    }
    const account = asRecord(asArray(asRecord(asRecord(data)?.viewer)?.accounts)[0]);
    const dataset = asRecord(asRecord(account?.settings)?.gatewayResolverQueriesAdaptiveGroups);
    const seconds = asNumber(dataset?.notOlderThan);
    if (seconds !== undefined && seconds > 0) return seconds * 1000;
    console.warn('[CloudflareGatewayProvider] dataset settings carried no notOlderThan; assuming 24h retention.');
    return FALLBACK_RETENTION_MS;
  }

  private async fetchPage(
    accountTag: string,
    since: Date,
    until: Date,
    seen: Set<string>
  ): Promise<{ events: DnsEvent[]; rowCount: number; lastTimestamp?: number }> {
    const data = await this.graphql(DNS_QUERIES_GQL, {
      accountTag,
      since: since.toISOString(),
      until: until.toISOString(),
      limit: PAGE_LIMIT
    });

    const accounts = asArray(asRecord(asRecord(data)?.viewer)?.accounts);
    if (accounts.length === 0) {
      throw new Error(
        `Cloudflare account ${accountTag} not found, or the API token lacks Account Analytics: Read`
      );
    }
    const groups = asArray(asRecord(accounts[0])?.gatewayResolverQueriesAdaptiveGroups);

    const events: DnsEvent[] = [];
    let lastTimestamp: number | undefined;
    for (const entry of groups) {
      const group = asRecord(entry);
      const dims = asRecord(group?.dimensions);
      if (!dims) continue;

      const timestampRaw = asString(dims.datetime);
      if (!timestampRaw) continue;
      const timestamp = new Date(timestampRaw);
      if (Number.isNaN(timestamp.getTime())) continue;
      // Rows are ordered by datetime; track the last one even when it is skipped
      // below, since it bounds what this page covered.
      lastTimestamp = timestamp.getTime();

      const domain = asString(dims.queryName);
      if (!domain) continue;

      // The dataset is grouped, so there is no per-event id: derive a stable one
      // from the dimensions so re-syncing an overlapping window does not duplicate.
      const providerEventId = createHash('sha256')
        .update(JSON.stringify(dims))
        .digest('hex')
        .slice(0, 32);
      if (seen.has(providerEventId)) continue;
      seen.add(providerEventId);

      const decision = asNumber(dims.resolverDecision);
      const categories = asStringArray(dims.categoryNames);
      const recordTypes = asStringArray(dims.resourceRecordTypes);

      events.push({
        timestamp,
        domain,
        queryType: recordTypes[0] ?? 'A',
        action: cloudflareDecisionToAction(decision),
        category: categories[0],
        sourceHostname: asString(dims.locationName),
        providerEventId,
        metadata: {
          count: asNumber(group?.count) ?? 1,
          resolverDecision: decision,
          categoryNames: categories,
          policyName: asString(dims.policyName),
          locationName: asString(dims.locationName)
        }
      });
    }

    return { events, rowCount: groups.length, lastTimestamp };
  }

  private requireListId(type: 'block' | 'allow'): string {
    const listId = type === 'block' ? this.config.blocklistId : this.config.allowlistId;
    if (!listId) {
      throw new Error(`Cloudflare ${type}list sync requires ${type}listId in integration config`);
    }
    return listId;
  }

  // Zero Trust list items are edited with a single PATCH on the list
  // (`append` / `remove`). There is no `/items` sub-resource for POST or DELETE
  // (both return 405).
  private async patchList(listId: string, body: { append?: Array<{ value: string; description?: string }>; remove?: string[] }): Promise<void> {
    await this.call<unknown>(`/gateway/lists/${listId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async addBlocklistDomain(domain: string, reason?: string): Promise<void> {
    await this.patchList(this.requireListId('block'), {
      append: [reason ? { value: domain, description: reason } : { value: domain }]
    });
  }

  async removeBlocklistDomain(domain: string): Promise<void> {
    await this.patchList(this.requireListId('block'), { remove: [domain] });
  }

  async addAllowlistDomain(domain: string): Promise<void> {
    await this.patchList(this.requireListId('allow'), { append: [{ value: domain }] });
  }

  async removeAllowlistDomain(domain: string): Promise<void> {
    await this.patchList(this.requireListId('allow'), { remove: [domain] });
  }
}
