import { getToken, graphFetch, type DirectInvokeResult } from './m365DirectGraph';
import { captureException } from './sentry';

/** Encode a Graph composite site ID (hostname,scGuid,webGuid) for use in a path segment.
 * encodeURIComponent encodes commas to %2C, but Graph requires literal commas in this position. */
function encodeSiteId(id: string): string {
  return encodeURIComponent(id).replace(/%2C/g, ',');
}

/** Percent-encode a site URL for the TenantAutoMount composite. SharePoint's own
 * "Copy library ID" encodes aggressively (`_` → `%5F`), beyond encodeURIComponent's
 * unreserved set — match it byte-for-byte so our values are indistinguishable from
 * sync-client-produced ones. (Live spike 2026-06-19 doc records what OneDrive accepts.) */
function encodeWebUrl(url: string): string {
  // encodeURIComponent, plus the chars SharePoint's encoder escapes that
  // encodeURIComponent leaves literal (`_` → %5F in the ground-truth sample).
  // Dots/hyphens stay literal — the real-world value keeps them unencoded.
  return encodeURIComponent(url).replace(/[!'()*_]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

const stripBraces = (g: string) => g.replace(/^\{|\}$/g, '');

/** Build the `HKCU\...\TenantAutoMount` registry composite value from Graph-sourced
 * IDs. Pure — no I/O. See docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md
 * for the format's provenance and the construction formula this implements. */
export function buildTenantAutoMountValue(ids: {
  tenantId: string; siteId: string; webId: string; listId: string; siteUrl: string;
}): string {
  return `tenantId=${stripBraces(ids.tenantId)}`
    + `&siteId={${stripBraces(ids.siteId)}}`
    + `&webId={${stripBraces(ids.webId)}}`
    + `&listId={${stripBraces(ids.listId)}}`
    + `&webUrl=${encodeWebUrl(ids.siteUrl)}`
    + `&version=1`;
}

export async function listSharePointLibraries(orgId: string): Promise<DirectInvokeResult> {
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok; // error result

  const token = tok.token;

  const sites = await graphFetch(token, 'GET', `/sites?search=*&$top=100&$select=id,displayName,webUrl`);
  if (sites.kind === 'error') return sites;

  const siteRows = Array.isArray((sites.data as any)?.value) ? (sites.data as any).value : [];
  const libraries: Array<Record<string, string>> = [];
  // Sites we could not enumerate drives for due to an *unexpected* error
  // (throttling, 5xx, …). Returned so the caller can surface "N sites could
  // not be read" rather than presenting a silently-truncated picker as if it
  // were the complete set. A 403 (app simply lacks access to the site) is an
  // expected, stable condition and is skipped quietly, not recorded.
  const skippedSites: Array<{ siteId: string; code: string }> = [];

  for (const site of siteRows) {
    const siteId = typeof site?.id === 'string' ? site.id : null;
    if (!siteId) continue; // malformed site row with no usable id — nothing to fetch

    const drives = await graphFetch(
      token,
      'GET',
      `/sites/${encodeSiteId(siteId)}/drives?$select=id,name&$expand=list($select=id,sharePointIds)`,
    );
    if (drives.kind === 'error') {
      if (drives.code !== 'forbidden') {
        // An unexpected failure that would otherwise silently drop this site's
        // libraries — record it and alert so it's traceable later.
        skippedSites.push({ siteId, code: drives.code });
        captureException(
          new Error(
            `listSharePointLibraries: could not read drives for site ${siteId} (${drives.code}: ${drives.message})`,
          ),
        );
      }
      continue;
    }

    const driveRows = Array.isArray((drives.data as any)?.value) ? (drives.data as any).value : [];
    for (const d of driveRows) {
      const driveId = typeof d?.id === 'string' ? d.id : null;
      if (!driveId) continue; // malformed drive row — skip rather than ship a NULL/garbage library_id downstream

      const sp = (d.list?.sharePointIds ?? {}) as Record<string, unknown>;
      const spStr = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
      const tenantId = spStr('tenantId');
      const spSiteId = spStr('siteId');
      const webId = spStr('webId');
      const spListId = spStr('listId') || (typeof d.list?.id === 'string' ? d.list.id : '');
      const spSiteUrl = spStr('siteUrl') || (typeof site.webUrl === 'string' ? site.webUrl : '');
      const complete = Boolean(tenantId && spSiteId && webId && spListId && spSiteUrl);
      libraries.push({
        siteId,
        siteName: typeof site.displayName === 'string' ? site.displayName : '',
        siteUrl: typeof site.webUrl === 'string' ? site.webUrl : '',
        driveId,
        listId: spListId,
        libraryName: typeof d.name === 'string' ? d.name : '',
        tenantId,
        webId,
        spSiteId,
        autoMountValue: complete
          ? buildTenantAutoMountValue({ tenantId, siteId: spSiteId, webId, listId: spListId, siteUrl: spSiteUrl })
          : '',
      });
    }
  }

  return { kind: 'ok', data: { libraries, skippedSites } };
}

// Pagination bound: 5 pages × $top=200 = 1000 transitive groups. Past that we
// return an error, never a truncated set as 'ok' — a silently missing group id
// here is a mount-entitlement decision, and truncated-as-ok would cache a
// false negative for the full TTL with no log anywhere.
const GROUP_MEMBERSHIP_MAX_PAGES = 5;

export async function resolveUserGroupMembership(
  orgId: string,
  upn: string,
): Promise<DirectInvokeResult<{ groupIds: string[] }>> {
  if (!upn || typeof upn !== 'string') {
    return { kind: 'error', code: 'bad_request', message: 'upn is required.' };
  }
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok;

  // transitiveMemberOf so nested group membership counts; only group objects, ids only.
  // The microsoft.graph.group OData cast is an advanced query: Graph requires
  // ConsistencyLevel: eventual + $count=true (on every page) or it can 400.
  const advancedQuery = { headers: { ConsistencyLevel: 'eventual' } };
  const groupIds: string[] = [];
  let path: string | null =
    `/users/${encodeURIComponent(upn)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=200&$count=true`;
  for (let page = 0; page < GROUP_MEMBERSHIP_MAX_PAGES && path; page++) {
    const res = await graphFetch(tok.token, 'GET', path, undefined, advancedQuery);
    if (res.kind === 'error') return res;
    const data = res.data as { value?: unknown; '@odata.nextLink'?: unknown };
    if (!Array.isArray(data?.value)) {
      // A 2xx with no value array (truncated body, parse failure upstream,
      // shape drift) must NOT read as "member of nothing" — that would cache
      // a false denial for the full TTL. Error → uncached → retried.
      return { kind: 'error', code: 'graph_malformed_response', message: 'Graph membership response has no value array.' };
    }
    for (const g of data.value) {
      const id = (g as { id?: unknown })?.id;
      if (typeof id === 'string') groupIds.push(id);
    }
    path = typeof data?.['@odata.nextLink'] === 'string' ? data['@odata.nextLink'] : null;
  }
  if (path) {
    return {
      kind: 'error',
      code: 'too_many_groups',
      message: `More than ${GROUP_MEMBERSHIP_MAX_PAGES * 200} transitive groups; refusing to return a truncated set.`,
    };
  }
  return { kind: 'ok', data: { groupIds } };
}

// The TTL bounds access-revocation latency: a user removed from an Entra
// group stays tagged (mountable) for up to this TTL + one heartbeat.
export const GROUP_MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000;

// Short TTL for a narrow set of error codes that are deterministic/stable for
// a given org (misconfiguration, not transient upstream trouble). Without
// this, an org with graph_group libraries but no M365 connection pays a
// token round-trip + warn log per reported UPN per device per heartbeat,
// forever. 5 minutes bounds how long a fixed misconfiguration keeps denying
// after an admin repairs it.
export const GROUP_MEMBERSHIP_NEGATIVE_TTL_MS = 5 * 60 * 1000;

// Only codes whose cause cannot resolve itself between heartbeats belong
// here. Everything else (graph_unreachable, auth_failed, graph_unavailable,
// graph_malformed_response, not_found, and any code not in this set) stays
// UNCACHED so the next heartbeat retries — a fail-closed denial must never
// persist longer than necessary for a transient cause.
//
// `not_found` is deliberately excluded even though it can look "stable": a
// just-provisioned user should be able to resolve promptly once Entra catches
// up, rather than being denied for up to 5 more minutes because of a cached
// miss recorded before provisioning finished.
const GROUP_MEMBERSHIP_NEGATIVE_CACHEABLE_CODES = new Set([
  'no_connection',
  'connection_key_error',
  'bad_request',
  'too_many_groups',
]);

// Bound on distinct org:upn keys held in memory for the life of the process.
// Without this the map grows unbounded across every org/user pair ever
// reported by a heartbeat.
export const GROUP_MEMBERSHIP_CACHE_MAX = 10_000;

type CacheEntry = {
  at: number;
  ttlMs: number;
  result: DirectInvokeResult<{ groupIds: string[] }>;
};
const groupMembershipCache = new Map<string, CacheEntry>();

/** Test hook. */
export function clearGroupMembershipCache(): void {
  groupMembershipCache.clear();
}

/** Insert/refresh a cache entry, bounding the map size. Map preserves
 * insertion order, so delete-then-set moves a refreshed key to the back, and
 * evicting past the bound just means deleting the first (oldest) key. */
function setGroupMembershipCacheEntry(key: string, entry: CacheEntry): void {
  groupMembershipCache.delete(key);
  groupMembershipCache.set(key, entry);
  if (groupMembershipCache.size > GROUP_MEMBERSHIP_CACHE_MAX) {
    const oldestKey = groupMembershipCache.keys().next().value;
    if (oldestKey !== undefined) groupMembershipCache.delete(oldestKey);
  }
}

/** TTL-cached transitive group membership. Delivery calls this once per
 * reported UPN per heartbeat; without the cache an uncached miss costs two
 * sequential HTTP round-trips (client-credentials token + Graph) per user per
 * heartbeat (default 60s, configurable 5-3600s) per device. Positive results
 * cache for GROUP_MEMBERSHIP_CACHE_TTL_MS; a narrow set of deterministic
 * error codes cache for the much shorter GROUP_MEMBERSHIP_NEGATIVE_TTL_MS;
 * everything else is never cached (fail closed but retry next heartbeat). */
export async function resolveUserGroupMembershipCached(
  orgId: string,
  upn: string,
): Promise<DirectInvokeResult<{ groupIds: string[] }>> {
  const key = `${orgId}:${upn.toLowerCase()}`;
  const hit = groupMembershipCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.result;
  const result = await resolveUserGroupMembership(orgId, upn);
  if (result.kind === 'ok') {
    setGroupMembershipCacheEntry(key, { at: Date.now(), ttlMs: GROUP_MEMBERSHIP_CACHE_TTL_MS, result });
  } else if (GROUP_MEMBERSHIP_NEGATIVE_CACHEABLE_CODES.has(result.code)) {
    setGroupMembershipCacheEntry(key, { at: Date.now(), ttlMs: GROUP_MEMBERSHIP_NEGATIVE_TTL_MS, result });
  }
  return result;
}
