/**
 * Portal directory deprovisioning (W8, D11): the Google Workspace users source.
 *
 * `listGoogleDirectoryUsers` reads the customer's whole user directory through a
 * read-only reader and answers `complete` only when every completeness rule in
 * D11 holds; anything else is `incomplete` with a reason and acts on nobody.
 * It never logs: no subject, email, id, customer id or key material leaves this
 * module except through the returned value.
 *
 * The daily pass (D10): `runGoogleSweep` fans out one `google-org` job per org
 * with an active Google connection and at least one enabled Google identity;
 * `evaluateGoogleOrg` lists that org's directory OUTSIDE any transaction
 * (network I/O), then records the snapshot in one system transaction under
 * the `(org, 'google')` advisory lock, after re-checking that the connection
 * (id and binding, FOR SHARE) and the org are still the ones it read. Its log
 * lines carry the org id, outcome, reason and counts only.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { googleWorkspaceConnections, portalUserIdentities } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { bullmqJobId } from '../bullmqUtils';
import { getDirectoryUsersReader } from '../googleClient';
import { decryptConnectionKey, loadGoogleConnection } from '../googleHelpers';
import { googleConnectionBinding } from '../portalDomainVerification/checkers/googleBinding';
import { getActiveOrgTenant } from '../tenantStatus';
import { googleChainKey } from './chain';
import type { DirectoryObservation, InScopeIdentity } from './evaluate';
import { lockPortalDirectorySource } from './identityDisable';
import {
  PORTAL_DIRECTORY_GOOGLE_ORG_JOB,
  PORTAL_DIRECTORY_JOB_OPTS,
  getPortalDirectoryQueue,
  type PortalDirectoryGoogleOrgJobData,
} from './queue';
import {
  afterRunCommitted,
  recordEvaluatedRun,
  recordRefusedRun,
  type RecordedRun,
  type RunRefusalReason,
  type RunStoreExecutor,
} from './runStore';

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

// ---------------------------------------------------------------------------
// The daily pass (D10)
// ---------------------------------------------------------------------------

const LOG = '[portal-directory]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_EXECUTABLE_STATUS = 'active';

/** `portal-dir-google-<orgId>-<utcDate>`: one job per org per UTC day, no colons. */
export function googleOrgJobId(orgId: string, utcDate: string): string {
  return bullmqJobId('portal-dir-google', orgId, utcDate);
}

export interface GoogleSweepDeps {
  listCandidateOrgs(): Promise<string[]>;
}

const defaultSweepDeps: GoogleSweepDeps = {
  listCandidateOrgs: () => runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ orgId: googleWorkspaceConnections.orgId })
      .from(googleWorkspaceConnections)
      .where(and(
        eq(googleWorkspaceConnections.status, GOOGLE_EXECUTABLE_STATUS),
        sql`EXISTS (SELECT 1 FROM ${portalUserIdentities}
                     WHERE ${portalUserIdentities.orgId} = ${googleWorkspaceConnections.orgId}
                       AND ${portalUserIdentities.provider} = 'google'
                       AND ${portalUserIdentities.disabledAt} IS NULL)`,
      ));
    return rows.map((r) => r.orgId);
  }, 'portalDirectory.googleSweep')),
};

/**
 * The daily `google-sweep`: one `google-org` job per org with an active Google
 * connection and at least one enabled Google identity, keyed on the UTC day.
 * A failed enqueue is logged (org id only) and counted out; tomorrow's sweep
 * is the retry.
 */
