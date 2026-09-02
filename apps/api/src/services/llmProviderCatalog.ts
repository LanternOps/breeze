import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  llmProviderCatalog,
  llmProviderCatalogRevisions,
  llmProviderVerifications,
  type LlmProviderModelMap,
} from '../db/schema';
import { OFFERABLE_AI_MODELS } from './aiCostTracker';
import { assertSafeUrl } from './urlSafety';
import { FIDELITY_HARNESS_VERSION } from './llm/providerFidelityHarness';

/**
 * Activation/listing gates read this; the harness stamps it onto every
 * verification record. Sourced from the harness itself so a harness bump
 * automatically invalidates every prior pass instead of silently keeping
 * revisions activatable on stale verifications.
 */
export const CURRENT_HARNESS_VERSION = FIDELITY_HARNESS_VERSION;

const CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounded so a pathological invalidation storm cannot spin here forever. */
const MAX_CACHE_LOAD_ATTEMPTS = 3;

interface InflightListedRead {
  /** The invalidation epoch this read started at. */
  epoch: number;
  promise: Promise<ListedProvider[]>;
}

let listedProvidersCache: ListedProvider[] | null = null;
let listedProvidersCacheLoadedAt = 0;
let listedProvidersInflight: InflightListedRead | null = null;
/**
 * Bumped by every invalidation. A read that started before the bump saw
 * pre-mutation rows, so neither its result nor a cache entry derived from it
 * may survive — otherwise a delisting that lands mid-read is undone for a
 * further full TTL, breaking the fail-closed-on-delisting invariant.
 */
let listedProvidersCacheEpoch = 0;

export class LlmProviderCatalogError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'LlmProviderCatalogError';
  }
}

export interface ListedProvider {
  entryId: string;
  slug: string;
  name: string;
  revisionId: string;
  revision: number;
  baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  modelMap: LlmProviderModelMap;
  dataNote: string | null;
  verifiedModels: string[];
}

export interface AdminVerificationSummary {
  modelId: string;
  harnessVersion: string;
  passed: boolean;
  detail: Record<string, unknown> | null;
  verifiedBy: string | null;
  verifiedAt: Date;
}

export interface AdminCatalogRevision {
  revisionId: string;
  revision: number;
  baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  modelMap: LlmProviderModelMap;
  dataNote: string | null;
  createdBy: string | null;
  createdAt: Date;
  verifiedModels: string[];
  verifications: AdminVerificationSummary[];
}

export interface AdminCatalogEntry {
  entryId: string;
  slug: string;
  name: string;
  status: 'draft' | 'listed' | 'delisted';
  activeRevisionId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  revisions: AdminCatalogRevision[];
}

export interface CatalogRevisionLookup {
  revisionId: string;
  entryId: string;
  baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  modelMap: LlmProviderModelMap;
}

function assertOfferableModelMap(modelMap: LlmProviderModelMap): void {
  const modelIds = Object.keys(modelMap);
  // An empty map trivially satisfies the "every mapped model is verified" gate,
  // so a revision with no models could be created, activated and listed having
  // never passed a single fidelity check.
  if (modelIds.length === 0) {
    throw new LlmProviderCatalogError(
      'A catalog revision must map at least one model.',
      400,
    );
  }
  const unsupported = modelIds.filter(
    (modelId) => !OFFERABLE_AI_MODELS.includes(modelId),
  );
  if (unsupported.length > 0) {
    throw new LlmProviderCatalogError(
      `Unsupported catalog model ids: ${unsupported.join(', ')}`,
      400,
    );
  }
}

/**
 * Shape checks plus an SSRF policy check on where the host actually resolves.
 *
 * The base URL is handed verbatim to an `Anthropic` client that makes real
 * outbound requests from the API (the MFA-gated `/verify` route), so a URL
 * pointing at loopback, RFC1918, link-local or cloud-metadata space would turn
 * that route into an internal-service reader. `assertSafeUrl` rejects IP
 * literals in blocked ranges without any DNS work and rejects hostnames whose
 * every record is blocked. It is a policy gate at authoring time, NOT the
 * rebinding pin — connect-time pinning is what the guarded fetch in the harness
 * provides for the request that actually leaves the box.
 */
