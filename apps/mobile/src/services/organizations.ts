import { coreRequest } from './api';

export interface OrganizationSummary {
  id: string;
  name: string;
}

/** The server clamps `limit` to 100 (see `getPagination`); ask for that. */
const PAGE_LIMIT = 100;

/**
 * One page of the organisations the caller can see, for pickers. A partner
 * with more than 100 customers narrows with `search` (server-side, so the
 * cap is on the result, not the universe). `total` says whether that was
 * needed.
 */
export async function listOrganizations(
  search?: string
): Promise<{ orgs: OrganizationSummary[]; total: number }> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  const trimmed = search?.trim();
  if (trimmed) params.set('search', trimmed);
  const response = await coreRequest<{
    data?: Array<{ id: string; name: string }>;
    pagination?: { total?: number };
  }>(`/orgs/organizations?${params.toString()}`);
  const orgs = (response.data ?? []).map((o) => ({ id: o.id, name: o.name }));
  return { orgs, total: response.pagination?.total ?? orgs.length };
}
