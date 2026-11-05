import { fetchWithAuth } from '../../stores/auth';

/**
 * One read of `GET /orgs/partners/me`, shared by everything that asks for it at
 * the same time (#9172). On a partner settings load the page, the layout's and
 * the page's MFA banners, the sidebar and the session manager each needed it;
 * a production build issued five identical GETs.
 *
 * In-flight sharing only: once a read settles the slot clears, so the next
 * caller always gets a fresh answer (no stale cache after a save). Callers get
 * the parsed body, never the `Response`, because a body can be read only once.
 */
export type PartnersMeRead = { ok: boolean; status: number; data: unknown };

let inflight: Promise<PartnersMeRead> | null = null;

export function getPartnersMe(): Promise<PartnersMeRead> {
  if (inflight) return inflight;
  const read = (async (): Promise<PartnersMeRead> => {
    const response = await fetchWithAuth('/orgs/partners/me');
    const data = response.ok ? await response.json().catch(() => null) : null;
    return { ok: response.ok, status: response.status, data };
  })();
  inflight = read;
  const clear = () => { if (inflight === read) inflight = null; };
  read.then(clear, clear);
  return read;
}

/**
 * Drops the shared in-flight read, so the next caller starts its own. Called
 * on a partner switch and after a save, where an older answer must not be reused.
 */
export function invalidatePartnersMe(): void {
  inflight = null;
}
