/**
 * Tests for credential-masking in aiToolsIntegrations.ts
 *
 * Guards against regressions where maskWebhookUrl() is removed or bypassed,
 * which would leak credential-bearing URLs to the AI model surface.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that pull in the module
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
  decryptForColumn: vi.fn(),
  redactUrlForLogs: vi.fn(),
  queueDelivery: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
    update: mocks.dbUpdate,
  },
}));

// test_webhook now mirrors routes/webhooks.ts POST /:id/test and actually
// dispatches to the worker (D.1 fix) — mock the worker so these tests
// exercise the dispatch call without touching Redis/eventBus. Site-ceiling
// gate contract §7E: queueDelivery no longer takes a decrypted config —
// there is nothing left to map here; the worker resolves and decrypts the
// row itself at send time.
vi.mock('../workers/webhookDelivery', () => ({
  getWebhookWorker: () => ({ queueDelivery: mocks.queueDelivery }),
}));

// Mock the schema so Drizzle column references resolve without a real DB.
vi.mock('../db/schema/integrations', () => ({
  webhooks: {
    id: 'id',
    orgId: 'orgId',
    name: 'name',
    url: 'url',
    status: 'status',
    events: 'events',
    successCount: 'successCount',
    failureCount: 'failureCount',
    lastDeliveryAt: 'lastDeliveryAt',
    lastSuccessAt: 'lastSuccessAt',
    createdAt: 'createdAt',
  },
  webhookDeliveries: {
    id: 'id',
    webhookId: 'webhookId',
    eventType: 'eventType',
    eventId: 'eventId',
    payload: 'payload',
    status: 'status',
    attempts: 'attempts',
    createdAt: 'createdAt',
    deliveredAt: 'deliveredAt',
    responseStatus: 'responseStatus',
    responseTimeMs: 'responseTimeMs',
    errorMessage: 'errorMessage',
  },
  psaConnections: {
    id: 'id',
    orgId: 'orgId',
    provider: 'provider',
    name: 'name',
    enabled: 'enabled',
    lastSyncAt: 'lastSyncAt',
    lastSyncStatus: 'lastSyncStatus',
    lastSyncError: 'lastSyncError',
    createdAt: 'createdAt',
  },
  psaTicketMappings: {
    id: 'id',
    connectionId: 'connectionId',
  },
}));

vi.mock('./secretCrypto', () => ({
  decryptForColumn: mocks.decryptForColumn,
}));

vi.mock('./notificationSenders/webhookSender', () => ({
  redactUrlForLogs: mocks.redactUrlForLogs,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerIntegrationTools } from './aiToolsIntegrations';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_ID = '22222222-2222-2222-2222-222222222222';
const DELIVERY_ID = '44444444-4444-4444-4444-444444444444';

/** Real redactUrlForLogs behaviour — strip userinfo/query/hash */
function realRedact(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '[invalid-url]';
  }
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
  } as any;
}

function buildToolMap(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerIntegrationTools(map);
  return map;
}

