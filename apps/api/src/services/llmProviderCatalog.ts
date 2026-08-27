import { and, asc, eq, inArray, max } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  llmProviderCatalog,
  llmProviderCatalogRevisions,
  llmProviderVerifications,
  type LlmProviderModelMap,
} from '../db/schema';
import { OFFERABLE_AI_MODELS } from './aiCostTracker';

export const CURRENT_HARNESS_VERSION = '1';

const CACHE_TTL_MS = 5 * 60 * 1000;
let listedProvidersCache: ListedProvider[] | null = null;
let listedProvidersCacheLoadedAt = 0;
let listedProvidersInflight: Promise<ListedProvider[]> | null = null;

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
  const unsupported = Object.keys(modelMap).filter(
    (modelId) => !OFFERABLE_AI_MODELS.includes(modelId),
  );
  if (unsupported.length > 0) {
    throw new LlmProviderCatalogError(
      `Unsupported catalog model ids: ${unsupported.join(', ')}`,
      400,
    );
  }
}

function validateBaseUrl(value: string): string {
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

  return baseUrl;
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

    const passingRows = await db
      .select({
        revisionId: llmProviderVerifications.revisionId,
        modelId: llmProviderVerifications.modelId,
      })
      .from(llmProviderVerifications)
      .where(and(
        inArray(llmProviderVerifications.revisionId, rows.map((row) => row.revisionId)),
        eq(llmProviderVerifications.harnessVersion, CURRENT_HARNESS_VERSION),
        eq(llmProviderVerifications.passed, true),
      ));

    const verifiedByRevision = new Map<string, Set<string>>();
    for (const row of passingRows) {
      const models = verifiedByRevision.get(row.revisionId) ?? new Set<string>();
      models.add(row.modelId);
      verifiedByRevision.set(row.revisionId, models);
    }

    return rows.map((row) => ({
      ...row,
      verifiedModels: [...(verifiedByRevision.get(row.revisionId) ?? [])].sort(),
    }));
  });
}

export async function getListedProviders(): Promise<ListedProvider[]> {
  if (
    listedProvidersCache
    && Date.now() - listedProvidersCacheLoadedAt <= CACHE_TTL_MS
  ) {
    return listedProvidersCache;
  }

  if (!listedProvidersInflight) {
    listedProvidersInflight = loadListedProviders()
      .then((providers) => {
        listedProvidersCache = providers;
        listedProvidersCacheLoadedAt = Date.now();
        return providers;
      })
      .finally(() => {
        listedProvidersInflight = null;
      });
  }

  return listedProvidersInflight;
}

export async function getListedProviderByEntryId(entryId: string): Promise<ListedProvider | null> {
  const providers = await getListedProviders();
  return providers.find((provider) => provider.entryId === entryId) ?? null;
}

export function invalidateLlmProviderCatalogCache(): void {
  listedProvidersCache = null;
  listedProvidersCacheLoadedAt = 0;
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
  const baseUrl = validateBaseUrl(input.baseUrl);

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
    .select({ modelId: llmProviderVerifications.modelId })
    .from(llmProviderVerifications)
    .where(and(
      eq(llmProviderVerifications.revisionId, revisionId),
      eq(llmProviderVerifications.harnessVersion, CURRENT_HARNESS_VERSION),
      eq(llmProviderVerifications.passed, true),
    ));
  return new Set(rows.map((row) => row.modelId));
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
          const verifiedModels = new Set(
            revisionVerifications
              .filter((verification) => (
                verification.harnessVersion === CURRENT_HARNESS_VERSION
                && verification.passed
              ))
              .map((verification) => verification.modelId),
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
