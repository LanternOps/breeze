import { beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const shared = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    select: shared.selectMock,
    insert: shared.insertMock,
    update: shared.updateMock,
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  toolSources: {
    id: 'toolSources.id',
    orgId: 'toolSources.orgId',
    partnerId: 'toolSources.partnerId',
    slug: 'toolSources.slug',
  },
  toolSourceTools: {
    id: 'toolSourceTools.id',
    sourceId: 'toolSourceTools.sourceId',
    name: 'toolSourceTools.name',
  },
}));

// Real decryptSecret/encryptSecret expect real ciphertext, which these fake
// rows never carry. Fake the decrypted shape directly so the test controls
// the auth config without exercising real crypto; redactSecrets/secretValuesOf
// keep their real (simple) redaction behavior so the redaction assertions are
// meaningful.
vi.mock('./secrets', () => ({
  decryptToolSourceAuth: vi.fn(() => ({ authKind: 'bearer', token: 'super-secret-token-value' })),
  redactSecrets: vi.fn((text: string, secrets: readonly string[]) => {
    let out = text;
    for (const s of secrets) {
      if (s) out = out.split(s).join('[REDACTED]');
    }
    return out;
  }),
  secretValuesOf: vi.fn((cfg: { authKind: string; token?: string }) =>
    cfg.authKind === 'bearer' && cfg.token ? [cfg.token] : []),
}));
vi.mock('../../config/env', () => ({ toolSourcesAllowPrivateEgress: vi.fn(() => false) }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDiscoverySummary, computeToolRevision, discoverSource, proposeTier, SUMMARY_MAX_SKIPPED } from './discovery';
import { dereferenceLocal, OpenApiSpecError, parseOpenApiDocument } from './openapiSpec';
import { db } from '../../db';
import { McpClient, McpClientError } from './mcpClient';
import { decryptToolSourceAuth } from './secrets';
import { toolSourcesAllowPrivateEgress } from '../../config/env';

function makeSourceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SOURCE_ID,
    orgId: ORG_ID,
    partnerId: null,
    slug: 'acme',
    name: 'Acme MCP',
    kind: 'mcp',
    endpointUrl: 'https://acme.example.com/mcp',
    credentialOrigin: 'https://acme.example.com',
    authKind: 'bearer',
    authConfigEncrypted: 'ENCRYPTED_BLOB',
    authFingerprint: 'fp',
    status: 'active',
    lastDiscoveredAt: null,
    lastError: null,
    rateLimitPerMinute: 120,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Chainable select mocks. Call order in discoverSource: (1) source lookup
// (.from().where().limit()), (2) existing-tools lookup (.from().where()).
function mockSourceLookup(row: ReturnType<typeof makeSourceRow> | undefined) {
  shared.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  } as any);
}

function mockExistingTools(rows: Array<Record<string, unknown>>) {
  shared.selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as any);
}

function mockInsertCapture() {
  const values = vi.fn().mockResolvedValue(undefined);
  shared.insertMock.mockReturnValue({ values } as any);
  return values;
}