export async function runGoogleSweep(now: Date, deps: GoogleSweepDeps = defaultSweepDeps): Promise<{ enqueued: number }> {
  const utcDate = now.toISOString().slice(0, 10);
  const orgIds = await deps.listCandidateOrgs();
  const queue = getPortalDirectoryQueue();
  let enqueued = 0;
  for (const orgId of orgIds) {
    const data: PortalDirectoryGoogleOrgJobData = { orgId, utcDate };
    try {
      await queue.add(PORTAL_DIRECTORY_GOOGLE_ORG_JOB, data, { ...PORTAL_DIRECTORY_JOB_OPTS, jobId: googleOrgJobId(orgId, utcDate) });
      enqueued += 1;
    } catch (err) {
      console.error(`${LOG} google-org enqueue failed`, { orgId, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
  console.log(`${LOG} google sweep`, { utcDate, candidates: orgIds.length, enqueued });
  return { enqueued };
}

interface GoogleConnectionFacts {
  id: string;
  status: string;
  adminEmail: string;
  serviceAccountEmail: string;
}

/** The I/O seam (the run.ts `deps` precedent): unit tests drive the decisions, the integration suite the SQL. */
export interface GoogleOrgDeps {
  loadConnection(orgId: string): Promise<(GoogleConnectionFacts & { serviceAccountKey?: string }) | null>;
  decryptKey(conn: GoogleConnectionFacts & { serviceAccountKey?: string }): string;
  makeReader(decryptedKeyJson: string, adminEmail: string): DirectoryUsersReader;
  hasIdentities(orgId: string): Promise<boolean>;
  list(reader: DirectoryUsersReader, adminEmail: string): Promise<GoogleListing>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  lockSource(orgId: string): Promise<void>;
  recheckConnection(orgId: string, connectionId: string): Promise<GoogleConnectionFacts | null>;
  orgActive(orgId: string): Promise<boolean>;
  loadIdentities(orgId: string): Promise<InScopeIdentity[]>;
  recordRefusedRun: typeof recordRefusedRun;
  recordEvaluatedRun: typeof recordEvaluatedRun;
  afterRunCommitted: typeof afterRunCommitted;
}

const inSystem = <T>(label: string, fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

const enabledGoogleIdentities = (orgId: string) => and(
  eq(portalUserIdentities.orgId, orgId),
  eq(portalUserIdentities.provider, 'google'),
  isNull(portalUserIdentities.disabledAt),
);

const defaultOrgDeps: GoogleOrgDeps = {
  loadConnection: (orgId) => inSystem('portalDirectory.googleConnection', () => loadGoogleConnection(orgId)),
  decryptKey: (conn) => decryptConnectionKey(conn as Parameters<typeof decryptConnectionKey>[0]),
  makeReader: getDirectoryUsersReader,
  hasIdentities: (orgId) => inSystem('portalDirectory.googleHasIdentities', async () => {
    const [row] = await db
      .select({ id: portalUserIdentities.id })
      .from(portalUserIdentities)
      .where(enabledGoogleIdentities(orgId))
      .limit(1);
    return Boolean(row);
  }),
  list: (reader, adminEmail) => listGoogleDirectoryUsers(reader, adminEmail),
  transaction: (fn) => inSystem('portalDirectory.googleRecord', fn),
  lockSource: (orgId) => lockPortalDirectorySource(orgId, 'google'),
  async recheckConnection(orgId, connectionId) {
    const [row] = await db
      .select({
        id: googleWorkspaceConnections.id,
        status: googleWorkspaceConnections.status,
        adminEmail: googleWorkspaceConnections.adminEmail,
        serviceAccountEmail: googleWorkspaceConnections.serviceAccountEmail,
      })
      .from(googleWorkspaceConnections)
      .where(and(eq(googleWorkspaceConnections.id, connectionId), eq(googleWorkspaceConnections.orgId, orgId)))
      .for('share')
      .limit(1);
    return row ?? null;
  },
  orgActive: async (orgId) => (await getActiveOrgTenant(orgId)) !== null,
  async loadIdentities(orgId) {
    const rows = await db
      .select({
        identityId: portalUserIdentities.id,
        portalUserId: portalUserIdentities.portalUserId,
        subject: portalUserIdentities.subject,
        directoryChain: portalUserIdentities.directoryChain,
        directorySeenAt: portalUserIdentities.directorySeenAt,
        directoryAbsentRuns: portalUserIdentities.directoryAbsentRuns,
        directoryAbsentSince: portalUserIdentities.directoryAbsentSince,
        directoryLastRunId: portalUserIdentities.directoryLastRunId,
        directoryRearmSince: portalUserIdentities.directoryRearmSince,
      })
      .from(portalUserIdentities)
      .where(enabledGoogleIdentities(orgId));
    return rows.map((r) => ({ ...r, provider: 'google' as const }));
  },
  recordRefusedRun,
  recordEvaluatedRun,
  afterRunCommitted,
};

/** D11 matching: the identity subject (OIDC `sub`) is the Directory user `id`. OD5: archived counts as disabled. */
function observerFor(users: Map<string, { suspended: boolean; archived: boolean }>): (subject: string) => DirectoryObservation {
  return (subject) => {
    const user = users.get(subject);
    if (!user) return { present: false };
    if (user.suspended) return { present: true, state: 'disabled', reason: 'suspended' };
    if (user.archived) return { present: true, state: 'disabled', reason: 'archived' };
    return { present: true, state: 'enabled' };
  };
}

export type GoogleOrgOutcome = { outcome: 'evaluated' | 'incomplete' | 'skipped' | 'no_identities'; reason?: RunRefusalReason };

type InTransaction =
  | { kind: 'done'; result: GoogleOrgOutcome }
  | { kind: 'evaluated'; recorded: RecordedRun; usable: number; users: number };

/**
 * One org's Google snapshot for one UTC day (plan Task 7; D5, D10, D11). The
 * snapshot key `<connectionId>:<utcDate>` makes a re-run of the same day a
 * no-op. Throws only for an unexpected failure (the job retries), with a class
 * name and SQLSTATE and nothing else.
 */
export async function evaluateGoogleOrg(
  orgId: string,
  utcDate: string,
  deps: GoogleOrgDeps = defaultOrgDeps,
): Promise<GoogleOrgOutcome> {
  if (!UUID_RE.test(orgId) || !UTC_DATE_RE.test(utcDate)) throw new Error('evaluateGoogleOrg: invalid org id or date');
  const log = (r: GoogleOrgOutcome & { usable?: number; users?: number; runId?: string; disposition?: string }) =>
    console.log(`${LOG} google run`, { orgId, utcDate, source: 'google', reason: null, ...r });

  try {
    // 1. The connection and, only when someone could be affected, its key.
    const conn = await deps.loadConnection(orgId);
    if (!conn || conn.status !== GOOGLE_EXECUTABLE_STATUS) {
      const out: GoogleOrgOutcome = { outcome: 'skipped', reason: 'connection_inactive' };
      log(out);
      return out;
    }
    if (!(await deps.hasIdentities(orgId))) {
      log({ outcome: 'no_identities' });
      return { outcome: 'no_identities' };
    }

    // 2. The listing — network I/O, so OUTSIDE any transaction.
    let listing: GoogleListing;
    try {
      const reader = deps.makeReader(deps.decryptKey(conn), conn.adminEmail);
      listing = await deps.list(reader, conn.adminEmail);
    } catch {
      // A key that does not decrypt or parse. Never log the error: it can quote the key.
      listing = { kind: 'incomplete', reason: 'connection_invalid' };
    }
    const binding = googleConnectionBinding(conn);
    const snapshotKey = `${conn.id}:${utcDate}`;
    const snapshotAt = new Date();

    // 3. One system transaction: lock, re-check, record.
    const outcome = await deps.transaction(async (): Promise<InTransaction> => {
      const tx = db as RunStoreExecutor;
      const refuse = async (refusal: 'incomplete' | 'skipped', reason: RunRefusalReason): Promise<InTransaction> => {
        await deps.recordRefusedRun(tx, { orgId, source: 'google', snapshotKey, snapshotAt, outcome: refusal, reason });
        return { kind: 'done', result: { outcome: refusal, reason } };
      };

      await deps.lockSource(orgId);
      const now = await deps.recheckConnection(orgId, conn.id);
      // Re-bound (new admin or service account), deactivated or removed while
      // listing: the listing is no longer this connection's evidence.
      if (!now || now.status !== GOOGLE_EXECUTABLE_STATUS || googleConnectionBinding(now) !== binding) {
        return refuse('skipped', 'connection_inactive');
      }
      if (!(await deps.orgActive(orgId))) return refuse('skipped', 'org_inactive');
      if (listing.kind === 'incomplete') return refuse('incomplete', listing.reason);

      const identities = await deps.loadIdentities(orgId);
      if (identities.length === 0) return { kind: 'done', result: { outcome: 'no_identities' } };
      const recorded = await deps.recordEvaluatedRun(tx, {
        orgId,
        source: 'google',
        snapshotKey,
        snapshotAt,
        chainKey: googleChainKey({ customerId: listing.customerId, connectionId: conn.id, binding, orgId }),
        directoryUserCount: listing.users.size,
        identities,
        observe: observerFor(listing.users),
      });
      return { kind: 'evaluated', recorded, usable: identities.length, users: listing.users.size };
    });

    if (outcome.kind === 'done') {
      log(outcome.result);
      return outcome.result;
    }
    await deps.afterRunCommitted(outcome.recorded);
    log({
      outcome: 'evaluated', runId: outcome.recorded.runId, disposition: outcome.recorded.disposition,
      usable: outcome.usable, users: outcome.users,
    });
    return { outcome: 'evaluated' };
  } catch (err) {
    const code = pgErrorCode(err);
    console.error(`${LOG} google run failed`, { orgId, utcDate, error: err instanceof Error ? err.name : 'unknown', code: code ?? null });
    throw new Error(`portal directory google-org failed: ${err instanceof Error ? err.name : 'unknown'}${code ? ` (${code})` : ''}`);
  }
}
