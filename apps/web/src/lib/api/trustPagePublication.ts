// Amendment 23: whether an org's trust page is live, for the org form's slug-rename warning.
// Read-only (`GET /orgs/:orgId/trust-page/publication` never creates the draft page). Same idiom as
// trustPage.ts: the fetcher is a parameter and the `{ data }` envelope is unwrapped.
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustPagePublication {
  published: boolean;
  /** `/portal/trust/<partner>/<org>` (or the partner path for the partner home) while published. */
  publicPath: string | null;
}

export async function fetchTrustPagePublication(f: Fetcher, orgId: string): Promise<TrustPagePublication> {
  return unwrapData<TrustPagePublication>(await f(`/orgs/${orgId}/trust-page/publication`));
}
