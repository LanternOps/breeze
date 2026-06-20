import { getToken, graphFetch, type DirectInvokeResult } from './m365DirectGraph';
import { captureException } from './sentry';

/** Encode a Graph composite site ID (hostname,scGuid,webGuid) for use in a path segment.
 * encodeURIComponent encodes commas to %2C, but Graph requires literal commas in this position. */
function encodeSiteId(id: string): string {
  return encodeURIComponent(id).replace(/%2C/g, ',');
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
      `/sites/${encodeSiteId(siteId)}/drives?$select=id,name,list`,
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
      libraries.push({
        siteId,
        siteName: typeof site.displayName === 'string' ? site.displayName : '',
        siteUrl: typeof site.webUrl === 'string' ? site.webUrl : '',
        driveId,
        listId: typeof d.list?.id === 'string' ? d.list.id : '',
        libraryName: typeof d.name === 'string' ? d.name : '',
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
