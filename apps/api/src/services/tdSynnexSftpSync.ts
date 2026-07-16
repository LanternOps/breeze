/**
 * TD SYNNEX nightly SFTP Price & Availability ingest.
 *
 * Nightly the distributor drops a `<accountNumber>.zip` on their SFTP server
 * containing a single `.AP` flat file. We download it, unzip it, parse it (see
 * tdSynnexPriceFile.ts) and upsert the rows into td_synnex_price_availability.
 *
 * Security shape, mirroring the EC Express connector:
 *   - The host is NOT partner-supplied. It comes from REGION_HOSTS, so this
 *     connector can never be pointed at an attacker-chosen server.
 *   - The resolved IPs are still checked against isPrivateIp: safeFetch's SSRF
 *     guard is HTTP-only and does not cover an SFTP socket, so we re-check here.
 *   - Only the password is a secret; it is encrypted at rest and redacted from
 *     every error string before it can reach last_sync_error / logs / Sentry.
 */
import { promises as dns } from 'node:dns';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, and, lt, sql } from 'drizzle-orm';
import SftpClient from 'ssh2-sftp-client';
import StreamZip from 'node-stream-zip';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../db';
import { tdSynnexSftpIntegrations, tdSynnexPriceAvailability } from '../db/schema';
import { encryptSecret, decryptForColumn } from './secretCrypto';
import { isPrivateIp } from './urlSafety';
import { parsePriceFile, type TdSynnexPriceRow, type TdSynnexRegion } from './tdSynnexPriceFile';
import type { CatalogActor } from './catalogService';

const TABLE = 'td_synnex_sftp_integrations';
const CREDENTIALS_COLUMN = 'credentials';
export const SFTP_MASKED_SECRET = '********';

/**
 * Server-controlled host map. A partner picks a region, never a hostname.
 * Username prefix differs per region ('u' + acct for US, 'c' + acct for Canada)
 * per the TD SYNNEX quick guide.
 */
export const REGION_HOSTS = {
  US: { host: 'sftp.us.tdsynnex.com', userPrefix: 'u' },
  CA: { host: 'sftp.ca.tdsynnex.com', userPrefix: 'c' },
} as const;

export type SftpRegion = keyof typeof REGION_HOSTS;

const SFTP_PORT = 22;
const CONNECT_TIMEOUT_MS = 30_000;
/** The full US catalog file is large; allow generous time but never unbounded. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Guard against a pathological/hostile archive filling the disk. */
const MAX_ZIP_BYTES = 1_024 * 1_024 * 1_024; // 1 GiB compressed
const MAX_UNCOMPRESSED_BYTES = 8 * 1_024 * 1_024 * 1_024; // 8 GiB expanded
const UPSERT_BATCH_SIZE = 500;

const SFTP_ERROR_STATUS = {
  SFTP_PARTNER_REQUIRED: 400,
  SFTP_NOT_CONFIGURED: 404,
  SFTP_DISABLED: 400,
  SFTP_CREDENTIALS_INVALID: 400,
  SFTP_AUTH_FAILED: 422,
  SFTP_UNSUPPORTED_REGION: 400,
  SFTP_HOST_BLOCKED: 502,
  SFTP_FILE_NOT_FOUND: 404,
  SFTP_ARCHIVE_INVALID: 502,
  SFTP_FILE_TOO_LARGE: 502,
  SFTP_PARSE_FAILED: 502,
  SFTP_PROVIDER_ERROR: 502,
} as const;

export type TdSynnexSftpErrorCode = keyof typeof SFTP_ERROR_STATUS;

