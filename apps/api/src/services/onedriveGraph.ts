import { getToken, graphFetch, type DirectInvokeResult } from './m365DirectGraph';

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

  for (const site of siteRows) {
    const drives = await graphFetch(
      token,
      'GET',
      `/sites/${encodeSiteId(site.id)}/drives?$select=id,name,list`,
    );
    if (drives.kind === 'error') continue; // skip a site we can't read; don't fail the whole list
    const driveRows = Array.isArray((drives.data as any)?.value) ? (drives.data as any).value : [];
    for (const d of driveRows) {
      libraries.push({
        siteId: site.id,
        siteName: site.displayName ?? '',
        siteUrl: site.webUrl ?? '',
        driveId: d.id,
        listId: d.list?.id ?? '',
        libraryName: d.name ?? '',
      });
    }
  }

  return { kind: 'ok', data: { libraries } };
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
