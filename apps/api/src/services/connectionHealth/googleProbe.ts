import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getDirectoryClient, GoogleApiError, normalizeGoogleError } from '../googleClient';
import { decryptForColumn } from '../secretCrypto';
import { sanitizeHealthDetail } from './sanitize';

// Google Workspace verification probe (spec §3, W4 plan D6/D7). Google has no
// failure writer: a revoked domain-wide delegation or a deleted super-admin is
// only noticed when an AI tool or the Gmail poller next calls Google. The
// reconciler's google_workspace source calls runGoogleProbes() in its
// prepare() step, BEFORE the kind's transaction and outside any DB context, so
// no network call ever holds a DB connection.
//
// Rate limits: a connection is probed at most once per PROBE_INTERVAL_MS, at
// most PROBE_BATCH per run, PROBE_CONCURRENCY at a time, PROBE_TIMEOUT_MS each.
// The claim stamps last_probe_at with FOR UPDATE SKIP LOCKED, so overlapping
// runs never probe the same row. The result is written with a CAS on
// updated_at: if an admin re-saved the connection mid-probe (the route
// verifies inline and resets the probe columns), the stale result is dropped.
//
// Credentials: the decrypted key lives only inside probeConnection(). Errors
// are reduced to normalizeGoogleError()'s status-class message (no bodies),
// then sanitizeHealthDetail(); anything resembling key material is replaced.

export const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PROBE_BATCH = 16;
export const PROBE_CONCURRENCY = 4;
export const PROBE_TIMEOUT_MS = 8_000;

export type ProbeStatus = 'ok' | 'failed' | 'unavailable';
export type ProbeResult = { status: ProbeStatus; error: string | null };

export type ProbeTarget = {
  id: string;
  orgId: string;
  adminEmail: string;
  /** Ciphertext as stored. */
  serviceAccountKey: string;
  /** updated_at as Postgres text, for an exact CAS (no Date / time-zone round trip). */
  updatedAtText: string;
};

export class ProbeTimeoutError extends Error {
  constructor(ms: number) {
    super(`Google did not answer within ${Math.round(ms / 1000)} seconds.`);
    this.name = 'ProbeTimeoutError';
  }
}

export class ProbeCredentialsError extends Error {
  constructor() {
    super('The stored service-account key could not be read. Save the connection again.');
    this.name = 'ProbeCredentialsError';
  }
}

const KEY_MATERIAL = /PRIVATE KEY|BEGIN [A-Z ]+-----|ya29\.|"private_key"/i;

function cleanMessage(message: string): string | null {
  if (KEY_MATERIAL.test(message)) return 'Google rejected the service-account credentials.';
  return sanitizeHealthDetail(message);
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.response?.status, e?.code]) {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v);
  }
  return undefined;
}

/**
 * failed = Google (or the stored key) rejected the credentials: needs a human.
 * unavailable = no verdict (rate limit, 5xx, network, timeout, our own bug):
 * the source reports unknown, so a Google outage opens nothing.
 */
export function classifyProbeError(err: unknown): ProbeResult {
  if (err instanceof ProbeTimeoutError) return { status: 'unavailable', error: err.message };
  if (err instanceof ProbeCredentialsError) return { status: 'failed', error: err.message };
  if (err instanceof GoogleApiError) return { status: 'failed', error: cleanMessage(err.message) };
  const status = httpStatusOf(err);
  if (status === undefined) {
    return { status: 'unavailable', error: 'Google could not be reached.' };
  }
  if (status === 429 || status >= 500) {
    return { status: 'unavailable', error: `Google is unavailable (${status}).` };
  }
  const e = err as { message?: unknown; errors?: unknown };
  const { message } = normalizeGoogleError({
    code: status,
    message: typeof e.message === 'string' ? e.message : undefined,
    errors: Array.isArray(e.errors) ? e.errors : undefined,
  });
  return { status: 'failed', error: cleanMessage(message) };
}

