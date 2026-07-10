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

export async function resolveUserGroupMembership(orgId: string, upn: string): Promise<DirectInvokeResult> {
  if (!upn || typeof upn !== 'string') {
    return { kind: 'error', code: 'bad_request', message: 'upn is required.' };
  }
  const tok = await getToken(orgId);
  if ('kind' in tok) return tok;

  // transitiveMemberOf so nested group membership counts; only group objects, ids only.
  const res = await graphFetch(
    tok.token, 'GET',
    `/users/${encodeURIComponent(upn)}/transitiveMemberOf/microsoft.graph.group?$select=id&$top=200`,
  );
  if (res.kind === 'error') return res;

  const rows = Array.isArray((res.data as any)?.value) ? (res.data as any).value : [];
  const groupIds = rows.map((g: any) => g.id).filter((id: unknown): id is string => typeof id === 'string');
  return { kind: 'ok', data: { groupIds } };
}

export const GROUP_MEMBERSHIP_CACHE_TTL_MS = 30 * 60 * 1000;

type CacheEntry = { at: number; result: DirectInvokeResult };
const groupMembershipCache = new Map<string, CacheEntry>();

export function clearGroupMembershipCache(): void {
  groupMembershipCache.clear();
}

/** TTL-cached transitive group membership. Delivery calls this once per
 * reported UPN per heartbeat; without the cache that is a Graph round-trip
 * per user per minute per device. Errors are never cached (fail closed but
 * retry next heartbeat). */
export async function resolveUserGroupMembershipCached(orgId: string, upn: string): Promise<DirectInvokeResult> {
  const key = `${orgId}:${upn.toLowerCase()}`;
  const hit = groupMembershipCache.get(key);
  if (hit && Date.now() - hit.at < GROUP_MEMBERSHIP_CACHE_TTL_MS) return hit.result;
  const result = await resolveUserGroupMembership(orgId, upn);
  if (result.kind === 'ok') groupMembershipCache.set(key, { at: Date.now(), result });
  return result;
}