export class TdSynnexSftpError extends Error {
  public readonly status: number;
  constructor(message: string, public readonly code: TdSynnexSftpErrorCode = 'SFTP_PROVIDER_ERROR') {
    super(message);
    this.name = 'TdSynnexSftpError';
    this.status = SFTP_ERROR_STATUS[code] ?? 502;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requirePartner(actor: CatalogActor): string {
  if (!actor.partnerId) {
    throw new TdSynnexSftpError('TD SYNNEX SFTP integration is partner-scoped', 'SFTP_PARTNER_REQUIRED');
  }
  return actor.partnerId;
}

/**
 * Strip the password from any provider/library error before it is persisted or
 * logged. ssh2 error strings do not normally echo the password, but a stack
 * frame or a verbose transport error can, and last_sync_error is read back by
 * the UI — so scrub unconditionally rather than trusting the library.
 */
function redactSecret(message: string, password: string | null): string {
  if (!password || password.length === 0) return message;
  return message.split(password).join(SFTP_MASKED_SECRET);
}

function decryptCredential(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  // A present-but-non-string credential means the stored JSONB is corrupt — fail
  // loudly instead of silently treating it as "absent" and reporting auth failure.
  if (typeof value !== 'string') {
    throw new TdSynnexSftpError(
      'Stored TD SYNNEX SFTP credentials are corrupt — re-enter them',
      'SFTP_CREDENTIALS_INVALID'
    );
  }
  if (value.length === 0) return null;
  return decryptForColumn(TABLE, CREDENTIALS_COLUMN, value);
}

function assertRegion(region: string): SftpRegion {
  if (region !== 'US' && region !== 'CA') {
    throw new TdSynnexSftpError(`Unsupported TD SYNNEX SFTP region: ${region}`, 'SFTP_UNSUPPORTED_REGION');
  }
  return region;
}

export function sftpUsername(region: SftpRegion, accountNumber: string): string {
  return `${REGION_HOSTS[region].userPrefix}${accountNumber}`;
}

export function remoteFileName(accountNumber: string): string {
  return `${accountNumber}.zip`;
}

/**
 * safeFetch's SSRF guard only covers HTTP. Re-check the SFTP host here: resolve
 * it and refuse to open a socket if every address is private/loopback/link-local
 * (a hijacked or poisoned DNS answer for the TD SYNNEX host).
 */
async function assertPublicHost(host: string): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new TdSynnexSftpError(
      `Could not resolve TD SYNNEX SFTP host ${host}: ${err instanceof Error ? err.message : String(err)}`,
      'SFTP_HOST_BLOCKED'
    );
  }
  if (addrs.length === 0 || addrs.every((a) => isPrivateIp(a.address))) {
    throw new TdSynnexSftpError(
      `TD SYNNEX SFTP host ${host} resolved only to private addresses — refusing to connect`,
      'SFTP_HOST_BLOCKED'
    );
  }
}

interface ResolvedConfig {
  id: string;
  partnerId: string;
  region: SftpRegion;
  accountNumber: string;
  password: string;
  enabled: boolean;
}