async function validateBaseUrl(value: string): Promise<string> {
  const baseUrl = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new LlmProviderCatalogError('Base URL must be a valid HTTPS URL.', 400);
  }

  if (
    parsed.protocol !== 'https:'
    || !parsed.hostname
    || parsed.username !== ''
    || parsed.password !== ''
    || baseUrl.includes('?')
    || baseUrl.includes('#')
  ) {
    throw new LlmProviderCatalogError(
      'Base URL must use HTTPS and cannot contain credentials, a query, or a fragment.',
      400,
    );
  }

  try {
    await assertSafeUrl(baseUrl);
  } catch (error) {
    throw new LlmProviderCatalogError(
      `Base URL host is not a permitted egress target: ${
        error instanceof Error ? error.message : 'blocked address'
      }`,
      400,
    );
  }

  return baseUrl;
}

interface VerificationAttempt {
  modelId: string;
  passed: boolean;
  createdAt: Date;
}

/**
 * Latest attempt wins.
 *
 * A model counts as verified only when the MOST RECENT attempt for
 * (revision, model, current harness version) passed. Treating any historical
 * pass as sufficient means a later failure — a provider that broke tool-calling
 * after being vetted — can never revoke it, and the revision stays activatable
 * and listable as "verified". Ties resolve to the failure (fail closed).
 */
function latestPassingModels(rows: readonly VerificationAttempt[]): Set<string> {
  const latest = new Map<string, VerificationAttempt>();
  for (const row of rows) {
    const seen = latest.get(row.modelId);
    if (!seen) {
      latest.set(row.modelId, row);
      continue;
    }
    const rowAt = row.createdAt.getTime();
    const seenAt = seen.createdAt.getTime();
    if (rowAt > seenAt || (rowAt === seenAt && !row.passed)) {
      latest.set(row.modelId, row);
    }
  }
  return new Set(
    [...latest.values()].filter((row) => row.passed).map((row) => row.modelId),
  );
}

async function loadListedProviders(): Promise<ListedProvider[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({
        entryId: llmProviderCatalog.id,
        slug: llmProviderCatalog.slug,
        name: llmProviderCatalog.name,
        revisionId: llmProviderCatalogRevisions.id,
        revision: llmProviderCatalogRevisions.revision,
        baseUrl: llmProviderCatalogRevisions.baseUrl,
        authMode: llmProviderCatalogRevisions.authMode,
        modelMap: llmProviderCatalogRevisions.modelMap,
        dataNote: llmProviderCatalogRevisions.dataNote,
      })
      .from(llmProviderCatalog)
      .innerJoin(
        llmProviderCatalogRevisions,
        eq(llmProviderCatalog.activeRevisionId, llmProviderCatalogRevisions.id),
      )
      .where(eq(llmProviderCatalog.status, 'listed'))
      .orderBy(asc(llmProviderCatalog.name));

    if (rows.length === 0) return [];

    // Every attempt (not just the passing ones) — the verdict is the LATEST
    // attempt per model, so a newer failure has to be visible here to beat an
    // older pass.
    const attemptRows = await db
      .select({
        revisionId: llmProviderVerifications.revisionId,
        modelId: llmProviderVerifications.modelId,
        passed: llmProviderVerifications.passed,
        createdAt: llmProviderVerifications.createdAt,
      })
      .from(llmProviderVerifications)
      .where(and(
        inArray(llmProviderVerifications.revisionId, rows.map((row) => row.revisionId)),
        eq(llmProviderVerifications.harnessVersion, CURRENT_HARNESS_VERSION),
      ))
      .orderBy(desc(llmProviderVerifications.createdAt));

    const attemptsByRevision = new Map<string, VerificationAttempt[]>();
    for (const row of attemptRows) {
      const attempts = attemptsByRevision.get(row.revisionId) ?? [];
      attempts.push(row);
      attemptsByRevision.set(row.revisionId, attempts);
    }

    return rows.map((row) => ({
      ...row,
      verifiedModels: [
        ...latestPassingModels(attemptsByRevision.get(row.revisionId) ?? []),
      ].sort(),
    }));
  });
}