/** One Directory call as the impersonated super-admin, the same call the connect route verifies with. */
export async function probeConnection(target: ProbeTarget, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<void> {
  let keyJson: string | null;
  try {
    keyJson = decryptForColumn('google_workspace_connections', 'service_account_key', target.serviceAccountKey);
  } catch {
    throw new ProbeCredentialsError();
  }
  if (!keyJson) throw new ProbeCredentialsError();
  const dir = getDirectoryClient(keyJson, target.adminEmail);
  await dir.users.get({ userKey: target.adminEmail, fields: 'id' }, { timeout: timeoutMs });
}

const sys = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/** Claim up to `limit` due connections (never probed first, then oldest) by stamping last_probe_at. */
export async function claimDueProbes(now: Date, limit: number): Promise<ProbeTarget[]> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - PROBE_INTERVAL_MS).toISOString();
  return sys(async () => {
    const rows = (await db.execute(sql`
      UPDATE google_workspace_connections g
      SET last_probe_at = ${nowIso}::timestamp
      WHERE g.id IN (
        SELECT id FROM google_workspace_connections
        WHERE last_probe_at IS NULL OR last_probe_at < ${cutoff}::timestamp
        ORDER BY last_probe_at ASC NULLS FIRST
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING g.id, g.org_id, g.admin_email, g.service_account_key, g.updated_at::text AS updated_at_text`)) as unknown as Array<{
      id: string; org_id: string; admin_email: string; service_account_key: string; updated_at_text: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      adminEmail: r.admin_email,
      serviceAccountKey: r.service_account_key,
      updatedAtText: r.updated_at_text,
    }));
  }, 'connectionHealth.googleProbe.claim');
}

/** false when the connection changed (or vanished) since the claim: the result is stale and dropped. */
export async function recordProbeResult(target: ProbeTarget, result: ProbeResult, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  return sys(async () => {
    const rows = (await db.execute(sql`
      UPDATE google_workspace_connections
      SET last_probe_status = ${result.status},
          last_probe_error = ${result.error},
          last_verified_at = CASE WHEN ${result.status} = 'ok' THEN ${nowIso}::timestamp ELSE last_verified_at END
      WHERE id = ${target.id}::uuid AND updated_at = ${target.updatedAtText}::timestamp
      RETURNING id`)) as unknown as unknown[];
    return rows.length > 0;
  }, 'connectionHealth.googleProbe.record');
}

export type ProbeDeps = {
  claim: (now: Date, limit: number) => Promise<ProbeTarget[]>;
  probe: (target: ProbeTarget, timeoutMs: number) => Promise<void>;
  record: (target: ProbeTarget, result: ProbeResult, now: Date) => Promise<boolean>;
  timeoutMs: number;
};

const defaultDeps: ProbeDeps = {
  claim: claimDueProbes,
  probe: probeConnection,
  record: recordProbeResult,
  timeoutMs: PROBE_TIMEOUT_MS,
};

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError(ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type ProbeRunCounts = {
  claimed: number; ok: number; failed: number; unavailable: number; discarded: number; recordErrors: number;
};

/**
 * Claim, probe and record one batch. A claim failure throws (the kind fails
 * and its incidents stay untouched); a single probe or record failure never
 * stops the batch. Never logs a key or a raw provider body.
 */
export async function runGoogleProbes(now: Date, deps: ProbeDeps = defaultDeps): Promise<ProbeRunCounts> {
  const targets = await deps.claim(now, PROBE_BATCH);
  const counts: ProbeRunCounts = { claimed: targets.length, ok: 0, failed: 0, unavailable: 0, discarded: 0, recordErrors: 0 };
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      let result: ProbeResult;
      try {
        await withTimeout(deps.probe(target, deps.timeoutMs), deps.timeoutMs);
        result = { status: 'ok', error: null };
      } catch (err) {
        result = classifyProbeError(err);
      }
      counts[result.status] += 1;
      try {
        if (!(await deps.record(target, result, now))) counts.discarded += 1;
      } catch (err) {
        counts.recordErrors += 1;
        console.error(JSON.stringify({
          event: 'connection_health_google_probe_record_failed',
          connectionId: target.id,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, targets.length) }, worker));
  if (counts.claimed > 0) console.info(JSON.stringify({ event: 'connection_health_google_probe_run', ...counts }));
  return counts;
}