function mockUpdateCapture() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  shared.updateMock.mockReturnValue({ set } as any);
  return { set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('proposeTier', () => {
  it('proposes tier 1 for read-only, non-destructive annotations', () => {
    expect(proposeTier({ readOnlyHint: true, destructiveHint: false })).toBe(1);
    expect(proposeTier({ readOnlyHint: true })).toBe(1);
  });

  it('proposes tier 3 otherwise', () => {
    expect(proposeTier({ readOnlyHint: true, destructiveHint: true })).toBe(3);
    expect(proposeTier({ readOnlyHint: false })).toBe(3);
    expect(proposeTier(undefined)).toBe(3);
    expect(proposeTier({})).toBe(3);
  });
});

describe('computeToolRevision', () => {
  it('is stable across key order (top-level and nested)', () => {
    const a = computeToolRevision({
      name: 'get_widget',
      description: 'fetch a widget',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, count: { type: 'number' } } },
      tier: 1,
    });
    const b = computeToolRevision({
      tier: 1,
      inputSchema: { properties: { count: { type: 'number' }, id: { type: 'string' } }, type: 'object' },
      description: 'fetch a widget',
      name: 'get_widget',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the schema, description, name, or tier changes', () => {
    const base = computeToolRevision({ name: 'a', description: 'd', inputSchema: { type: 'object' }, tier: 1 });
    expect(computeToolRevision({ name: 'a', description: 'd2', inputSchema: { type: 'object' }, tier: 1 })).not.toBe(base);
    expect(computeToolRevision({ name: 'a', description: 'd', inputSchema: { type: 'string' }, tier: 1 })).not.toBe(base);
    expect(computeToolRevision({ name: 'b', description: 'd', inputSchema: { type: 'object' }, tier: 1 })).not.toBe(base);
    expect(computeToolRevision({ name: 'a', description: 'd', inputSchema: { type: 'object' }, tier: 3 })).not.toBe(base);
  });
});

describe('discoverSource', () => {
  it('first discovery inserts N disabled tools with proposed tiers', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([]);
    const values = mockInsertCapture();
    mockUpdateCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: '2025-06-18' }),
      listTools: vi.fn().mockResolvedValue([
        { name: 'get_widget', description: 'fetch', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: 'delete_widget', description: 'delete', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
      ]),
    };
    const clientFactory = vi.fn().mockReturnValue(fakeClient);

    const outcome = await discoverSource(SOURCE_ID, { clientFactory: clientFactory as any });

    expect(outcome.added).toBe(2);
    expect(outcome.updated).toBe(0);
    expect(outcome.removed).toBe(0);
    expect(outcome.status).toBe('active');
    expect(values).toHaveBeenCalledTimes(2);
    const [readOnlyInsert, destructiveInsert] = values.mock.calls.map((c) => c[0]);
    expect(readOnlyInsert).toMatchObject({ name: 'get_widget', enabled: false, proposedTier: 1, tier: 1 });
    expect(destructiveInsert).toMatchObject({ name: 'delete_widget', enabled: false, proposedTier: 3, tier: 3 });
  });

  it('a newly discovered tool is forced reviewNeeded regardless of its self-declared tier', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([]);
    const values = mockInsertCapture();
    mockUpdateCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: '2025-06-18' }),
      listTools: vi.fn().mockResolvedValue([
        { name: 'get_widget', description: 'fetch', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
      ]),
    };
    const clientFactory = vi.fn().mockReturnValue(fakeClient);

    await discoverSource(SOURCE_ID, { clientFactory: clientFactory as any });

    const [readOnlyInsert] = values.mock.calls.map((c) => c[0]);
    expect(readOnlyInsert).toMatchObject({ name: 'get_widget', proposedTier: 1, reviewNeeded: true });
  });

  it('wires TOOL_SOURCES_ALLOW_PRIVATE_EGRESS into the McpClient it constructs for a remote listing', async () => {
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValueOnce(true);
    mockSourceLookup(makeSourceRow());
    mockExistingTools([]);
    mockInsertCapture();
    mockUpdateCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([]),
    };
    const clientFactory = vi.fn().mockReturnValue(fakeClient);

    await discoverSource(SOURCE_ID, { clientFactory: clientFactory as any });

    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ allowPrivateNetwork: true }));
  });

  it('second discovery with a changed schema bumps revision and leaves tier', async () => {
    const oldRevision = computeToolRevision({
      name: 'get_widget', description: 'fetch', inputSchema: { type: 'object' }, tier: 1,
    });
    mockSourceLookup(makeSourceRow());
    mockExistingTools([
      {
        id: 'tool-1', sourceId: SOURCE_ID, orgId: ORG_ID, partnerId: null,
        name: 'get_widget', qualifiedName: 'acme__get_widget', description: 'fetch',
        inputSchema: { type: 'object' }, outputSchema: null, annotations: { readOnlyHint: true, destructiveHint: false },
        proposedTier: 1, tier: 1, enabled: false, reviewNeeded: false, revision: oldRevision,
        lastError: null, discoveredAt: new Date(), removedAt: null, updatedAt: new Date(),
      },
    ]);
    const { set } = mockUpdateCapture();
    mockInsertCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([
        { name: 'get_widget', description: 'fetch', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } },
      ]),
    };
    const outcome = await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    expect(outcome.added).toBe(0);
    expect(outcome.updated).toBe(1);
    // Two update calls happen: the tool row, then the source row. The first
    // is the tool row update.
    const toolUpdateArgs = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(toolUpdateArgs.tier).toBe(1);
    expect(toolUpdateArgs.revision).not.toBe(oldRevision);
  });

  it('a tool whose annotations flip to destructive raises tier to 3 and sets reviewNeeded', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([
      {
        id: 'tool-1', sourceId: SOURCE_ID, orgId: ORG_ID, partnerId: null,
        name: 'get_widget', qualifiedName: 'acme__get_widget', description: 'fetch',
        inputSchema: { type: 'object' }, outputSchema: null, annotations: { readOnlyHint: true, destructiveHint: false },
        proposedTier: 1, tier: 1, enabled: true, reviewNeeded: false, revision: 'irrelevant',
        lastError: null, discoveredAt: new Date(), removedAt: null, updatedAt: new Date(),
      },
    ]);
    const { set } = mockUpdateCapture();
    mockInsertCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([
        { name: 'get_widget', description: 'fetch', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
      ]),
    };
    await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    const toolUpdateArgs = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(toolUpdateArgs.tier).toBe(3);
    expect(toolUpdateArgs.reviewNeeded).toBe(true);
  });

  it('a listing missing a previously-enabled tool sets removedAt and puts the source in error', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([
      {
        id: 'tool-1', sourceId: SOURCE_ID, orgId: ORG_ID, partnerId: null,
        name: 'get_widget', qualifiedName: 'acme__get_widget', description: 'fetch',
        inputSchema: { type: 'object' }, outputSchema: null, annotations: {},
        proposedTier: 1, tier: 1, enabled: true, reviewNeeded: false, revision: 'r1',
        lastError: null, discoveredAt: new Date(), removedAt: null, updatedAt: new Date(),
      },
    ]);
    const { set } = mockUpdateCapture();
    mockInsertCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([]),
    };
    const outcome = await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    expect(outcome.removed).toBe(1);
    expect(outcome.status).toBe('error');
    expect(outcome.error).toContain('get_widget');

    const toolUpdateArgs = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(toolUpdateArgs.removedAt).toBeInstanceOf(Date);
    expect(toolUpdateArgs.enabled).toBe(false);

    const sourceUpdateArgs = set.mock.calls[1]![0] as Record<string, unknown>;
    expect(sourceUpdateArgs.status).toBe('error');
    expect(sourceUpdateArgs.lastError).toContain('enabled tools removed by re-discovery');
    expect(sourceUpdateArgs.lastError).toContain('get_widget');
  });

  it('a bad tool name is upserted disabled, review-needed, and recorded as not addressable', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([]);
    const values = mockInsertCapture();
    mockUpdateCapture();

    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([
        { name: 'bad name with spaces', description: 'x', inputSchema: { type: 'object' }, annotations: {} },
      ]),
    };
    const outcome = await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    expect(values).toHaveBeenCalledTimes(1);
    const insertArgs = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertArgs.enabled).toBe(false);
    expect(insertArgs.reviewNeeded).toBe(true);
    expect(insertArgs.lastError).toBe('name_not_addressable');
    expect(outcome.skipped).toEqual([{ name: 'bad name with spaces', reason: 'name_not_addressable' }]);
  });

  it('an auth error sets the source status to error with a redacted message', async () => {
    mockSourceLookup(makeSourceRow({ authKind: 'bearer', authConfigEncrypted: 'ENCRYPTED_BLOB' }));
    const { set } = mockUpdateCapture();

    const fakeClient = {
      initialize: vi.fn().mockRejectedValue(new McpClientError('MCP server rejected the request with 401: token super-secret-token-value', 'auth')),
      listTools: vi.fn(),
    };
    const outcome = await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    expect(outcome.status).toBe('error');
    expect(outcome.error).toBeDefined();
    expect(outcome.error).not.toContain('super-secret-token-value');
    const sourceUpdateArgs = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(sourceUpdateArgs.status).toBe('error');
    expect(sourceUpdateArgs.lastError).not.toContain('super-secret-token-value');
  });

  it('a decrypt failure sets the source status to error instead of leaving it active forever', async () => {
    mockSourceLookup(makeSourceRow({ authKind: 'bearer', authConfigEncrypted: 'ENCRYPTED_BLOB' }));
    const { set } = mockUpdateCapture();
    vi.mocked(decryptToolSourceAuth).mockImplementationOnce(() => {
      throw new Error('decryption failed: bad tag');
    });

    const outcome = await discoverSource(SOURCE_ID, { clientFactory: () => ({} as any) });

    expect(outcome.status).toBe('error');
    expect(outcome.error).toBeDefined();
    const sourceUpdateArgs = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(sourceUpdateArgs.status).toBe('error');
    expect(sourceUpdateArgs.lastError).toContain('decryption failed');
  });
});