/** Fluent select chain that resolves to `rows` after .from().where().orderBy().limit() */
function makeSelectChain(rows: unknown[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

/** Fluent insert chain that resolves to `rows` after .values().returning() */
function makeInsertChain(rows: unknown[]) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Fluent update chain that resolves after .set().where() */
function makeUpdateChain() {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(undefined));
  return chain;
}

// ---------------------------------------------------------------------------
// Suite: query_webhooks credential masking
// ---------------------------------------------------------------------------

describe('aiToolsIntegrations — query_webhooks credential masking', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolMap = buildToolMap();

    // Default: decryptForColumn returns its input unchanged (plaintext path).
    mocks.decryptForColumn.mockImplementation((_table: string, _col: string, val: string) => val);
    // Default: redactUrlForLogs strips userinfo and query.
    mocks.redactUrlForLogs.mockImplementation((url: string) => realRedact(url));
  });

  it('masks credential-bearing URL — secret substring absent from JSON output', async () => {
    const credentialUrl = 'https://user:pass@webhook.example.com/hook?token=super-secret-abc';

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      {
        id: WEBHOOK_ID,
        name: 'My Hook',
        url: credentialUrl,
        status: 'active',
        events: ['device.created'],
        successCount: 0,
        failureCount: 0,
        lastDeliveryAt: null,
        lastSuccessAt: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]));

    const result = await toolMap.get('query_webhooks')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    // Raw secrets must not appear anywhere in the output.
    expect(result).not.toContain('super-secret-abc');
    expect(result).not.toContain('user:pass');
    // Only the scheme and host are returned — never the path.
    expect(parsed.webhooks[0].url).toBe('https://webhook.example.com');
    expect(result).not.toContain('/hook');
    expect(parsed.webhooks[0].urlFingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it('masks encrypted URL — decrypted-then-redacted, raw ciphertext absent', async () => {
    const encryptedUrl = 'enc:v1:someciphertextblob';
    const decryptedPlain = 'https://bot:hunter2@hooks.example.com/path?sig=abc';

    mocks.decryptForColumn.mockImplementation(() => decryptedPlain);

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      {
        id: WEBHOOK_ID,
        name: 'Enc Hook',
        url: encryptedUrl,
        status: 'active',
        events: ['alert.triggered'],
        successCount: 1,
        failureCount: 0,
        lastDeliveryAt: null,
        lastSuccessAt: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]));

    const result = await toolMap.get('query_webhooks')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    // Credentials from the decrypted form must not appear.
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('bot:');
    expect(result).not.toContain('sig=abc');
    // Raw ciphertext must not appear either.
    expect(result).not.toContain('enc:v1:someciphertextblob');
    // Only the scheme and host of the decrypted URL are returned.
    expect(parsed.webhooks[0].url).toBe('https://hooks.example.com');
    expect(result).not.toContain('/path');
  });

  it('decrypt-failure fallback — raw ciphertext not emitted when decryptForColumn throws', async () => {
    const encryptedUrl = 'enc:v1:GIBBERISH_CIPHERTEXT';

    // Simulate decryption failure (wrong key, corruption, etc.)
    mocks.decryptForColumn.mockImplementation(() => {
      throw new Error('decryption failed: invalid tag');
    });

    // On decrypt failure the code falls back to the stored string, which is
    // then passed to redactUrlForLogs. redactUrlForLogs on a non-URL returns
    // [invalid-url] — we still must not emit the raw ciphertext.
    mocks.redactUrlForLogs.mockImplementation((val: string) => {
      // A real URL parse of enc:v1:… will throw; return a safe placeholder.
      return realRedact(val);
    });

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      {
        id: WEBHOOK_ID,
        name: 'Broken Hook',
        url: encryptedUrl,
        status: 'error',
        events: [],
        successCount: 0,
        failureCount: 3,
        lastDeliveryAt: null,
        lastSuccessAt: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      },
    ]));

    const result = await toolMap.get('query_webhooks')!.handler({}, makeAuth());

    // The ciphertext blob itself must not appear in the output.
    expect(result).not.toContain('GIBBERISH_CIPHERTEXT');
    // The output must still be valid JSON.
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite: test_webhook credential masking
// ---------------------------------------------------------------------------

