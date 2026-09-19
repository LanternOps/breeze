import { coreRequest } from './api';

import type { OrgContactOption } from '../screens/tickets/createTicketForm';

/** The server clamps `limit` to 100 (see `getPagination`); ask for that. */
const PAGE_LIMIT = 100;

/**
 * #5367: one page of an organization's contacts, for the New ticket requester
 * picker.
 *
 * Mirrors `listOrganizations` in shape, with two differences that matter:
 * the endpoint (`GET /orgs/organizations/:id/contacts`) is org-SCOPED, so the
 * id goes in the path and must be encoded; and it has no server-side search,
 * so this returns the page and the picker filters it client-side. An org with
 * more than 100 contacts therefore shows only the first page — acceptable for
 * v1, and the reason `contactOptions` documents server-side search as the
 * follow-up.
 *
 * The row is narrowed to what the picker needs rather than passed through:
 * `ContactRecord` carries phone/notes/roles that no caller here reads, and a
 * missing field becomes an explicit null so the picker never has to
 * distinguish "absent" from "empty".
 */
export async function listOrgContacts(orgId: string): Promise<OrgContactOption[]> {
  const response = await coreRequest<{
    data?: Array<{ id: string; name?: string | null; email?: string | null; isPrimary?: boolean }>;
  }>(`/orgs/organizations/${encodeURIComponent(orgId)}/contacts?limit=${PAGE_LIMIT}`);
  return (response.data ?? []).map((c) => ({
    id: c.id,
    name: c.name ?? null,
    email: c.email ?? null,
    isPrimary: c.isPrimary === true,
  }));
}