describe('discoverSource — openapi kind (W2)', () => {
  const openapiRow = (overrides: Partial<Record<string, unknown>> = {}) =>
    makeSourceRow({
      kind: 'openapi',
      slug: 'petsvc',
      endpointUrl: 'https://api.example.com/v1',
      credentialOrigin: 'https://api.example.com',
      specUrl: 'https://api.example.com/v1/openapi.json',
      ...overrides,
    });
  const petstore = () => dereferenceLocal(parseOpenApiDocument(readFileSync(join(__dirname, '__fixtures__', 'petstore.json'), 'utf8')));
  const psaLike = () => dereferenceLocal(parseOpenApiDocument(readFileSync(join(__dirname, '__fixtures__', 'psa-like.yaml'), 'utf8')));
  const lastSourceUpdate = (set: ReturnType<typeof vi.fn>) => set.mock.calls.at(-1)![0] as Record<string, any>;

  it('fetches and projects the document instead of speaking MCP', async () => {
    mockSourceLookup(openapiRow());
    mockExistingTools([]);
    const values = mockInsertCapture();
    const { set } = mockUpdateCapture();
    const clientFactory = vi.fn();
    const specFetcher = vi.fn().mockResolvedValue(petstore());

    const outcome = await discoverSource(SOURCE_ID, { clientFactory, specFetcher });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(specFetcher).toHaveBeenCalledWith({
      specUrl: 'https://api.example.com/v1/openapi.json',
      credentialOrigin: 'https://api.example.com',
      auth: { authKind: 'bearer', token: 'super-secret-token-value' },
      allowPrivateNetwork: false,
    });
    expect(outcome).toMatchObject({ added: 4, status: 'active' });
    const inserted = values.mock.calls.map((c) => c[0] as Record<string, any>);
    const tiers = Object.fromEntries(inserted.map((r) => [r.name, r.proposedTier]));
    expect(tiers).toEqual({ listPets: 1, createPets: 3, showPetById: 1, deletePet: 3 });
    expect(inserted.every((r) => r.enabled === false && r.reviewNeeded === true)).toBe(true);
    expect(inserted.find((r) => r.name === 'showPetById')!.annotations.operation).toMatchObject({ method: 'get', path: '/pets/{petId}' });
    expect(inserted.find((r) => r.name === 'listPets')!.qualifiedName).toBe('petsvc__listPets');

    const update = lastSourceUpdate(set);
    expect(update.status).toBe('active');
    expect(update.lastError).toBeNull();
    expect(update.lastDiscoverySummary).toMatchObject({
      version: 1,
      operationCount: 4,
      skippedTotal: 1,
      skipped: [{ name: 'OPTIONS /pets/{petId}', method: 'OPTIONS', path: '/pets/{petId}', reason: 'unsupported_method' }],
      warnings: [],
    });
    expect(update.lastDiscoverySummary.at).toBe((update.lastDiscoveredAt as Date).toISOString());
  });

  it('records a servers[] origin mismatch as a summary warning, staying active with last_error untouched', async () => {
    mockSourceLookup(openapiRow());
    mockExistingTools([]);
    mockInsertCapture();
    const { set } = mockUpdateCapture();

    const outcome = await discoverSource(SOURCE_ID, { specFetcher: vi.fn().mockResolvedValue(psaLike()) });

    const update = lastSourceUpdate(set);
    expect(update.status).toBe('active');
    expect(update.lastError).toBeNull();
    expect(update.lastDiscoverySummary.warnings).toEqual([{ code: 'server_origin_mismatch', origins: ['https://eu.vendor-cdn.example'] }]);
    expect(update.lastDiscoverySummary.skipped.map((s: any) => s.reason).sort()).toEqual([
      'unsupported_param_style', 'unsupported_param_style', 'unsupported_request_body', 'unsupported_security_location',
    ]);
    expect(outcome.warnings).toEqual(update.lastDiscoverySummary.warnings);
    expect(outcome.skipped).toHaveLength(4);
  });

  it('keeps a real error in last_error when the same run also has a server warning', async () => {
    mockSourceLookup(openapiRow());
    mockExistingTools([
      {
        id: 'tool-gone', sourceId: SOURCE_ID, name: 'vanished', enabled: true, removedAt: null,
        tier: 1, proposedTier: 1, reviewNeeded: false, revision: 'r',
      },
    ]);
    mockInsertCapture();
    const { set } = mockUpdateCapture();

    await discoverSource(SOURCE_ID, { specFetcher: vi.fn().mockResolvedValue(psaLike()) });

    const update = lastSourceUpdate(set);
    expect(update.status).toBe('error');
    expect(update.lastError).toBe('enabled tools removed by re-discovery: vanished');
    expect(update.lastDiscoverySummary.warnings).toHaveLength(1);
  });

  it('sets status error with the spec error and leaves the previous summary alone when the document is refused', async () => {
    mockSourceLookup(openapiRow());
    const { set } = mockUpdateCapture();
    const specFetcher = vi.fn().mockRejectedValue(
      new OpenApiSpecError('unsupported_openapi_version: swagger 2.0 (only OpenAPI 3.0.x and 3.1.x are supported)', 'unsupported_version'),
    );

    const outcome = await discoverSource(SOURCE_ID, { specFetcher });

    expect(outcome.status).toBe('error');
    expect(set).toHaveBeenCalledTimes(1);
    const update = set.mock.calls[0]![0] as Record<string, unknown>;
    expect(update.status).toBe('error');
    expect(update.lastError).toMatch(/^unsupported_openapi_version: swagger 2\.0/);
    expect(update).not.toHaveProperty('lastDiscoverySummary');
  });

  it('redacts the credential out of a spec fetch error', async () => {
    mockSourceLookup(openapiRow());
    const { set } = mockUpdateCapture();
    const specFetcher = vi.fn().mockRejectedValue(new OpenApiSpecError('spec_fetch_failed: echo super-secret-token-value', 'transport'));

    await discoverSource(SOURCE_ID, { specFetcher });

    expect((set.mock.calls[0]![0] as Record<string, string>).lastError).toBe('spec_fetch_failed: echo [REDACTED]');
    expect(set.mock.calls[0]![0]).not.toHaveProperty('lastDiscoverySummary');
  });

  it('fails a document over the operation cap through the same error path', async () => {
    mockSourceLookup(openapiRow());
    const { set } = mockUpdateCapture();
    const paths: Record<string, unknown> = {};
    for (let i = 0; i <= 2000; i++) paths[`/p${i}`] = { get: { responses: { '200': { description: 'ok' } } } };

    const outcome = await discoverSource(SOURCE_ID, { specFetcher: vi.fn().mockResolvedValue({ openapi: '3.0.3', paths }) });

    expect(outcome.status).toBe('error');
    expect((set.mock.calls[0]![0] as Record<string, string>).lastError).toBe('too_many_operations: 2001 (limit 2000)');
    expect(set.mock.calls[0]![0]).not.toHaveProperty('lastDiscoverySummary');
  });

  it('passes the private-egress flag through to the spec fetch', async () => {
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(true);
    mockSourceLookup(openapiRow());
    mockExistingTools([]);
    mockInsertCapture();
    mockUpdateCapture();
    const specFetcher = vi.fn().mockResolvedValue(petstore());

    await discoverSource(SOURCE_ID, { specFetcher });

    expect(specFetcher.mock.calls[0]![0]).toMatchObject({ allowPrivateNetwork: true });
    vi.mocked(toolSourcesAllowPrivateEgress).mockReturnValue(false);
  });

  it('fails a document with no operations through the same error path (no empty "active" source)', async () => {
    mockSourceLookup(openapiRow());
    const { set } = mockUpdateCapture();

    const outcome = await discoverSource(SOURCE_ID, { specFetcher: vi.fn().mockResolvedValue({ openapi: '3.1.0', paths: {} }) });

    expect(outcome.status).toBe('error');
    expect((set.mock.calls[0]![0] as Record<string, string>).lastError).toMatch(/^spec_has_no_operations/);
  });

  it('never lowers an effective tier on re-discovery, and bumps the revision when the route moves', async () => {
    const doc = petstore();
    mockSourceLookup(openapiRow());
    mockExistingTools([
      {
        id: 'tool-1', sourceId: SOURCE_ID, name: 'listPets', enabled: true, removedAt: null,
        tier: 3, proposedTier: 3, reviewNeeded: false, revision: 'old-revision',
      },
    ]);
    mockInsertCapture();
    const { set } = mockUpdateCapture();

    await discoverSource(SOURCE_ID, { specFetcher: vi.fn().mockResolvedValue(doc) });

    const toolUpdate = set.mock.calls.map((c) => c[0] as Record<string, any>).find((u) => u.proposedTier !== undefined)!;
    expect(toolUpdate.proposedTier).toBe(1);
    expect(toolUpdate.tier).toBe(3);
    expect(toolUpdate.reviewNeeded).toBe(true);
    expect(toolUpdate.revision).toBe(
      computeToolRevision({
        name: 'listPets', description: toolUpdate.description, inputSchema: toolUpdate.inputSchema, tier: 3,
        operation: toolUpdate.annotations.operation,
      }),
    );
    expect(toolUpdate.revision).not.toBe(
      computeToolRevision({ name: 'listPets', description: toolUpdate.description, inputSchema: toolUpdate.inputSchema, tier: 3 }),
    );
  });

  it('records an MCP name_not_addressable skip in the summary too', async () => {
    mockSourceLookup(makeSourceRow());
    mockExistingTools([]);
    mockInsertCapture();
    const { set } = mockUpdateCapture();
    const fakeClient = {
      initialize: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue([{ name: 'has spaces', inputSchema: { type: 'object' } }]),
    };

    await discoverSource(SOURCE_ID, { clientFactory: () => fakeClient as any });

    expect(lastSourceUpdate(set).lastDiscoverySummary).toMatchObject({
      operationCount: null,
      skipped: [{ name: 'has spaces', reason: 'name_not_addressable' }],
      skippedTotal: 1,
      warnings: [],
    });
  });
});

