// Amendment 24 (§11): the dashboard's "Public trust page" link.
import { apiGet, type ApiRequestConfig } from './api';

export interface TrustPageLinkResponse {
  /** Portal-relative (`/trust/<partner>/<org>`); pass through `withBase`. Null unless the page is live. */
  data: { publicPath: string | null };
}

/**
 * The org's public trust page path, or null. Decoration on the dashboard: any failure (network, gate,
 * auth) yields null so the dashboard itself never fails because of it.
 */
export async function fetchTrustPageLink(config: ApiRequestConfig = {}): Promise<string | null> {
  const res = await apiGet<TrustPageLinkResponse>('/portal/dashboard/trust-page', config);
  return res.data?.data?.publicPath ?? null;
}
