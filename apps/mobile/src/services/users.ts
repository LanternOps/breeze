import { coreRequest } from './api';
import type { AssigneeUser } from '../screens/tickets/createTicketForm';

/**
 * Staff assignable to a ticket. Mirrors the fetch in web's
 * `TicketWorkbench.tsx` (~line 436): the response body may be a bare array or
 * `{ data: [...] }` depending on route version, and rows without an `id` are
 * dropped defensively.
 *
 * Callers must degrade gracefully on failure (403 for a tech without
 * `users:read`, network error, older server) rather than surface an error —
 * see `assigneeOptions` in `createTicketForm.ts`, which already produces a
 * usable "Unassigned" + "(you)" picker from an empty list.
 */
export async function listAssignableUsers(): Promise<AssigneeUser[]> {
  const response = await coreRequest<unknown>('/users');
  const rows = Array.isArray(response)
    ? response
    : (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return (rows as Array<{ id?: string; name?: string | null; email?: string }>)
    .filter((u): u is { id: string; name?: string | null; email?: string } => Boolean(u && u.id))
    .map((u) => ({ id: u.id, name: u.name ?? null, email: u.email ?? '' }));
}