describe('aiToolsIntegrations — test_webhook credential masking', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolMap = buildToolMap();

    mocks.decryptForColumn.mockImplementation((_table: string, _col: string, val: string) => val);
    mocks.redactUrlForLogs.mockImplementation((url: string) => realRedact(url));
    mocks.queueDelivery.mockResolvedValue('worker-delivery-id');
  });

  it('masks credential-bearing webhookUrl in the test_webhook response', async () => {
    const credentialUrl = 'https://admin:s3cr3t@hooks.example.com/test?api_key=mysecret';

    // First select: fetch the webhook row.
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, orgId: ORG_ID, name: 'Test Hook', url: credentialUrl, approvalGeneration: 1 },
    ]));

    // Insert: create delivery record.
    mocks.dbInsert.mockReturnValueOnce(makeInsertChain([
      { id: DELIVERY_ID, createdAt: new Date('2026-06-01T00:00:00Z') },
    ]));

    const result = await toolMap.get('test_webhook')!.handler(
      { webhookId: WEBHOOK_ID },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    // The echoed webhookUrl must be masked.
    expect(parsed.webhookUrl).toBeDefined();
    expect(result).not.toContain('s3cr3t');
    expect(result).not.toContain('admin:');
    expect(result).not.toContain('mysecret');
    expect(parsed.webhookUrl).toBe('https://hooks.example.com');
    expect(result).not.toContain('/test');
    expect(parsed.webhookUrlFingerprint).toMatch(/^[0-9a-f]{6}$/);
    // D.1: the delivery must actually be dispatched to the worker, not just
    // inserted as a permanently-'pending' row. Site-ceiling gate contract
    // §7E: the dispatch call carries only the webhook's identity + generation
    // snapshot — never the decrypted config — so the credential can't leak
    // into the Redis queue payload either.
    expect(mocks.queueDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.queueDelivery).toHaveBeenCalledWith(
      WEBHOOK_ID,
      1,
      expect.objectContaining({ orgId: ORG_ID }),
      DELIVERY_ID,
    );
  });

  it('masks encrypted URL in test_webhook — ciphertext not echoed', async () => {
    const encryptedUrl = 'enc:v1:CIPHERTEXT_XYZ';
    const decryptedUrl = 'https://user:token99@hooks.example.com/cb';

    mocks.decryptForColumn.mockImplementation(() => decryptedUrl);

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, orgId: ORG_ID, name: 'Enc Test Hook', url: encryptedUrl },
    ]));

    mocks.dbInsert.mockReturnValueOnce(makeInsertChain([
      { id: DELIVERY_ID, createdAt: new Date('2026-06-01T00:00:00Z') },
    ]));

    const result = await toolMap.get('test_webhook')!.handler(
      { webhookId: WEBHOOK_ID },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.success).toBe(true);
    expect(result).not.toContain('token99');
    expect(result).not.toContain('CIPHERTEXT_XYZ');
    expect(parsed.webhookUrl).toBe('https://hooks.example.com');
    expect(result).not.toContain('/cb');
  });

  it('decrypt-failure in test_webhook — raw ciphertext not emitted', async () => {
    const encryptedUrl = 'enc:v1:BADKEY_CIPHERTEXT';

    mocks.decryptForColumn.mockImplementation(() => {
      throw new Error('bad decrypt');
    });
    mocks.redactUrlForLogs.mockImplementation((val: string) => realRedact(val));

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, orgId: ORG_ID, name: 'Broken Hook', url: encryptedUrl },
    ]));

    mocks.dbInsert.mockReturnValueOnce(makeInsertChain([
      { id: DELIVERY_ID, createdAt: new Date('2026-06-01T00:00:00Z') },
    ]));

    const result = await toolMap.get('test_webhook')!.handler(
      { webhookId: WEBHOOK_ID },
      makeAuth(),
    );

    expect(result).not.toContain('BADKEY_CIPHERTEXT');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('returns not-found when the webhook select returns empty', async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([]));

    const result = await toolMap.get('test_webhook')!.handler(
      { webhookId: WEBHOOK_ID },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/not found|access denied/i);
  });

  it('marks the delivery failed (not left permanently pending) when the worker queue rejects', async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, orgId: ORG_ID, name: 'Test Hook', url: 'https://hooks.example.com/test' },
    ]));
    mocks.dbInsert.mockReturnValueOnce(makeInsertChain([
      { id: DELIVERY_ID, createdAt: new Date('2026-06-01T00:00:00Z') },
    ]));
    const updateChain = makeUpdateChain();
    mocks.dbUpdate.mockReturnValueOnce(updateChain);
    mocks.queueDelivery.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await toolMap.get('test_webhook')!.handler(
      { webhookId: WEBHOOK_ID },
      makeAuth(),
    );
    const parsed = JSON.parse(result);

    expect(parsed.error).toMatch(/failed to queue/i);
    expect(mocks.dbUpdate).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorMessage: 'redis unavailable' }),
    );
  });
});

