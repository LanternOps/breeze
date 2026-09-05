// Typed fetch wrapper(s) for the Scripts API.
//
// Mirrors the quotes/invoice web layer: there is no generic `apiFetch`/
// `apiClient` helper in this app — mutation calls go through `fetchWithAuth`
// (apps/web/src/stores/auth.ts), which auto-injects the active orgId + auth
// header, refreshes tokens, prepends the `/api/v1` prefix, and returns a raw
// `Response`. The CALLING COMPONENT wraps the request in `runAction`
// (apps/web/src/lib/runAction.ts) — the same pattern `cloneQuote` uses in
// `lib/api/quotes.ts`.
//
// `POST /scripts/:id/clone` returns the cloned script row directly (not a
// `{ data: ... }` envelope) — matching every other scripts.ts route.

import { fetchWithAuth } from '../../stores/auth';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Duplicate a script (#4887). `body` is optional — omit it for a plain
 *  same-scope copy named "<name> (copy)"; pass `name` to override the name
 *  and/or `orgId` for a cross-org copy within the caller's partner scope
 *  (mirrors `cloneQuoteSchema` on the API side). */
export function cloneScript(id: string, body?: { name?: string; orgId?: string }): Promise<Response> {
  return fetchWithAuth(`/scripts/${id}/clone`, {
    method: 'POST',
    ...(body ? { headers: JSON_HEADERS, body: JSON.stringify(body) } : {}),
  });
}
