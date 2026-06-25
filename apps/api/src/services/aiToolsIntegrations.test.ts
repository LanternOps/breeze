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
  decryptForColumn: vi.fn(),
  redactUrlForLogs: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: mocks.dbSelect,
    insert: mocks.dbInsert,
  },
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
    // The host+path portion should still be present.
    expect(parsed.webhooks[0].url).toBe('https://webhook.example.com/hook');
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
    // Safe host+path should be present.
    expect(parsed.webhooks[0].url).toBe('https://hooks.example.com/path');
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
  });

  it('masks credential-bearing webhookUrl in the test_webhook response', async () => {
    const credentialUrl = 'https://admin:s3cr3t@hooks.example.com/test?api_key=mysecret';

    // First select: fetch the webhook row.
    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, name: 'Test Hook', url: credentialUrl },
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
    expect(parsed.webhookUrl).toBe('https://hooks.example.com/test');
  });

  it('masks encrypted URL in test_webhook — ciphertext not echoed', async () => {
    const encryptedUrl = 'enc:v1:CIPHERTEXT_XYZ';
    const decryptedUrl = 'https://user:token99@hooks.example.com/cb';

    mocks.decryptForColumn.mockImplementation(() => decryptedUrl);

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, name: 'Enc Test Hook', url: encryptedUrl },
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
    expect(parsed.webhookUrl).toBe('https://hooks.example.com/cb');
  });

  it('decrypt-failure in test_webhook — raw ciphertext not emitted', async () => {
    const encryptedUrl = 'enc:v1:BADKEY_CIPHERTEXT';

    mocks.decryptForColumn.mockImplementation(() => {
      throw new Error('bad decrypt');
    });
    mocks.redactUrlForLogs.mockImplementation((val: string) => realRedact(val));

    mocks.dbSelect.mockReturnValueOnce(makeSelectChain([
      { id: WEBHOOK_ID, name: 'Broken Hook', url: encryptedUrl },
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
});