// test_webhook's route (POST /webhooks/:id/test)
// carries requireMfa() on top of organizations:write, and this file's own
// documented invariant (aiGuardrails.ts, "MFA — what substitutes for the
// routes' requireMfa()") says a tool mirroring a requireMfa() route must be
// tier 3 if the route mutates. test_webhook sends a real outbound POST, so it
// is tier 3. The supervised approval scope is asserted in
// aiGuardrails.approvalScope.contract.test.ts (resolveApprovalScope),
// which already carries the heavier import this module's light db mock can't.
describe('test_webhook tier', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    toolMap = buildToolMap();
  });

  it('registers at tier 3, not tier 2', () => {
    expect(toolMap.get('test_webhook')!.tier).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Suite: endpoint display for chat-provider style URLs
// ---------------------------------------------------------------------------

function webhookRow(id: string, url: string) {
  return {
    id,
    name: `Hook ${id.slice(0, 4)}`,
    url,
    status: 'active',
    events: ['alert.triggered'],
    successCount: 0,
    failureCount: 0,
    lastDeliveryAt: null,
    lastSuccessAt: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
  };
}

describe('aiToolsIntegrations — query_webhooks shows the endpoint host, not the stored path', () => {
  let toolMap: Map<string, AiTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolMap = buildToolMap();
    mocks.decryptForColumn.mockImplementation((_table: string, _col: string, val: string) => val);
    mocks.redactUrlForLogs.mockImplementation((url: string) => realRedact(url));
  });

  it('Slack, Discord and Teams style URLs keep only scheme and host', async () => {
    const slack = 'https://hooks.slack.com/services/T0000AAAA/B0000BBBB/slackPathPart123';
    const discord = 'https://discord.com/api/webhooks/123456789012345678/discordPathPart_abc';
    const teams = 'https://contoso.webhook.office.com/webhookb2/aaaa-bbbb@cccc/IncomingWebhook/teamsPathPart/dddd';
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      webhookRow('a1111111-1111-1111-1111-111111111111', slack),
      webhookRow('a2222222-2222-2222-2222-222222222222', discord),
      webhookRow('a3333333-3333-3333-3333-333333333333', teams),
    ]));

    const result = await toolMap.get('query_webhooks')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);

    expect(parsed.webhooks.map((w: { url: string }) => w.url)).toEqual([
      'https://hooks.slack.com',
      'https://discord.com',
      'https://contoso.webhook.office.com',
    ]);
    for (const fragment of ['slackPathPart123', 'T0000AAAA', 'discordPathPart_abc', '123456789012345678', 'teamsPathPart', 'IncomingWebhook']) {
      expect(result).not.toContain(fragment);
    }
  });

  it('two endpoints on the same host get different fingerprints; the same endpoint keeps its fingerprint', async () => {
    const first = 'https://hooks.slack.com/services/T1/B1/firstPathPart';
    const second = 'https://hooks.slack.com/services/T1/B2/secondPathPart';
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      webhookRow('b1111111-1111-1111-1111-111111111111', first),
      webhookRow('b2222222-2222-2222-2222-222222222222', second),
    ]));
    const a = JSON.parse(await toolMap.get('query_webhooks')!.handler({}, makeAuth()));

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      webhookRow('b1111111-1111-1111-1111-111111111111', first),
    ]));
    const b = JSON.parse(await toolMap.get('query_webhooks')!.handler({}, makeAuth()));

    expect(a.webhooks[0].url).toBe(a.webhooks[1].url);
    expect(a.webhooks[0].urlFingerprint).not.toBe(a.webhooks[1].urlFingerprint);
    expect(b.webhooks[0].urlFingerprint).toBe(a.webhooks[0].urlFingerprint);
  });

  it('a non-default port is kept with the host', async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      webhookRow('c1111111-1111-1111-1111-111111111111', 'https://hooks.example.com:8443/in/abc'),
    ]));
    const parsed = JSON.parse(await toolMap.get('query_webhooks')!.handler({}, makeAuth()));
    expect(parsed.webhooks[0].url).toBe('https://hooks.example.com:8443');
  });

  it('an unparseable stored value is replaced by a placeholder', async () => {
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      webhookRow('d1111111-1111-1111-1111-111111111111', 'not a url /with/pathPart'),
    ]));
    const result = await toolMap.get('query_webhooks')!.handler({}, makeAuth());
    const parsed = JSON.parse(result);
    expect(parsed.webhooks[0].url).toBe('[invalid-url]');
    expect(result).not.toContain('pathPart');
  });
});
