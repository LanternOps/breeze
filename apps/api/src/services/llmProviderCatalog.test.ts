/**
 * Drizzle-mock note: `where()` CAPTURES its condition so the tests can render
 * it through a real `PgDialect` and assert the emitted predicate + params.
 * A builder that stubs `.where()` as an identity function asserts nothing —
 * deleting the WHERE clause from the service leaves such a suite green, which
 * is exactly how the verification-gating filters shipped unasserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_REVISION_ID = '55555555-5555-4555-8555-555555555555';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const { dbState, withSystemDbAccessContextMock, assertSafeUrlMock } = vi.hoisted(() => ({
  assertSafeUrlMock: vi.fn(async () => undefined),
  dbState: {
    selectResults: [] as unknown[][],
    insertResults: [] as unknown[][],
    updateResults: [] as unknown[][],
    insertedValues: [] as Array<Record<string, unknown>>,
    updateSets: [] as Array<Record<string, unknown>>,
    selectWheres: [] as unknown[],
    gate: null as Promise<void> | null,
  },
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const dialect = new PgDialect();
const renderSql = (condition: unknown) => dialect.sqlToQuery(condition as SQL);

function queuedSelectBuilder() {
  const resolveNext = async () => {
    if (dbState.gate) await dbState.gate;
    return dbState.selectResults.shift() ?? [];
  };
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  builder.innerJoin = vi.fn(() => builder);
  builder.where = vi.fn((condition: unknown) => {
    dbState.selectWheres.push(condition);
    return builder;
  });
  builder.orderBy = vi.fn(() => builder);
  builder.limit = vi.fn(resolveNext);
  builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    resolveNext().then(resolve, reject);
  return builder;
}

function queuedInsertBuilder(values: Record<string, unknown>) {
  dbState.insertedValues.push(values);
  const resolveNext = () => Promise.resolve(dbState.insertResults.shift() ?? []);
  return {
    returning: vi.fn(resolveNext),
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      resolveNext().then(resolve, reject),
  };
}

function queuedUpdateBuilder(values: Record<string, unknown>) {
  dbState.updateSets.push(values);
  const resolveNext = () => Promise.resolve(dbState.updateResults.shift() ?? []);
  const builder: Record<string, unknown> = {};
  builder.where = vi.fn(() => builder);
  builder.returning = vi.fn(resolveNext);
  builder.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
    resolveNext().then(resolve, reject);
  return builder;
}

vi.mock('../db', () => ({
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  db: {
    select: vi.fn(() => queuedSelectBuilder()),
    insert: vi.fn(() => ({ values: vi.fn(queuedInsertBuilder) })),
    update: vi.fn(() => ({ set: vi.fn(queuedUpdateBuilder) })),
  },
}));

vi.mock('./urlSafety', () => ({
  assertSafeUrl: assertSafeUrlMock,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

vi.mock('./aiCostTracker', () => ({
  OFFERABLE_AI_MODELS: Object.freeze([
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-fable-5',
  ]),
}));

import { db, withSystemDbAccessContext } from '../db';
import {
  CURRENT_HARNESS_VERSION,
  activateRevision,
  createCatalogEntry,
  createRevision,
  getAllCatalogEntriesForAdmin,
  getCatalogEntryName,
  getCatalogRevisionById,
  getListedProviders,
  invalidateLlmProviderCatalogCache,
  recordVerification,
  setEntryStatus,
} from './llmProviderCatalog';

const modelMap = {
  'claude-sonnet-4-6': {
    providerModel: 'provider/sonnet',
    inputCentsPerM: 300,
    outputCentsPerM: 1500,
    cacheReadCentsPerM: 30,
    cacheWriteCentsPerM: 375,
  },
  'claude-haiku-4-5': {
    providerModel: 'provider/haiku',
    inputCentsPerM: 100,
    outputCentsPerM: 500,
    cacheReadCentsPerM: 10,
    cacheWriteCentsPerM: 125,
  },
};

const T0 = new Date('2026-08-25T10:00:00Z');
const T1 = new Date('2026-08-25T11:00:00Z');

function queueListedRead() {
  dbState.selectResults.push(
    [{
      entryId: ENTRY_ID,
      slug: 'example',
      name: 'Example',
      revisionId: REVISION_ID,
      revision: 1,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap,
      dataNote: null,
    }],
    [{ revisionId: REVISION_ID, modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults.length = 0;
  dbState.insertResults.length = 0;
  dbState.updateResults.length = 0;
  dbState.insertedValues.length = 0;
  dbState.updateSets.length = 0;
  dbState.selectWheres.length = 0;
  dbState.gate = null;
  invalidateLlmProviderCatalogCache();
});

describe('LLM provider catalog service', () => {
  it('assigns max(existing revision) + 1 per catalog entry', async () => {
    dbState.selectResults.push([{ maxRevision: 4 }]);
    dbState.insertResults.push([{ id: REVISION_ID, revision: 5 }]);

    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap,
      createdBy: ADMIN_ID,
    })).resolves.toEqual({ id: REVISION_ID, revision: 5 });

    expect(dbState.insertedValues[0]).toMatchObject({
      catalogEntryId: ENTRY_ID,
      revision: 5,
      baseUrl: 'https://llm.example.test/v1',
      modelMap,
      createdBy: ADMIN_ID,
    });
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('blocks activation when any mapped model lacks a passing current-harness verification', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [{ modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 }],
    );

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .rejects.toThrow(/claude-haiku-4-5/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('activates a revision when every mapped model has a passing current-harness verification', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .resolves.toBeUndefined();
    expect(dbState.updateSets[0]).toMatchObject({ activeRevisionId: REVISION_ID });
  });

  it('scopes the activation gate query to this revision at the current harness version', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID });

    const gate = renderSql(dbState.selectWheres[1]);
    expect(gate.sql).toContain('"llm_provider_verifications"."revision_id" = $');
    expect(gate.sql).toContain('"llm_provider_verifications"."harness_version" = $');
    expect(gate.params).toEqual([REVISION_ID, CURRENT_HARNESS_VERSION]);
  });

  it('revokes an earlier pass when the latest attempt for that model failed', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [
        // A newer FAILING attempt must beat the older pass for the same model.
        { modelId: 'claude-sonnet-4-6', passed: false, createdAt: T1 },
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .rejects.toThrow(/claude-sonnet-4-6/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('re-verifies a model whose latest attempt passed after an earlier failure', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T1 },
        { modelId: 'claude-sonnet-4-6', passed: false, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .resolves.toBeUndefined();
  });

  it('blocks listing an entry without an active revision', async () => {
    dbState.selectResults.push([{ id: ENTRY_ID, activeRevisionId: null }]);

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'listed' }))
      .rejects.toThrow(/active revision/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('invalidates cached listed-provider reads after a mutation', async () => {
    queueListedRead();
    const first = await getListedProviders();
    const selectCallsAfterFirstRead = vi.mocked(db.select).mock.calls.length;
    expect(await getListedProviders()).toBe(first);
    expect(db.select).toHaveBeenCalledTimes(selectCallsAfterFirstRead);

    dbState.insertResults.push([{ id: ENTRY_ID }]);
    await createCatalogEntry({ slug: 'new-provider', name: 'New Provider' });

    queueListedRead();
    await getListedProviders();
    expect(db.select).toHaveBeenCalledTimes(selectCallsAfterFirstRead * 2);
  });

  it('reads only listed entries and current-harness verifications for those revisions', async () => {
    queueListedRead();
    await getListedProviders();

    const entries = renderSql(dbState.selectWheres[0]);
    expect(entries.sql).toContain('"llm_provider_catalog"."status" = $');
    expect(entries.params).toEqual(['listed']);

    const verifications = renderSql(dbState.selectWheres[1]);
    expect(verifications.sql).toContain('"llm_provider_verifications"."revision_id" in (');
    expect(verifications.sql).toContain('"llm_provider_verifications"."harness_version" = $');
    expect(verifications.params).toEqual([REVISION_ID, CURRENT_HARNESS_VERSION]);
  });

  it('drops a model from verifiedModels when its latest attempt for that revision failed', async () => {
    dbState.selectResults.push(
      [{
        entryId: ENTRY_ID,
        slug: 'example',
        name: 'Example',
        revisionId: REVISION_ID,
        revision: 1,
        baseUrl: 'https://llm.example.test/v1',
        authMode: 'bearer',
        modelMap,
        dataNote: null,
      }],
      [
        { revisionId: REVISION_ID, modelId: 'claude-sonnet-4-6', passed: false, createdAt: T1 },
        { revisionId: REVISION_ID, modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { revisionId: REVISION_ID, modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
        // Same model id under a DIFFERENT revision must not leak across.
        { revisionId: OTHER_REVISION_ID, modelId: 'claude-sonnet-4-6', passed: true, createdAt: T1 },
      ],
    );

    const [provider] = await getListedProviders();
    expect(provider?.verifiedModels).toEqual(['claude-haiku-4-5']);
  });

  it('discards an in-flight listed-provider read that a mutation invalidated mid-flight', async () => {
    let release!: () => void;
    dbState.gate = new Promise<void>((resolve) => { release = resolve; });
    // The gated read is queued the PRE-mutation rows: it will genuinely see the
    // entry as listed. Emptying the queue instead would make this pass with the
    // epoch check deleted, because the stale read would return [] on its own.
    queueListedRead();

    const inflight = getListedProviders();
    // The delisting lands while that read is still on the wire.
    invalidateLlmProviderCatalogCache();
    // Appended AFTER the pre-mutation rows, so the parked read still consumes
    // those and only the post-invalidation retry sees the delisted world.
    dbState.selectResults.push([]);
    dbState.gate = null;
    release();

    // Neither the caller's own result nor the cache may carry rows that predate
    // the delisting — returning them would keep a revoked provider offerable.
    await expect(inflight).resolves.toEqual([]);
    expect(await getListedProviders()).toEqual([]);
  });

  it('lists an entry whose active revision has every mapped model verified', async () => {
    dbState.selectResults.push(
      [{ id: ENTRY_ID, activeRevisionId: REVISION_ID }],
      [{ modelMap }],
      [
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'listed' }))
      .resolves.toBeUndefined();
    expect(dbState.updateSets[0]).toMatchObject({ status: 'listed' });

    // The active revision must be re-read scoped to THIS entry: an activeRevisionId
    // pointing at another entry's revision would otherwise be gated against that
    // revision's verifications.
    const revisionLookup = renderSql(dbState.selectWheres[1]);
    expect(revisionLookup.sql).toContain('"llm_provider_catalog_revisions"."id" = $');
    expect(revisionLookup.sql).toContain('"llm_provider_catalog_revisions"."catalog_entry_id" = $');
    expect(revisionLookup.params).toEqual([REVISION_ID, ENTRY_ID]);

    // Listing re-runs the SAME verification gate activation uses, at the current
    // harness version — a pass banked under an older harness must not list.
    const gate = renderSql(dbState.selectWheres[2]);
    expect(gate.sql).toContain('"llm_provider_verifications"."revision_id" = $');
    expect(gate.sql).toContain('"llm_provider_verifications"."harness_version" = $');
    expect(gate.params).toEqual([REVISION_ID, CURRENT_HARNESS_VERSION]);
  });

  it('blocks listing when the active revision has a model with no passing verification', async () => {
    dbState.selectResults.push(
      [{ id: ENTRY_ID, activeRevisionId: REVISION_ID }],
      [{ modelMap }],
      [{ modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 }],
    );

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'listed' }))
      .rejects.toThrow(/claude-haiku-4-5/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('blocks listing when the latest attempt for a mapped model failed', async () => {
    dbState.selectResults.push(
      [{ id: ENTRY_ID, activeRevisionId: REVISION_ID }],
      [{ modelMap }],
      [
        // A revocation banked after activation must also stop a later listing —
        // the entry could have been activated while it still passed.
        { modelId: 'claude-sonnet-4-6', passed: false, createdAt: T1 },
        { modelId: 'claude-sonnet-4-6', passed: true, createdAt: T0 },
        { modelId: 'claude-haiku-4-5', passed: true, createdAt: T0 },
      ],
    );

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'listed' }))
      .rejects.toThrow(/claude-sonnet-4-6/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses to list an entry whose activeRevisionId resolves to no revision row', async () => {
    dbState.selectResults.push(
      [{ id: ENTRY_ID, activeRevisionId: REVISION_ID }],
      // Orphaned pointer (revision deleted, or belonging to another entry).
      [],
    );

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'listed' }))
      .rejects.toMatchObject({
        message: expect.stringMatching(/active catalog revision not found/i),
        status: 409,
      });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not run the verification gate when delisting', async () => {
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await expect(setEntryStatus({ entryId: ENTRY_ID, status: 'delisted' }))
      .resolves.toBeUndefined();
    // Delisting is the fail-safe direction; it must never be blocked by a
    // revision that can no longer be verified.
    expect(db.select).not.toHaveBeenCalled();
    expect(dbState.updateSets[0]).toMatchObject({ status: 'delisted' });
  });

  it('rejects an empty model map before writing', async () => {
    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap: {},
      createdBy: ADMIN_ID,
    })).rejects.toThrow(/at least one model/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a base URL whose host resolves only to private addresses', async () => {
    assertSafeUrlMock.mockRejectedValueOnce(
      new Error('all resolved IPs for metadata.internal are private/loopback/link-local'),
    );

    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl: 'https://metadata.internal/v1',
      authMode: 'bearer',
      modelMap,
      createdBy: ADMIN_ID,
    })).rejects.toThrow(/private|blocked|reachable/i);
    expect(db.insert).not.toHaveBeenCalled();
    expect(assertSafeUrlMock).toHaveBeenCalledWith('https://metadata.internal/v1');
  });

  it('rejects model-map keys outside OFFERABLE_AI_MODELS before writing', async () => {
    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'x-api-key',
      modelMap: {
        ...modelMap,
        'not-an-offerable-model': modelMap['claude-haiku-4-5'],
      },
      createdBy: ADMIN_ID,
    })).rejects.toThrow(/not-an-offerable-model/);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    'http://llm.example.test/v1',
    'https://llm.example.test/v1?region=us',
    'https://llm.example.test/v1#models',
    'https://user:pass@llm.example.test/v1',
  ])('rejects unsafe base URL %s', async (baseUrl) => {
    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl,
      authMode: 'bearer',
      modelMap,
      createdBy: ADMIN_ID,
    })).rejects.toThrow(/base URL/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('records the current harness version and invalidates the read cache', async () => {
    dbState.insertResults.push([]);
    await recordVerification({
      revisionId: REVISION_ID,
      modelId: 'claude-sonnet-4-6',
      passed: true,
      detail: { steps: [] },
      verifiedBy: ADMIN_ID,
    });

    expect(dbState.insertedValues[0]).toMatchObject({
      revisionId: REVISION_ID,
      modelId: 'claude-sonnet-4-6',
      harnessVersion: CURRENT_HARNESS_VERSION,
      passed: true,
      verifiedBy: ADMIN_ID,
    });
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('composes every entry with its revisions and verification summaries for admins', async () => {
    const createdAt = new Date('2026-08-25T12:00:00Z');
    dbState.selectResults.push(
      [{
        entryId: ENTRY_ID,
        slug: 'example',
        name: 'Example',
        status: 'draft',
        activeRevisionId: null,
        notes: null,
        createdAt,
        updatedAt: createdAt,
      }],
      [{
        revisionId: REVISION_ID,
        entryId: ENTRY_ID,
        revision: 1,
        baseUrl: 'https://llm.example.test/v1',
        authMode: 'bearer',
        modelMap,
        dataNote: null,
        createdBy: ADMIN_ID,
        createdAt,
      }],
      [{
        revisionId: REVISION_ID,
        modelId: 'claude-sonnet-4-6',
        harnessVersion: CURRENT_HARNESS_VERSION,
        passed: true,
        detail: { steps: [] },
        verifiedBy: ADMIN_ID,
        verifiedAt: createdAt,
      }],
    );

    await expect(getAllCatalogEntriesForAdmin()).resolves.toEqual([{
      entryId: ENTRY_ID,
      slug: 'example',
      name: 'Example',
      status: 'draft',
      activeRevisionId: null,
      notes: null,
      createdAt,
      updatedAt: createdAt,
      revisions: [{
        revisionId: REVISION_ID,
        revision: 1,
        baseUrl: 'https://llm.example.test/v1',
        authMode: 'bearer',
        modelMap,
        dataNote: null,
        createdBy: ADMIN_ID,
        createdAt,
        verifiedModels: ['claude-sonnet-4-6'],
        verifications: [{
          modelId: 'claude-sonnet-4-6',
          harnessVersion: CURRENT_HARNESS_VERSION,
          passed: true,
          detail: { steps: [] },
          verifiedBy: ADMIN_ID,
          verifiedAt: createdAt,
        }],
      }],
    }]);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('returns a revision lookup used by the fidelity route', async () => {
    dbState.selectResults.push([{
      revisionId: REVISION_ID,
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap,
    }]);

    await expect(getCatalogRevisionById(REVISION_ID)).resolves.toEqual({
      revisionId: REVISION_ID,
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'bearer',
      modelMap,
    });
  });

  describe('getCatalogEntryName (#3922 W4)', () => {
    it('resolves a name by id independent of listing status', async () => {
      dbState.selectResults.push([{ name: 'OpenRouter' }]);

      await expect(getCatalogEntryName(ENTRY_ID)).resolves.toBe('OpenRouter');
      expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    });

    it('returns null for an id with no matching row', async () => {
      dbState.selectResults.push([]);

      await expect(getCatalogEntryName(ENTRY_ID)).resolves.toBeNull();
    });
  });
});
