import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const { dbState, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  dbState: {
    selectResults: [] as unknown[][],
    insertResults: [] as unknown[][],
    updateResults: [] as unknown[][],
    insertedValues: [] as Array<Record<string, unknown>>,
    updateSets: [] as Array<Record<string, unknown>>,
  },
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

function queuedSelectBuilder() {
  const resolveNext = () => Promise.resolve(dbState.selectResults.shift() ?? []);
  const builder: Record<string, unknown> = {};
  builder.from = vi.fn(() => builder);
  builder.innerJoin = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
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
    [{ revisionId: REVISION_ID, modelId: 'claude-sonnet-4-6' }],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectResults.length = 0;
  dbState.insertResults.length = 0;
  dbState.updateResults.length = 0;
  dbState.insertedValues.length = 0;
  dbState.updateSets.length = 0;
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
      [{ modelId: 'claude-sonnet-4-6' }],
    );

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .rejects.toThrow(/claude-haiku-4-5/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('activates a revision when every mapped model has a passing current-harness verification', async () => {
    dbState.selectResults.push(
      [{ id: REVISION_ID, catalogEntryId: ENTRY_ID, modelMap }],
      [
        { modelId: 'claude-sonnet-4-6' },
        { modelId: 'claude-haiku-4-5' },
      ],
    );
    dbState.updateResults.push([{ id: ENTRY_ID }]);

    await expect(activateRevision({ entryId: ENTRY_ID, revisionId: REVISION_ID }))
      .resolves.toBeUndefined();
    expect(dbState.updateSets[0]).toMatchObject({ activeRevisionId: REVISION_ID });
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
});
