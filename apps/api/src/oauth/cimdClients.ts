/**
 * B-W03 (#6157, D-B20): CIMD client admission and its `oauth_clients` row.
 *
 * Every OAuth artifact table (codes, grants, refresh tokens, partner grants,
 * client blocks, approval requests) foreign-keys `oauth_clients.id`, so a CIMD
 * client — whose id is its metadata-document URL — is materialised as a row
 * (`partner_id` NULL, `metadata` = the validated document). The row is NOT the
 * source of the client's metadata: the adapter never serves it (adapter.ts
 * `find`), so oidc-provider re-resolves the document through its cache and
 * `cimdAllowClient` on every use.
 *
 * Writes are rare by construction: insert only when absent (global create
 * budget), rewrite `metadata` only when its hash changed, at most once per
 * 60 s per client per process. A row with `disabled_at` set refuses the client
 * — disabling goes through `revokeClientFamilies(id, { kind: 'global' })`.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthClients } from '../db/schema';
import { getRedis } from '../services/redis';
import { rateLimiter } from '../services/rate-limit';
import {
  CIMD_FETCH_BUDGET, cimdEnabledNow, cimdHostAllowedNow, isCimdClientId, refuseCimd, validateCimdMetadata,
} from './cimdPolicy';

export type CimdMaterializeResult = 'created' | 'updated' | 'unchanged' | 'disabled' | 'budget_exceeded';

const METADATA_REWRITE_MIN_INTERVAL_MS = 60_000;
const lastWriteAt = new Map<string, number>();
const LAST_WRITE_MAX_ENTRIES = 5000;

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

/** Key-order-independent JSON, so a re-serialised document hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function metadataHash(metadata: unknown): string {
  return createHash('sha256').update(stableJson(metadata)).digest('base64url');
}

function noteWrite(clientId: string, now: number): void {
  lastWriteAt.delete(clientId);
  lastWriteAt.set(clientId, now);
  while (lastWriteAt.size > LAST_WRITE_MAX_ENTRIES) {
    const oldest = lastWriteAt.keys().next().value;
    if (oldest === undefined) break;
    lastWriteAt.delete(oldest);
  }
}

async function withinCreateBudget(): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return process.env.NODE_ENV !== 'production';
  // A Redis error propagates: cimdAllowClient refuses the client and logs the
  // cause (materialize_failed + err) rather than reporting a spent budget.
  const rate = await rateLimiter(redis, 'oauth:cimd:create:global', CIMD_FETCH_BUDGET.createsPerHour, 3600);
  return rate.allowed;
}

export async function materializeCimdClient(
  clientId: string,
  metadata: Record<string, unknown>,
): Promise<CimdMaterializeResult> {
  const hash = metadataHash(metadata);
  const [row] = await asSystem(() =>
    db.select({ id: oauthClients.id, metadata: oauthClients.metadata, disabledAt: oauthClients.disabledAt })
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId)),
  );

  if (row) {
    if (row.disabledAt) return 'disabled';
    if (metadataHash(row.metadata) === hash) return 'unchanged';
    const now = Date.now();
    const last = lastWriteAt.get(clientId);
    if (last !== undefined && now - last < METADATA_REWRITE_MIN_INTERVAL_MS) return 'unchanged';
    await asSystem(() =>
      db.update(oauthClients)
        .set({ metadata })
        .where(and(eq(oauthClients.id, clientId), isNull(oauthClients.disabledAt))),
    );
    noteWrite(clientId, now);
    return 'updated';
  }

  // Budget is checked outside any DB context (it is a Redis round-trip).
  if (!(await withinCreateBudget())) return 'budget_exceeded';
  await asSystem(() =>
    db.insert(oauthClients)
      .values({ id: clientId, partnerId: null, clientSecretHash: null, metadata })
      .onConflictDoNothing(),
  );
  noteWrite(clientId, Date.now());
  return 'created';
}

/**
 * `features.clientIdMetadataDocument.allowClient`: runs on EVERY use of a CIMD
 * client, cache hits included (allowFetch only runs on a miss). Re-checks the
 * live flag and host policy, validates the document, then materialises the
 * row — refusing a disabled client.
 */
export async function cimdAllowClient(
  _ctx: unknown,
  client: { clientId: string; metadata(): Record<string, unknown> },
): Promise<boolean> {
  const clientId = client.clientId;
  if (!cimdEnabledNow()) return refuseCimd('disabled', clientId);
  if (!isCimdClientId(clientId)) return refuseCimd('invalid_client_id', clientId);
  if (!cimdHostAllowedNow(new URL(clientId).hostname)) return refuseCimd('host_not_allowed', clientId);
  const metadata = client.metadata();
  const valid = validateCimdMetadata(clientId, metadata);
  if (!valid.ok) return refuseCimd(`metadata_invalid:${valid.reason}`, clientId);
  let result: CimdMaterializeResult;
  try {
    result = await materializeCimdClient(clientId, metadata);
  } catch (err) {
    return refuseCimd('materialize_failed', clientId, err);
  }
  if (result === 'created' || result === 'updated' || result === 'unchanged') return true;
  return refuseCimd(result, clientId);
}

/** Test-only. */
export function __resetCimdMaterializeThrottleForTests(): void {
  lastWriteAt.clear();
}