export async function getListedProviders(): Promise<ListedProvider[]> {
  for (let attempt = 0; attempt < MAX_CACHE_LOAD_ATTEMPTS; attempt += 1) {
    if (
      listedProvidersCache
      && Date.now() - listedProvidersCacheLoadedAt <= CACHE_TTL_MS
    ) {
      return listedProvidersCache;
    }

    if (!listedProvidersInflight) {
      const epoch = listedProvidersCacheEpoch;
      const promise = loadListedProviders().then((providers) => {
        if (listedProvidersCacheEpoch === epoch) {
          listedProvidersCache = providers;
          listedProvidersCacheLoadedAt = Date.now();
        }
        return providers;
      });
      const entry: InflightListedRead = { epoch, promise };
      listedProvidersInflight = entry;
      void promise.catch(() => undefined).then(() => {
        // Identity-checked: an invalidation may already have replaced this
        // handle, and clearing a NEWER read's handle would re-stampede the DB.
        if (listedProvidersInflight === entry) listedProvidersInflight = null;
      });
    }

    const entry = listedProvidersInflight;
    const providers = await entry.promise;
    if (listedProvidersCacheEpoch === entry.epoch) return providers;
    // A mutation landed mid-read: these rows predate it. Try again.
  }

  return loadListedProviders();
}

export async function getListedProviderByEntryId(entryId: string): Promise<ListedProvider | null> {
  const providers = await getListedProviders();
  return providers.find((provider) => provider.entryId === entryId) ?? null;
}

/**
 * Raw name lookup by id, independent of listing status (#3922 W4). Usage
 * provenance ("billed to your key via <name>") must still resolve a name
 * after an entry is delisted — {@link getListedProviderByEntryId} would go
 * null the moment that happens, which is correct for selection but wrong for
 * historical display.
 */
export async function getCatalogEntryName(entryId: string): Promise<string | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ name: llmProviderCatalog.name })
      .from(llmProviderCatalog)
      .where(eq(llmProviderCatalog.id, entryId))
      .limit(1);
    return row?.name ?? null;
  });
}

export function invalidateLlmProviderCatalogCache(): void {
  listedProvidersCache = null;
  listedProvidersCacheLoadedAt = 0;
  // Both halves matter: dropping only the cache leaves an in-flight read free
  // to repopulate it with pre-mutation rows under a fresh TTL.
  listedProvidersCacheEpoch += 1;
  listedProvidersInflight = null;
}

export async function createCatalogEntry(input: {
  slug: string;
  name: string;
  notes?: string;
}): Promise<{ id: string }> {
  const result = await withSystemDbAccessContext(async () => {
    const [created] = await db
      .insert(llmProviderCatalog)
      .values({
        slug: input.slug,
        name: input.name,
        notes: input.notes ?? null,
      })
      .returning({ id: llmProviderCatalog.id });
    if (!created) {
      throw new LlmProviderCatalogError('Could not create catalog entry.', 409);
    }
    return created;
  });
  invalidateLlmProviderCatalogCache();
  return result;
}

export async function createRevision(input: {
  entryId: string;
  baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  modelMap: LlmProviderModelMap;
  dataNote?: string;
  createdBy: string;
}): Promise<{ id: string; revision: number }> {
  assertOfferableModelMap(input.modelMap);
  const baseUrl = await validateBaseUrl(input.baseUrl);

  const result = await withSystemDbAccessContext(async () => {
    const [revisionState] = await db
      .select({ maxRevision: max(llmProviderCatalogRevisions.revision) })
      .from(llmProviderCatalogRevisions)
      .where(eq(llmProviderCatalogRevisions.catalogEntryId, input.entryId));
    const revision = Number(revisionState?.maxRevision ?? 0) + 1;

    const [created] = await db
      .insert(llmProviderCatalogRevisions)
      .values({
        catalogEntryId: input.entryId,
        revision,
        baseUrl,
        authMode: input.authMode,
        modelMap: input.modelMap,
        dataNote: input.dataNote ?? null,
        createdBy: input.createdBy,
      })
      .returning({
        id: llmProviderCatalogRevisions.id,
        revision: llmProviderCatalogRevisions.revision,
      });
    if (!created) {
      throw new LlmProviderCatalogError('Could not create catalog revision.', 409);
    }
    return created;
  });
  invalidateLlmProviderCatalogCache();
  return result;
}

