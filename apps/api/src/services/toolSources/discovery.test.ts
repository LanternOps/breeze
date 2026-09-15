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

import { computeToolRevision, discoverSource, proposeTier } from './discovery';
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

describe('module wiring smoke check', () => {
  it('uses the mocked db', () => {
    expect(db.select).toBe(shared.selectMock);
  });
  it('references the real McpClient default export shape', () => {
    expect(typeof McpClient).toBe('function');
  });
});