describe('computeToolRevision — openapi binding (W2)', () => {
  it('is unchanged for MCP tools (no operation key) and sensitive to the binding when present', () => {
    const base = { name: 'x', description: 'd', inputSchema: { type: 'object' }, tier: 1 };
    expect(computeToolRevision(base)).toBe(computeToolRevision({ ...base, operation: undefined }));
    expect(computeToolRevision({ ...base, operation: { method: 'get', path: '/a' } }))
      .not.toBe(computeToolRevision({ ...base, operation: { method: 'get', path: '/b' } }));
  });
});

describe('buildDiscoverySummary', () => {
  it('caps the skipped list but keeps the real total, and bounds strings', () => {
    const skipped = Array.from({ length: SUMMARY_MAX_SKIPPED + 25 }, (_, i) => ({
      name: `${'n'.repeat(300)}${i}`, method: 'GET', path: '/x', reason: 'unsupported_method' as const,
    }));
    const summary = buildDiscoverySummary(new Date('2026-10-17T00:00:00Z'), 600, skipped, []);
    expect(summary.skipped).toHaveLength(SUMMARY_MAX_SKIPPED);
    expect(summary.skippedTotal).toBe(SUMMARY_MAX_SKIPPED + 25);
    expect(summary.skipped[0]!.name).toHaveLength(256);
    expect(summary.at).toBe('2026-10-17T00:00:00.000Z');
  });
});

describe('module wiring smoke check', () => {
  it('uses the mocked db', () => {
    expect(db.select).toBe(shared.selectMock);
  });
  it('references the real McpClient default export shape', () => {
    expect(typeof McpClient).toBe('function');
  });
});
