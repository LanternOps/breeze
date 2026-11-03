// Wisp W08 (web): the Breeze objects linked to a Wisp thread. Server contract:
// W08a `routes/wispThreadLinks.ts` under /api/v1/wisp (fetchWithAuth adds the
// prefix). Types come from @breeze/shared — never re-typed here.
//
// Every read and add is grant-addressed (the thread id), never the org
// switcher's org: `skipOrgIdInjection` on all three calls, like the thread
// page (routeScope: partner-settings).
import type { WispEntityKind, WispThreadLink } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { i18n } from './i18n';

export function isPinnedLink(link: WispThreadLink): boolean {
  return link.source === 'user_pin' || link.source === 'wisp_pin';
}

const linksPath = (threadId: string) => `/wisp/thread/${encodeURIComponent(threadId)}/links`;

/** `GET /wisp/thread/:id/links` → the links the caller can still see (the server re-resolves each). */
export async function listWispLinks(threadId: string): Promise<WispThreadLink[]> {
  const res = await fetchWithAuth(linksPath(threadId), { skipOrgIdInjection: true });
  if (!res.ok) throw new Error(`wisp links list failed: ${res.status}`);
  const body = (await res.json()) as { data?: { links?: unknown } } | null;
  // A malformed body is a contract break, not "no links": surface it.
  if (!Array.isArray(body?.data?.links)) throw new Error('wisp links list: response has no links array');
  return body.data.links as WispThreadLink[];
}

/**
 * `POST /wisp/thread/:id/links { kind, id, orgId? }` → the stored link
 * (idempotent: re-adding returns the existing row). `orgId` is only a lookup
 * hint — the server reads the org from the entity. Refusals (404/403/409
 * `{ code }`) are toasted with the server's message by runAction and thrown as
 * ActionError.
 */
export async function addWispLink(
  threadId: string,
  ref: { kind: WispEntityKind; id: string; orgId?: string | null },
): Promise<WispThreadLink> {
  const body = await runAction<{ data?: { link?: WispThreadLink } } | null>({
    request: () => fetchWithAuth(linksPath(threadId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: ref.kind, id: ref.id, ...(ref.orgId ? { orgId: ref.orgId } : {}) }),
      skipOrgIdInjection: true,
    }),
    errorFallback: i18n.t('ai:wisp.links.addFailed'),
    successMessage: i18n.t('ai:wisp.links.added'),
  });
  const link = body?.data?.link;
  if (!link) throw new Error('wisp link add: response has no link');
  return link;
}

/** `DELETE /wisp/thread/:id/links/:linkId` → 204. */
export async function removeWispLink(threadId: string, linkId: string): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`${linksPath(threadId)}/${encodeURIComponent(linkId)}`, {
      method: 'DELETE',
      skipOrgIdInjection: true,
    }),
    errorFallback: i18n.t('ai:wisp.links.removeFailed'),
    successMessage: i18n.t('ai:wisp.links.removed'),
  });
}

/** Promote an auto row; source and pin-cap enforcement belong to the server. */
export async function pinWispLink(threadId: string, linkId: string): Promise<WispThreadLink> {
  const body = await runAction<{ data?: { link?: WispThreadLink } }>({
    request: () => fetchWithAuth(`${linksPath(threadId)}/${encodeURIComponent(linkId)}/pin`, {
      method: 'POST', skipOrgIdInjection: true,
    }),
    errorFallback: i18n.t('ai:wisp.links.addFailed'),
    successMessage: i18n.t('ai:wisp.links.added'),
  });
  if (!body?.data?.link) throw new Error('wisp link pin: response has no link');
  return body.data.link;
}

/** Read authorized neighbour previews without storing links. */
export async function listWispNeighbours(threadId: string, ref: { kind: WispEntityKind; id: string }): Promise<WispThreadLink[]> {
  const query = new URLSearchParams({ kind: ref.kind, id: ref.id });
  const res = await fetchWithAuth(`${linksPath(threadId)}/neighbours?${query}`, { skipOrgIdInjection: true });
  if (!res.ok) throw new Error(`wisp neighbours list failed: ${res.status}`);
  const body = (await res.json()) as { data?: { links?: unknown } } | null;
  if (!Array.isArray(body?.data?.links)) throw new Error('wisp neighbours list: response has no links array');
  return body.data.links as WispThreadLink[];
}
