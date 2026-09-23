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
 * Whether a failed load is a bug worth reporting. A 401/403 (a role without
 * `billing_profiles:read`, or a session ending) and a transport failure (a
 * technician in a basement) are expected states: the picker stays hidden and
 * the timer still starts. A 5xx or a malformed body is not.
 */
export function shouldReportWorkTypeLoadFailure(error: unknown): boolean {
  if (error instanceof WorkTypeListMalformedError) return true;
  const statusCode =
    typeof error === 'object' && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (typeof statusCode !== 'number') return false;
  return statusCode !== 401 && statusCode !== 403;
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