async function getVerifiedModelsForRevision(revisionId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      modelId: llmProviderVerifications.modelId,
      passed: llmProviderVerifications.passed,
      createdAt: llmProviderVerifications.createdAt,
    })
    .from(llmProviderVerifications)
    .where(and(
      eq(llmProviderVerifications.revisionId, revisionId),
      eq(llmProviderVerifications.harnessVersion, CURRENT_HARNESS_VERSION),
    ))
    .orderBy(desc(llmProviderVerifications.createdAt));
  return latestPassingModels(rows);
}

function assertAllModelsVerified(modelMap: LlmProviderModelMap, verifiedModels: Set<string>): void {
  const missing = Object.keys(modelMap).filter((modelId) => !verifiedModels.has(modelId));
  if (missing.length > 0) {
    throw new LlmProviderCatalogError(
      `Revision lacks passing harness ${CURRENT_HARNESS_VERSION} verification for: ${missing.join(', ')}`,
      409,
    );
  }
}

export async function activateRevision(input: {
  entryId: string;
  revisionId: string;
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [revision] = await db
      .select({
        id: llmProviderCatalogRevisions.id,
        catalogEntryId: llmProviderCatalogRevisions.catalogEntryId,
        modelMap: llmProviderCatalogRevisions.modelMap,
      })
      .from(llmProviderCatalogRevisions)
      .where(and(
        eq(llmProviderCatalogRevisions.id, input.revisionId),
        eq(llmProviderCatalogRevisions.catalogEntryId, input.entryId),
      ))
      .limit(1);
    if (!revision) {
      throw new LlmProviderCatalogError('Catalog revision not found.', 404);
    }

    assertAllModelsVerified(
      revision.modelMap,
      await getVerifiedModelsForRevision(revision.id),
    );

    const [updated] = await db
      .update(llmProviderCatalog)
      .set({ activeRevisionId: revision.id, updatedAt: new Date() })
      .where(eq(llmProviderCatalog.id, input.entryId))
      .returning({ id: llmProviderCatalog.id });
    if (!updated) {
      throw new LlmProviderCatalogError('Catalog entry not found.', 404);
    }
  });
  invalidateLlmProviderCatalogCache();
}

export async function setEntryStatus(input: {
  entryId: string;
  status: 'draft' | 'listed' | 'delisted';
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    if (input.status === 'listed') {
      const [entry] = await db
        .select({
          id: llmProviderCatalog.id,
          activeRevisionId: llmProviderCatalog.activeRevisionId,
        })
        .from(llmProviderCatalog)
        .where(eq(llmProviderCatalog.id, input.entryId))
        .limit(1);
      if (!entry) {
        throw new LlmProviderCatalogError('Catalog entry not found.', 404);
      }
      if (!entry.activeRevisionId) {
        throw new LlmProviderCatalogError(
          'A verified active revision is required before listing this entry.',
          409,
        );
      }

      const [revision] = await db
        .select({ modelMap: llmProviderCatalogRevisions.modelMap })
        .from(llmProviderCatalogRevisions)
        .where(and(
          eq(llmProviderCatalogRevisions.id, entry.activeRevisionId),
          eq(llmProviderCatalogRevisions.catalogEntryId, input.entryId),
        ))
        .limit(1);
      if (!revision) {
        throw new LlmProviderCatalogError('Active catalog revision not found.', 409);
      }
      assertAllModelsVerified(
        revision.modelMap,
        await getVerifiedModelsForRevision(entry.activeRevisionId),
      );
    }

    const [updated] = await db
      .update(llmProviderCatalog)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(llmProviderCatalog.id, input.entryId))
      .returning({ id: llmProviderCatalog.id });
    if (!updated) {
      throw new LlmProviderCatalogError('Catalog entry not found.', 404);
    }
  });
  invalidateLlmProviderCatalogCache();
}

