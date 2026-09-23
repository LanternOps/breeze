import { coreRequest } from './api';

/**
 * Work types for the phone's picker (#4628 §7 — mobile gets a picker in the
 * last wave; until then every mobile entry fell to the ticket category's
 * server-side default work type or the card's "All other work" row).
 *
 * `/api/v1/mobile/*` has no billing routes, so this calls the same core
 * endpoint the web picker uses (`GET /billing-profiles/work-types`, which needs
 * `billing_profiles:read` — seeded on the technician role) with the token the
 * app already holds, like `services/timeEntries.ts`.
 *
 * Rates are NEVER computed on the phone. This returns labels only; the server
 * resolves the card row and stamps the money (§3.3, §3.4).
 */
export interface WorkType {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
}

const TTL_MS = 5 * 60_000;
let cache: { at: number; value: WorkType[] } | null = null;

/** Dropped on every session end (services/auth.ts clearAuthData): work types are partner-owned. */
export function clearWorkTypeCache(): void {
  cache = null;
}

/** The server answered, but not with `{ workTypes: WorkType[] }` — contract drift. */
export class WorkTypeListMalformedError extends Error {
  constructor() {
    super('Work type list response was malformed');
    this.name = 'WorkTypeListMalformedError';
  }
}

/**
 * Whether a failed load is a bug worth reporting. Expected states, where the
 * picker just stays hidden and the timer still starts:
 *   - 401/403 — a role without `billing_profiles:read`, or a session ending;
 *   - `session_superseded` — the account changed under the request;
 *   - a transport failure — RN fetch rejects with a `TypeError`, a timeout
 *     with `FetchTimeoutError` (a technician in a basement).
 * Everything else is reported — a 5xx, a malformed body, and any error shape
 * nobody anticipated (e.g. the bare `SyntaxError` coreRequest's `JSON.parse`
 * throws on a truncated 200). Unknown is reported, never swallowed.
 */
export function shouldReportWorkTypeLoadFailure(error: unknown): boolean {
  if (error instanceof WorkTypeListMalformedError) return true;
  if (error instanceof TypeError) return false;
  if (typeof error !== 'object' || error === null) return true;
  const e = error as { statusCode?: unknown; code?: unknown; name?: unknown };
  if (e.name === 'FetchTimeoutError') return false;
  if (e.code === 'session_superseded') return false;
  if (e.statusCode === 401 || e.statusCode === 403) return false;
  return true;
}

function isWorkType(value: unknown): value is WorkType {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Partial<WorkType>;
  return (
    typeof w.id === 'string' &&
    typeof w.name === 'string' &&
    typeof w.isActive === 'boolean' &&
    typeof w.sortOrder === 'number'
  );
}

/**
 * Active work types, sorted by `sortOrder` then `name`. Rejects on a transport
 * error or a malformed payload; failures are not cached, so the next mount
 * retries. The caller decides what a failure means — the ticket screen hides
 * the picker and still lets the technician start a timer.
 */
export async function fetchWorkTypes(): Promise<WorkType[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const res = await coreRequest<{ workTypes?: unknown }>('/billing-profiles/work-types');
  const raw = res.workTypes ?? [];
  if (!Array.isArray(raw) || !raw.every(isWorkType)) {
    throw new WorkTypeListMalformedError();
  }
  const value = raw
    .filter((w) => w.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  cache = { at: Date.now(), value };
  return value;
}
