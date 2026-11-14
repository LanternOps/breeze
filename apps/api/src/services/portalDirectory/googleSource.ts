/**
 * Portal directory deprovisioning (W8, D11): the Google Workspace users source.
 *
 * `listGoogleDirectoryUsers` reads the customer's whole user directory through a
 * read-only reader and answers `complete` only when every completeness rule in
 * D11 holds; anything else is `incomplete` with a reason and acts on nobody.
 * It never logs: no subject, email, id, customer id or key material leaves this
 * module except through the returned value.
 */

export const GOOGLE_USERS_PAGE_TIMEOUT_MS = 10_000;
export const GOOGLE_USERS_PASS_DEADLINE_MS = 600_000;
export const GOOGLE_USERS_MAX_PAGES = 400;

const ANCHOR_FIELDS = 'id,customerId,isAdmin,suspended';

/** Read-only Directory users API. `getDirectoryUsersReader` is the only producer. */
export interface DirectoryUsersReader {
  getUser(
    userKey: string,
    fields: string,
    signal: AbortSignal,
  ): Promise<{ id?: unknown; customerId?: unknown; isAdmin?: unknown; suspended?: unknown }>;
  listUsersPage(
    pageToken: string | undefined,
    signal: AbortSignal,
  ): Promise<{ users?: unknown[]; nextPageToken?: unknown }>;
}

export type GoogleIncompleteReason =
  | 'scope_missing'
  | 'access_denied'
  | 'unavailable'
  | 'connection_invalid'
  | 'admin_not_admin'
  | 'mixed_customer'
  | 'malformed';

export type GoogleListing =
  | { kind: 'complete'; customerId: string; users: Map<string, { suspended: boolean; archived: boolean }> }
  | { kind: 'incomplete'; reason: GoogleIncompleteReason };

interface ErrorShape {
  code?: number | string;
  status?: number;
  message?: string;
  response?: { status?: number; data?: { error?: unknown } };
}

/** Same mapping as W5's checkers/googleDirectory.ts, onto this module's reasons. */
function mapError(err: unknown): GoogleIncompleteReason {
  const e = (err ?? {}) as ErrorShape;
  if (e.code === 'invalid_service_account') return 'connection_invalid';
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.includes('unauthorized_client') || e.response?.data?.error === 'unauthorized_client') {
    return 'scope_missing';
  }
  const status = typeof e.code === 'number' ? e.code : (e.status ?? e.response?.status);
  if (status === 401 || status === 403) return 'access_denied';
  return 'unavailable';
}

class Incomplete extends Error {
  constructor(readonly reason: GoogleIncompleteReason) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** Runs `fn` with an AbortSignal that fires after `ms`; the timer is always cleared. */
async function withAbortTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function listGoogleDirectoryUsers(
  reader: DirectoryUsersReader,
  adminEmail: string,
  deps: { now?: () => number } = {},
): Promise<GoogleListing> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const remaining = () => GOOGLE_USERS_PASS_DEADLINE_MS - (now() - startedAt);
  const pageBudget = () => {
    const left = remaining();
    if (left <= 0) throw new Incomplete('unavailable');
    return Math.min(GOOGLE_USERS_PAGE_TIMEOUT_MS, left);
  };

  try {
    // The admin anchor: the authenticated customer's reference point.
    const anchor = await withAbortTimeout(pageBudget(), (signal) => reader.getUser(adminEmail, ANCHOR_FIELDS, signal));
    if (!isRecord(anchor) || anchor.isAdmin !== true || anchor.suspended === true) {
      throw new Incomplete('admin_not_admin');
    }
    if (!nonEmptyString(anchor.id) || !nonEmptyString(anchor.customerId)) throw new Incomplete('malformed');
    const adminId = anchor.id;
    const customerId = anchor.customerId;

    const users = new Map<string, { suspended: boolean; archived: boolean }>();
    const seenTokens = new Set<string>();
    let token: string | undefined;
    for (let pages = 0; pages < GOOGLE_USERS_MAX_PAGES; pages += 1) {
      const page = await withAbortTimeout(pageBudget(), (signal) => reader.listUsersPage(token, signal));
      if (remaining() <= 0) throw new Incomplete('unavailable');
      if (!isRecord(page)) throw new Incomplete('malformed');
      if (page.users !== undefined && !Array.isArray(page.users)) throw new Incomplete('malformed');

      for (const raw of page.users ?? []) {
        if (!isRecord(raw) || !nonEmptyString(raw.id) || users.has(raw.id)) throw new Incomplete('malformed');
        if (raw.suspended !== undefined && typeof raw.suspended !== 'boolean') throw new Incomplete('malformed');
        if (raw.archived !== undefined && typeof raw.archived !== 'boolean') throw new Incomplete('malformed');
        if (raw.customerId !== customerId) throw new Incomplete('mixed_customer');
        users.set(raw.id, { suspended: raw.suspended === true, archived: raw.archived === true });
      }

      const next = page.nextPageToken;
      if (next === undefined || next === null || next === '') {
        // The last page. The admin must be in the listing, or the listing is not the whole customer.
        if (!users.has(adminId)) throw new Incomplete('mixed_customer');
        return { kind: 'complete', customerId, users };
      }
      if (typeof next !== 'string') throw new Incomplete('malformed');
      if (seenTokens.has(next)) throw new Incomplete('unavailable'); // token loop
      seenTokens.add(next);
      token = next;
    }
    throw new Incomplete('unavailable'); // page cap reached with more pages to read
  } catch (err) {
    return { kind: 'incomplete', reason: err instanceof Incomplete ? err.reason : mapError(err) };
  }
}