export async function recordVerification(input: {
  revisionId: string;
  modelId: string;
  passed: boolean;
  detail?: Record<string, unknown>;
  verifiedBy: string;
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db
      .insert(llmProviderVerifications)
      .values({
        revisionId: input.revisionId,
        modelId: input.modelId,
        harnessVersion: CURRENT_HARNESS_VERSION,
        passed: input.passed,
        detail: input.detail ?? null,
        verifiedBy: input.verifiedBy,
      });
  });
  invalidateLlmProviderCatalogCache();
}

export async function getAllCatalogEntriesForAdmin(): Promise<AdminCatalogEntry[]> {
  return withSystemDbAccessContext(async () => {
    const entries = await db
      .select({
        entryId: llmProviderCatalog.id,
        slug: llmProviderCatalog.slug,
        name: llmProviderCatalog.name,
        status: llmProviderCatalog.status,
        activeRevisionId: llmProviderCatalog.activeRevisionId,
        notes: llmProviderCatalog.notes,
        createdAt: llmProviderCatalog.createdAt,
        updatedAt: llmProviderCatalog.updatedAt,
      })
      .from(llmProviderCatalog)
      .orderBy(asc(llmProviderCatalog.name));

    const revisions = await db
      .select({
        revisionId: llmProviderCatalogRevisions.id,
        entryId: llmProviderCatalogRevisions.catalogEntryId,
        revision: llmProviderCatalogRevisions.revision,
        baseUrl: llmProviderCatalogRevisions.baseUrl,
        authMode: llmProviderCatalogRevisions.authMode,
        modelMap: llmProviderCatalogRevisions.modelMap,
        dataNote: llmProviderCatalogRevisions.dataNote,
        createdBy: llmProviderCatalogRevisions.createdBy,
        createdAt: llmProviderCatalogRevisions.createdAt,
      })
      .from(llmProviderCatalogRevisions)
      .orderBy(
        asc(llmProviderCatalogRevisions.catalogEntryId),
        asc(llmProviderCatalogRevisions.revision),
      );

    const verifications = await db
      .select({
        revisionId: llmProviderVerifications.revisionId,
        modelId: llmProviderVerifications.modelId,
        harnessVersion: llmProviderVerifications.harnessVersion,
        passed: llmProviderVerifications.passed,
        detail: llmProviderVerifications.detail,
        verifiedBy: llmProviderVerifications.verifiedBy,
        verifiedAt: llmProviderVerifications.createdAt,
      })
      .from(llmProviderVerifications)
      .orderBy(
        asc(llmProviderVerifications.revisionId),
        asc(llmProviderVerifications.modelId),
        asc(llmProviderVerifications.createdAt),
      );

    return entries.map((entry) => ({
      ...entry,
      revisions: revisions
        .filter((revision) => revision.entryId === entry.entryId)
        .map(({ entryId: _entryId, ...revision }) => {
          const revisionVerifications = verifications
            .filter((verification) => verification.revisionId === revision.revisionId)
            .map(({ revisionId: _revisionId, ...verification }) => verification);
          const verifiedModels = latestPassingModels(
            revisionVerifications
              .filter((verification) => (
                verification.harnessVersion === CURRENT_HARNESS_VERSION
              ))
              .map((verification) => ({
                modelId: verification.modelId,
                passed: verification.passed,
                createdAt: verification.verifiedAt,
              })),
          );
          return {
            ...revision,
            verifiedModels: [...verifiedModels].sort(),
            verifications: revisionVerifications,
          };
        }),
    }));
  });
}

export async function getCatalogRevisionById(
  revisionId: string,
): Promise<CatalogRevisionLookup | null> {
  return withSystemDbAccessContext(async () => {
    const [revision] = await db
      .select({
        revisionId: llmProviderCatalogRevisions.id,
        entryId: llmProviderCatalogRevisions.catalogEntryId,
        baseUrl: llmProviderCatalogRevisions.baseUrl,
        authMode: llmProviderCatalogRevisions.authMode,
        modelMap: llmProviderCatalogRevisions.modelMap,
      })
      .from(llmProviderCatalogRevisions)
      .where(eq(llmProviderCatalogRevisions.id, revisionId))
      .limit(1);
    return revision ?? null;
  });
}