function resolveConfig(row: typeof tdSynnexSftpIntegrations.$inferSelect | undefined): ResolvedConfig {
  if (!row) {
    throw new TdSynnexSftpError('TD SYNNEX SFTP integration is not configured', 'SFTP_NOT_CONFIGURED');
  }
  const creds = asRecord(row.credentials);
  const password = decryptCredential(creds.password);
  const accountNumber = (row.accountNumber ?? '').trim();
  if (!accountNumber || !password) {
    throw new TdSynnexSftpError(
      'TD SYNNEX SFTP integration is missing an account number or password',
      'SFTP_NOT_CONFIGURED'
    );
  }
  return {
    id: row.id,
    partnerId: row.partnerId,
    region: assertRegion(row.region),
    accountNumber,
    password,
    enabled: row.enabled,
  };
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

export interface TdSynnexSftpConfigInput {
  region?: string;
  accountNumber?: string | null;
  password?: string | null;
  enabled?: boolean;
}

/**
 * Never return plaintext: a populated secret reads back as the mask sentinel.
 * Both branches return the SAME shape — an unconfigured integration must not
 * hand the UI a partial object with half the fields missing.
 */
function maskConfig(row: typeof tdSynnexSftpIntegrations.$inferSelect | undefined) {
  if (!row) {
    return {
      configured: false,
      id: null,
      region: 'US',
      accountNumber: '',
      username: null,
      remoteFileName: null,
      host: REGION_HOSTS.US.host,
      credentials: { password: '' },
      enabled: false,
      lastTestStatus: null,
      lastTestAt: null,
      lastTestError: null,
      lastSyncStatus: null,
      lastSyncAt: null,
      lastSyncError: null,
      lastFileName: null,
      lastRowCount: null,
    };
  }
  const creds = asRecord(row.credentials);
  const hasPassword = typeof creds.password === 'string' && creds.password.length > 0;
  const accountNumber = (row.accountNumber ?? '').trim();
  return {
    configured: hasPassword && accountNumber.length > 0,
    id: row.id,
    region: row.region,
    accountNumber,
    // The username and remote filename are derived, so show them read-only —
    // it makes a typo'd account number obvious before the first sync runs.
    username: accountNumber ? sftpUsername(assertRegion(row.region), accountNumber) : null,
    remoteFileName: accountNumber ? remoteFileName(accountNumber) : null,
    host: REGION_HOSTS[assertRegion(row.region)].host,
    credentials: { password: hasPassword ? SFTP_MASKED_SECRET : '' },
    enabled: row.enabled,
    lastTestStatus: row.lastTestStatus,
    lastTestAt: row.lastTestAt,
    lastTestError: row.lastTestError,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncAt: row.lastSyncAt,
    lastSyncError: row.lastSyncError,
    lastFileName: row.lastFileName,
    lastRowCount: row.lastRowCount,
  };
}

export async function getSftpStatus(actor: CatalogActor) {
  const partnerId = requirePartner(actor);
  const [row] = await db.select().from(tdSynnexSftpIntegrations)
    .where(eq(tdSynnexSftpIntegrations.partnerId, partnerId));
  return maskConfig(row);
}

export async function saveSftpConfig(actor: CatalogActor, input: TdSynnexSftpConfigInput) {
  const partnerId = requirePartner(actor);
  const region = assertRegion(input.region ?? 'US');

  const [existing] = await db.select().from(tdSynnexSftpIntegrations)
    .where(eq(tdSynnexSftpIntegrations.partnerId, partnerId));

  const creds: Record<string, unknown> = { ...asRecord(existing?.credentials) };
  // The UI reads secrets back as '********'; a save that echoes the mask must
  // not overwrite the stored secret with the mask itself.
  if (input.password !== undefined && input.password !== SFTP_MASKED_SECRET) {
    if (input.password === null || input.password.trim().length === 0) {
      delete creds.password;
    } else {
      creds.password = encryptSecret(input.password.trim());
    }
  }

  const accountNumber = input.accountNumber === undefined
    ? existing?.accountNumber ?? null
    : (input.accountNumber?.trim() || null);

  if (accountNumber !== null && !/^\d{1,32}$/.test(accountNumber)) {
    throw new TdSynnexSftpError(
      'TD SYNNEX account number must be numeric',
      'SFTP_CREDENTIALS_INVALID'
    );
  }

  const values = {
    partnerId,
    region,
    accountNumber,
    credentials: creds,
    enabled: input.enabled ?? existing?.enabled ?? false,
    createdBy: existing?.createdBy ?? actor.userId ?? null,
    updatedAt: new Date(),
  };

  const [saved] = await db.insert(tdSynnexSftpIntegrations)
    .values(values)
    .onConflictDoUpdate({
      target: tdSynnexSftpIntegrations.partnerId,
      set: {
        region: values.region,
        accountNumber: values.accountNumber,
        credentials: values.credentials,
        enabled: values.enabled,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  return maskConfig(saved);
}

/**
 * Search the ingested catalog. This is the capability EC Express does NOT have:
 * its SOAP lookup resolves ONE exact sku-or-part-no at a time, with no keyword,
 * name, or manufacturer search. This is what makes the nightly file worth having.
 *
 * Matching is ILIKE-per-term against the pg_trgm GIN indexes (name, mfg_part_no,
 * synnex_sku, manufacturer), so a '%term%' predicate is index-backed rather than
 * a sequential scan over every SKU. Terms are AND-ed: "hp toner 61a" narrows.
 *
 * Partner-scoped by RLS; the explicit partner_id predicate is defence in depth,
 * not the isolation boundary.
 */
export async function listSftpPriceRows(
  actor: CatalogActor,
  opts: { q?: string; limit: number; offset: number; inStockOnly?: boolean }
) {
  // Still require a partner: the function fails closed on an empty
  // accessible-partner list, but an unscoped caller should be a 400, not a
  // silently-empty result set.
  requirePartner(actor);

  const terms = (opts.q ?? '').trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  // Goes through breeze_search_td_synnex_pa (SECURITY DEFINER) rather than a
  // plain SELECT. RLS forbids a non-leakproof ILIKE from becoming an index
  // condition, so a direct query CANNOT use the trigram index and degrades to a
  // full sequential scan of the catalog. The function enforces the SAME tenancy
  // predicate internally, from the session GUC — see the migration's comment.
  // Build ARRAY[$1, $2, ...]::text[] explicitly. Passing the JS array straight in
  // as a single param makes drizzle expand it to a TUPLE — `('toner')::text[]` —
  // which fails at the cast. Only a real-Postgres test catches this; a mocked
  // db.execute happily accepts either.
  const termList = sql.join(terms.map((t) => sql`${t}`), sql`, `);
  const rows = await db.execute<typeof tdSynnexPriceAvailability.$inferSelect>(sql`
    SELECT * FROM public.breeze_search_td_synnex_pa(
      ARRAY[${termList}]::text[],
      ${opts.inStockOnly ?? false}::boolean,
      ${opts.limit}::int,
      ${opts.offset}::int
    )
  `);
  return Array.from(rows);
}

/** Resolve the caller's integration id so a route can enqueue a manual sync. */
export async function getSftpIntegrationId(actor: CatalogActor): Promise<string> {
  const partnerId = requirePartner(actor);
  const [row] = await db.select({ id: tdSynnexSftpIntegrations.id })
    .from(tdSynnexSftpIntegrations)
    .where(eq(tdSynnexSftpIntegrations.partnerId, partnerId));
  if (!row) {
    throw new TdSynnexSftpError('TD SYNNEX SFTP integration is not configured', 'SFTP_NOT_CONFIGURED');
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// SFTP transport
// ---------------------------------------------------------------------------

async function withSftp<T>(cfg: ResolvedConfig, fn: (client: SftpClient) => Promise<T>): Promise<T> {
  const { host } = REGION_HOSTS[cfg.region];
  await assertPublicHost(host);

  const client = new SftpClient();
  try {
    await client.connect({
      host,
      port: SFTP_PORT,
      username: sftpUsername(cfg.region, cfg.accountNumber),
      password: cfg.password,
      readyTimeout: CONNECT_TIMEOUT_MS,
    });
    return await fn(client);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const message = redactSecret(raw, cfg.password);
    if (/all configured authentication methods failed|authentication|permission denied/i.test(raw)) {
      // Never echo the provider's auth text — it can carry the username back.
      throw new TdSynnexSftpError(
        'TD SYNNEX rejected the SFTP username or password',
        'SFTP_AUTH_FAILED'
      );
    }
    if (err instanceof TdSynnexSftpError) throw err;
    throw new TdSynnexSftpError(`TD SYNNEX SFTP error: ${message}`, 'SFTP_PROVIDER_ERROR');
  } finally {
    await client.end().catch(() => { /* already closed */ });
  }
}

/**
 * Connect, authenticate, and list the remote root. Used by the "Test" button.
 *
 * This route is registered in SELF_MANAGED_DB_CONTEXT_ROUTES (#1448): the auth
 * middleware opens NO ambient transaction for it, so every DB op below must open
 * its own short context, and the SSH handshake (up to a 30s readyTimeout) runs
 * with no pooled connection held. `runOutsideDbContext` alone would NOT achieve
 * that — it only swaps the AsyncLocalStorage db proxy, it does not close an
 * outer transaction the middleware already opened.
 */
export async function testSftpConnection(actor: CatalogActor, ctx: DbAccessContext) {
  const partnerId = requirePartner(actor);
  const [row] = await withDbAccessContext(ctx, () =>
    db.select().from(tdSynnexSftpIntegrations)
      .where(eq(tdSynnexSftpIntegrations.partnerId, partnerId))
  );
  const cfg = resolveConfig(row);

  const wanted = remoteFileName(cfg.accountNumber);
  let status = 'ok';
  let error: string | null = null;
  let fileFound = false;

  try {
    // No DB context held across the SSH socket.
    fileFound = await withSftp(cfg, async (client) => {
      const entries = await client.list('.');
      return entries.some((e) => e.name === wanted);
    });
  } catch (err) {
    status = 'error';
    error = redactSecret(err instanceof Error ? err.message : String(err), cfg.password);
  }

  await withDbAccessContext(ctx, () =>
    db.update(tdSynnexSftpIntegrations)
      .set({
        lastTestStatus: status,
        lastTestAt: new Date(),
        lastTestError: error,
        updatedAt: new Date(),
      })
      .where(eq(tdSynnexSftpIntegrations.id, cfg.id))
  );

  if (status === 'error') {
    return { success: false, error, fileFound: false };
  }
  return {
    success: true,
    fileFound,
    // A brand-new account authenticates before the first file is generated —
    // surface that explicitly rather than reporting a bare success.
    message: fileFound
      ? `Connected. Found ${wanted}.`
      : `Connected, but ${wanted} is not on the server yet. TD SYNNEX generates it within 24 hours of first login.`,
  };
}

// ---------------------------------------------------------------------------
// Download + extract
// ---------------------------------------------------------------------------

/** Download `<acct>.zip`, extract the single `.AP` entry, return its text. */
async function downloadAndExtract(cfg: ResolvedConfig): Promise<{ fileName: string; content: string }> {
  const wanted = remoteFileName(cfg.accountNumber);
  const workDir = await mkdtemp(path.join(tmpdir(), 'tds-pa-'));
  const zipPath = path.join(workDir, wanted);

  try {
    await withSftp(cfg, async (client) => {
      const entries = await client.list('.');
      const match = entries.find((e) => e.name === wanted);
      if (!match) {
        throw new TdSynnexSftpError(
          `${wanted} is not on the TD SYNNEX SFTP server yet`,
          'SFTP_FILE_NOT_FOUND'
        );
      }
      if (match.size > MAX_ZIP_BYTES) {
        throw new TdSynnexSftpError(
          `${wanted} is ${match.size} bytes, over the ${MAX_ZIP_BYTES}-byte ceiling`,
          'SFTP_FILE_TOO_LARGE'
        );
      }
      // Binary mode matters: an ASCII-mode transfer corrupts the archive (the
      // distributor's own quick guide calls this out as the #1 support issue).
      await Promise.race([
        client.fastGet(wanted, zipPath),
        new Promise((_, reject) =>
          setTimeout(() => reject(new TdSynnexSftpError('Download timed out', 'SFTP_PROVIDER_ERROR')), DOWNLOAD_TIMEOUT_MS)
        ),
      ]);
    });

    const zip = new StreamZip.async({ file: zipPath });
    try {
      const entries = Object.values(await zip.entries());
      const ap = entries.find((e) => !e.isDirectory && /\.ap$/i.test(e.name))
        ?? entries.find((e) => !e.isDirectory);
      if (!ap) {
        throw new TdSynnexSftpError(`${wanted} contains no files`, 'SFTP_ARCHIVE_INVALID');
      }
      if (ap.size > MAX_UNCOMPRESSED_BYTES) {
        throw new TdSynnexSftpError(
          `${ap.name} expands to ${ap.size} bytes, over the ceiling`,
          'SFTP_FILE_TOO_LARGE'
        );
      }
      const buf = await zip.entryData(ap.name);
      // The flat file is plain ASCII/latin-1; latin1 avoids mangling the odd
      // high byte in a product description that utf8 would replace with U+FFFD.
      return { fileName: ap.name, content: buf.toString('latin1') };
    } catch (err) {
      if (err instanceof TdSynnexSftpError) throw err;
      throw new TdSynnexSftpError(
        `Could not read ${wanted} as a zip archive: ${err instanceof Error ? err.message : String(err)}`,
        'SFTP_ARCHIVE_INVALID'
      );
    } finally {
      await zip.close().catch(() => { /* ignore */ });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function toDbRow(partnerId: string, r: TdSynnexPriceRow, fileDate: string | null, syncedAt: Date) {
  // numeric columns take strings in drizzle-orm to avoid float drift.
  const money = (v: number | null) => (v === null ? null : String(v));
  return {
    partnerId,
    synnexSku: r.synnexSku,
    mfgPartNo: r.mfgPartNo,
    tdPartNo: r.tdPartNo,
    name: r.name,
    description: r.description,
    manufacturer: r.manufacturer,
    status: r.status,
    abcCode: r.abcCode,
    currency: r.currency,
    cost: money(r.cost),
    costWithoutPromo: money(r.costWithoutPromo),
    msrp: money(r.msrp),
    mapPrice: money(r.mapPrice),
    totalQty: r.totalQty,
    warehouses: r.warehouses,
    weight: money(r.weight),
    upc: r.upc,
    unspsc: r.unspsc,
    etaDate: r.etaDate,
    raw: r.raw,
    fileDate,
    syncedAt,
    updatedAt: syncedAt,
  };
}

async function upsertRows(
  partnerId: string,
  rows: TdSynnexPriceRow[],
  fileDate: string | null,
  syncedAt: Date
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE).map((r) => toDbRow(partnerId, r, fileDate, syncedAt));
    await withSystemDbAccessContext(() =>
      db.insert(tdSynnexPriceAvailability)
        .values(batch)
        .onConflictDoUpdate({
          target: [tdSynnexPriceAvailability.partnerId, tdSynnexPriceAvailability.synnexSku],
          set: {
            mfgPartNo: sql`excluded.mfg_part_no`,
            tdPartNo: sql`excluded.td_part_no`,
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            manufacturer: sql`excluded.manufacturer`,
            status: sql`excluded.status`,
            abcCode: sql`excluded.abc_code`,
            currency: sql`excluded.currency`,
            cost: sql`excluded.cost`,
            costWithoutPromo: sql`excluded.cost_without_promo`,
            msrp: sql`excluded.msrp`,
            mapPrice: sql`excluded.map_price`,
            totalQty: sql`excluded.total_qty`,
            warehouses: sql`excluded.warehouses`,
            weight: sql`excluded.weight`,
            upc: sql`excluded.upc`,
            unspsc: sql`excluded.unspsc`,
            etaDate: sql`excluded.eta_date`,
            raw: sql`excluded.raw`,
            fileDate: sql`excluded.file_date`,
            syncedAt: sql`excluded.synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
    );
    written += batch.length;
  }
  return written;
}

/**
 * After a FULL file (HDR qualifier 'C'), any row we did not just touch is no
 * longer in the distributor's catalog. Prune by syncedAt so a discontinued SKU
 * cannot linger and get quoted. Delta files ('U') carry only changed SKUs, so
 * pruning after one would wipe the entire catalog — hence the isFullFile gate.
 */
async function pruneStaleRows(partnerId: string, syncedAt: Date): Promise<number> {
  const deleted = await withSystemDbAccessContext(() =>
    db.delete(tdSynnexPriceAvailability)
      .where(and(
        eq(tdSynnexPriceAvailability.partnerId, partnerId),
        lt(tdSynnexPriceAvailability.syncedAt, syncedAt)
      ))
      .returning({ id: tdSynnexPriceAvailability.id })
  );
  return deleted.length;
}

export interface SftpSyncResult {
  integrationId: string;
  partnerId: string;
  fileName: string;
  fileDate: string | null;
  isFullFile: boolean;
  rowsWritten: number;
  rowsPruned: number;
  malformedRows: number;
}

/**
 * Run one partner's nightly ingest. Network + parse happen OUTSIDE any DB
 * context (a multi-minute download must never pin a pooled connection, #1105 /
 * #1697); writes re-enter a system context in batches.
 */
export async function syncSftpPriceFile(integrationId: string): Promise<SftpSyncResult> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(tdSynnexSftpIntegrations).where(eq(tdSynnexSftpIntegrations.id, integrationId))
  );
  const cfg = resolveConfig(row);
  if (!cfg.enabled) {
    throw new TdSynnexSftpError('TD SYNNEX SFTP integration is disabled', 'SFTP_DISABLED');
  }

  await withSystemDbAccessContext(() =>
    db.update(tdSynnexSftpIntegrations)
      .set({ lastSyncStatus: 'running', lastSyncError: null, updatedAt: new Date() })
      .where(eq(tdSynnexSftpIntegrations.id, cfg.id))
  );

  try {
    const { fileName, content } = await runOutsideDbContext(() => downloadAndExtract(cfg));
    const parsed = await runOutsideDbContext(async () =>
      parsePriceFile(content, { region: cfg.region as TdSynnexRegion })
    );

    const syncedAt = new Date();
    const rowsWritten = await upsertRows(cfg.partnerId, parsed.rows, parsed.header.fileDate, syncedAt);
    const rowsPruned = parsed.header.isFullFile
      ? await pruneStaleRows(cfg.partnerId, syncedAt)
      : 0;

    await withSystemDbAccessContext(() =>
      db.update(tdSynnexSftpIntegrations)
        .set({
          lastSyncStatus: 'ok',
          lastSyncAt: syncedAt,
          lastSyncError: null,
          lastFileName: fileName,
          lastRowCount: rowsWritten,
          updatedAt: syncedAt,
        })
        .where(eq(tdSynnexSftpIntegrations.id, cfg.id))
    );

    return {
      integrationId: cfg.id,
      partnerId: cfg.partnerId,
      fileName,
      fileDate: parsed.header.fileDate,
      isFullFile: parsed.header.isFullFile,
      rowsWritten,
      rowsPruned,
      malformedRows: parsed.malformed.length,
    };
  } catch (err) {
    const message = redactSecret(err instanceof Error ? err.message : String(err), cfg.password);
    await withSystemDbAccessContext(() =>
      db.update(tdSynnexSftpIntegrations)
        .set({
          lastSyncStatus: 'error',
          lastSyncAt: new Date(),
          lastSyncError: message,
          updatedAt: new Date(),
        })
        .where(eq(tdSynnexSftpIntegrations.id, cfg.id))
    );
    throw err instanceof TdSynnexSftpError ? err : new TdSynnexSftpError(message, 'SFTP_PROVIDER_ERROR');
  }
}
