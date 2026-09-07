import { coreRequest } from './api';
import { reportInternalError } from '../lib/errorReporting';

/**
 * A `GET /users` row, trimmed to what the assignee picker needs. Kept local
 * to this service rather than imported from `screens/tickets/createTicketForm`
 * — services here (see `organizations.ts`'s `OrganizationSummary` vs.
 * `createTicketForm.ts`'s `OrgOption`) define their own row shape and stay
 * screen-agnostic; the two line up structurally.
 */
export interface AssignableUserRow {
  id: string;
  name: string | null;
  email: string;
}

/**
 * Staff assignable to a ticket. Mirrors the fetch in web's
 * `TicketWorkbench.tsx` (~line 436): the response body may be a bare array or
 * `{ data: [...] }` depending on route version, and rows without an `id` are
 * dropped defensively.
 *
 * Callers must degrade gracefully on failure (403 for a tech without
 * `users:read`, network error, older server) rather than surface an error —
 * see `assigneeOptions` in `createTicketForm.ts`, which already produces a
 * usable "Unassigned" + "(you)" picker from an empty list. A 200 response
 * that fails to parse into a usable array (unexpected shape) looks the same
 * to the caller, but IS reported here — unlike an auth/network failure, that
 * case is a real contract break and should not vanish without a trace.
 */
export async function listAssignableUsers(): Promise<AssignableUserRow[]> {
  const response = await coreRequest<unknown>('/users');
  const rows = Array.isArray(response)
    ? response
    : (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) {
    reportInternalError(
      new Error(`listAssignableUsers: unexpected /users response shape (${typeof response})`),
      'listAssignableUsers.parse'
    );
    return [];
  }
  return (rows as Array<{ id?: string; name?: string | null; email?: string }>)
    .filter((u): u is { id: string; name?: string | null; email?: string } => Boolean(u && u.id))
    .map((u) => ({ id: u.id, name: u.name ?? null, email: u.email ?? '' }));
}
