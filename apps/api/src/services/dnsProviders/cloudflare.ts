import { createHash } from 'node:crypto';
import type { DnsEvent, DnsProvider } from './index';
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

// resolverDecision enum, from the dataset schema: 0 unknown, 1 allowedByQueryName,
// 2 blockedByQueryName, 3 blockedByCategory, 4 allowedOnNoLocation,
// 5 allowedOnNoPolicyMatch, 6 blockedAlwaysCategory, 7 overrideForSafeSearch,
// 8 overrideApplied, 9 blockedRule, 10 allowedRule.
const SLICE_MS = 60 * 60 * 1000;
const BLOCKED_DECISIONS = new Set([2, 3, 6, 9]);
const REDIRECTED_DECISIONS = new Set([7, 8]);

export function cloudflareDecisionToAction(decision: number | undefined): DnsEvent['action'] {
  if (decision !== undefined && BLOCKED_DECISIONS.has(decision)) return 'blocked';
  if (decision !== undefined && REDIRECTED_DECISIONS.has(decision)) return 'redirected';
  return 'allowed';
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
      throw new Error(`Cloudflare GraphQL error: ${errors.join('; ')}`);
    }
    return response.data;
  }

  async syncEvents(since: Date, until: Date): Promise<DnsEvent[]> {
    const events: DnsEvent[] = [];
    const seen = new Set<string>();
    // Query in short slices. Observed against the live API (2026-09-30): on a
    // low-volume account a window longer than ~90 minutes returns zero groups
    // with no error, even though the dataset reports a 31-day maxDuration
    // (adaptive sampling drops small counts on wide windows). One-hour slices
    // return every group.
    for (let sliceStart = since.getTime(); sliceStart < until.getTime(); sliceStart += SLICE_MS) {
      const sliceEnd = Math.min(sliceStart + SLICE_MS, until.getTime());
      await this.syncSlice(new Date(sliceStart), new Date(sliceEnd), events, seen);
    }
    return events;
  }

  private async syncSlice(since: Date, until: Date, events: DnsEvent[], seen: Set<string>): Promise<void> {
    const accountTag = this.requireAccountId();
    const limit = 1000;
    const maxPages = 50;
    let windowStart = since;

    for (let page = 0; page < maxPages; page++) {
      const data = await this.graphql(DNS_QUERIES_GQL, {
        accountTag,
        since: windowStart.toISOString(),
        until: until.toISOString(),
        limit
      });

      const viewer = asRecord(asRecord(data)?.viewer);
      const account = asRecord(asArray(viewer?.accounts)[0]);
      const groups = asArray(account?.gatewayResolverQueriesAdaptiveGroups);

      let lastTimestamp: Date | undefined;
      for (const entry of groups) {
        const group = asRecord(entry);
        const dims = asRecord(group?.dimensions);
        if (!dims) continue;

        const timestampRaw = asString(dims.datetime);
        const domain = asString(dims.queryName);
        if (!timestampRaw || !domain) continue;
        const timestamp = new Date(timestampRaw);
        if (Number.isNaN(timestamp.getTime())) continue;
        lastTimestamp = timestamp;

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

      // A full page means there may be more in the window: continue from the last
      // timestamp (datetime_geq, so equal timestamps are re-read and deduped above).
      if (groups.length < limit || !lastTimestamp || lastTimestamp.getTime() <= windowStart.getTime()) {
        break;
      }
      windowStart = lastTimestamp;
    }
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
