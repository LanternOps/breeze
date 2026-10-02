/**
 * W06 Task 10 (#7604): gateway connection writes and manual model entry.
 * Unit level — the DB is a chainable stub; the real-Postgres tenancy proofs
 * live in __tests__/integration/gatewayConnections.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Ordered log: validation, context entry, lock, writes. */
  calls: [] as string[],
  /** Rows the next awaited select resolves to, in order. */
  selectRows: [] as unknown[][],
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updated: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  deleted: [] as unknown[],
  insertReturning: null as null | ((v: Record<string, unknown>) => unknown[] | Promise<unknown[]>),
  updateReturning: null as null | ((set: Record<string, unknown>) => unknown[]),
  tryLock: true,
  outsideDepth: 0,
  systemDepth: 0,
  policy: vi.fn(async (u: string) => u.trim().replace(/\/+$/, '')),
  /** Context seen by the policy call: must be outside every DB context. */
  policyContexts: [] as Array<{ outside: number; system: number }>,
}));

vi.mock('./gateway/byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('./gateway/byoEndpointPolicy')>()),
  validateByoBaseUrl: (u: string) => {
    h.calls.push('validate');
    h.policyContexts.push({ outside: h.outsideDepth, system: h.systemDepth });
    return h.policy(u);
  },
}));

vi.mock('./registryWriteLock', () => ({
  tryLockPartnerRegistryWrite: async (partnerId: string) => {
    h.calls.push(`lock:${partnerId}`);
    return h.tryLock;
  },
}));

vi.mock('../../db', () => {
  /** `.returning(fields)` projects to the selected columns, as Drizzle does. */
  const project = (rows: unknown[], fields?: Record<string, unknown>) => (fields
    ? rows.map((r) => Object.fromEntries(Object.keys(fields).map((k) => [k, (r as Record<string, unknown>)[k]])))
    : rows);
  const selectChain = () => {
    const take = () => Promise.resolve(h.selectRows.shift() ?? []);
    const c: any = {
      from: () => c, where: () => c, orderBy: () => c, innerJoin: () => c,
      for: () => take(), limit: () => take(),
      then: (res: any, rej: any) => take().then(res, rej),
    };
    return c;
  };
  return {
    db: {
      select: () => selectChain(),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          h.inserted.push({ table, values });
          const ret = async (fields?: Record<string, unknown>) => {
            h.calls.push('insert');
            return project(await (h.insertReturning ? h.insertReturning(values) : [{ ...values }]), fields);
          };
          return { returning: ret, onConflictDoNothing: () => ({ returning: ret }) };
        },
      }),
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: () => {
            h.updated.push({ table, set });
            h.calls.push('update');
            const rows = h.updateReturning ? h.updateReturning(set) : [{ ...set }];
            const p: any = Promise.resolve(rows);
            p.returning = async (fields?: Record<string, unknown>) => project(rows, fields);
            return p;
          },
        }),
      }),
      delete: (table: unknown) => { h.deleted.push(table); return { where: async () => [] }; },
    },
    runOutsideDbContext: async (fn: () => unknown) => {
      h.outsideDepth += 1;
      try { return await fn(); } finally { h.outsideDepth -= 1; }
    },
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      h.calls.push('system');
      h.systemDepth += 1;
      try { return await fn(); } finally { h.systemDepth -= 1; }
    },
  };
});

import { partnerAiConnections, partnerAiModels } from '../../db/schema';
import { hmacFingerprint } from '../secretCrypto';
import { decryptConnectionKey } from './connections';
import { ByoEndpointRejected } from './gateway/byoEndpointPolicy';
import {
  createGatewayConnection,
  createManualOffering,
  createManualOfferingLocked,
  deleteGatewayConnection,
  isEnvManaged,
  isEnvReleased,
  MAX_MANUAL_OFFERINGS_PER_CONNECTION,
  updateGatewayConnection,
} from './gatewayConnections';
import { RegistryWriteError } from './registryWriteErrors';

const P = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const OFF = '44444444-4444-4444-8444-444444444444';
const RATES = { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 };
const saved = { key: process.env.APP_ENCRYPTION_KEY, keyId: process.env.APP_ENCRYPTION_KEY_ID };

const conn = (over: Record<string, unknown> = {}) => ({
  id: C, partnerId: P, kind: 'openai_compatible', status: 'active', configVersion: 5,
  providerConfig: null, baseUrl: 'https://a.example.com/v1', keyLast4: '3456', ...over,
});
const RELEASED = { managedBy: 'env', envModel: 'llama3', envReleasedAt: '2026-10-01T00:00:00.000Z' };
const caught = (p: Promise<unknown>) => p.then(
  () => { throw new Error('expected a rejection'); },
  (e: unknown) => e as RegistryWriteError,
);
const connUpdates = () => h.updated.filter((u) => u.table === partnerAiConnections);
const offeringUpdates = () => h.updated.filter((u) => u.table === partnerAiModels);

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = 'gateway-connections-unit-test-key';
  process.env.APP_ENCRYPTION_KEY_ID = 'gateway-connections-test';
  h.calls = [];
  h.selectRows = [];
  h.inserted = [];
  h.updated = [];
  h.deleted = [];
  h.insertReturning = null;
  h.updateReturning = null;
  h.tryLock = true;
  h.outsideDepth = 0;
  h.systemDepth = 0;
  h.policyContexts = [];
  h.policy.mockReset();
  h.policy.mockImplementation(async (u: string) => u.trim().replace(/\/+$/, ''));
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = saved.key;
  if (saved.keyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID; else process.env.APP_ENCRYPTION_KEY_ID = saved.keyId;
});

describe('isEnvManaged', () => {
  it('is true only for provider_config.managedBy = env', () => {
    expect(isEnvManaged({ providerConfig: { managedBy: 'env' } })).toBe(true);
    expect(isEnvManaged({ providerConfig: { managedBy: 'user' } })).toBe(false);
    expect(isEnvManaged({ providerConfig: null })).toBe(false);
  });

  it('a released env connection is still env-managed (read-only), and flagged released', () => {
    expect(isEnvManaged({ providerConfig: RELEASED })).toBe(true);
    expect(isEnvReleased({ providerConfig: RELEASED })).toBe(true);
    expect(isEnvReleased({ providerConfig: { managedBy: 'env' } })).toBe(false);
    expect(isEnvReleased({ providerConfig: { envReleasedAt: '2026-10-01T00:00:00.000Z' } })).toBe(false);
  });
});

describe('createGatewayConnection', () => {
  it('creates a keyless openai_compatible connection (triplet all null) and returns no key material', async () => {
    const created = await createGatewayConnection({ partnerId: P, name: ' Ollama ', baseUrl: 'http://ollama.lan:11434/v1/', connectedBy: 'u1' });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]!.table).toBe(partnerAiConnections);
    expect(h.inserted[0]!.values).toMatchObject({
      partnerId: P, kind: 'openai_compatible', name: 'Ollama', baseUrl: 'http://ollama.lan:11434/v1',
      apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null, providerConfig: null,
      configVersion: 1, status: 'active', connectedBy: 'u1', catalogEntryId: null,
    });
    expect(created).not.toHaveProperty('apiKeyEncrypted');
    expect(created).not.toHaveProperty('keyFingerprint');
  });

  it('seals the key to the row id (row-bound AAD) with last4 + fingerprint, never storing the plaintext', async () => {
    const key = 'sk-or-abcdef123456';
    await createGatewayConnection({ partnerId: P, name: 'OR', baseUrl: 'https://openrouter.ai/api/v1', apiKey: `  ${key} `, connectedBy: 'u1' });
    const row = h.inserted[0]!.values;
    expect(String(row.apiKeyEncrypted)).toMatch(/^enc:/);
    expect(row.keyLast4).toBe('3456');
    expect(row.keyFingerprint).toBe(hmacFingerprint(key));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(decryptConnectionKey({ id: String(row.id), apiKeyEncrypted: String(row.apiKeyEncrypted) })).toBe(key);
    expect(() => decryptConnectionKey({ id: OFF, apiKeyEncrypted: String(row.apiKeyEncrypted) })).toThrow();
  });

  it('validates the URL outside every DB context, before the registry transaction and its lock', async () => {
    await createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://a.example.com', connectedBy: null });
    expect(h.calls).toEqual(['validate', 'system', `lock:${P}`, 'insert']);
    expect(h.policyContexts).toEqual([{ outside: 1, system: 0 }]);
  });

  it('propagates the egress policy rejection and writes nothing (no lock taken)', async () => {
    h.policy.mockRejectedValueOnce(new ByoEndpointRejected('private', 'egress_blocked'));
    await expect(createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://10.0.0.1', connectedBy: null }))
      .rejects.toBeInstanceOf(ByoEndpointRejected);
    expect(h.inserted).toHaveLength(0);
    expect(h.calls).toEqual(['validate']);
  });

  it('refuses a key starting with the encrypted-value prefix (400 invalid, nothing written)', async () => {
    const err = await caught(createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://a.example.com', apiKey: 'enc:v3:xyzxyzxyz', connectedBy: null }));
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect([err.code, err.status]).toEqual(['invalid', 400]);
    expect(err.message).toMatch(/prefix/);
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses a key shorter than 8 characters (the gateway scrubber cannot redact it)', async () => {
    const err = await caught(createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://a.example.com', apiKey: ' abc ', connectedBy: null }));
    expect([err.code, err.status]).toEqual(['invalid', 400]);
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses an empty name', async () => {
    const err = await caught(createGatewayConnection({ partnerId: P, name: '   ', baseUrl: 'https://a.example.com', connectedBy: null }));
    expect([err.code, err.status]).toEqual(['invalid', 422]);
    expect(h.inserted).toHaveLength(0);
  });

  it('marks an env-managed connection in provider_config', async () => {
    await createGatewayConnection({ partnerId: P, name: 'Env', baseUrl: 'https://a.example.com', connectedBy: null, managedBy: 'env' });
    expect(h.inserted[0]!.values.providerConfig).toEqual({ managedBy: 'env' });
  });

  it('a held registry lock is a 503 registry_busy and nothing is written', async () => {
    h.tryLock = false;
    const err = await caught(createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://a.example.com', connectedBy: null }));
    expect([err.code, err.status]).toEqual(['registry_busy', 503]);
    expect(h.inserted).toHaveLength(0);
  });

  it('scrubs an insert failure: no ciphertext or key in the surfaced error', async () => {
    h.insertReturning = (v) => {
      const pg = Object.assign(new Error('check violation'), {
        code: '23514', constraint_name: 'partner_ai_connections_shape_chk', query: 'insert', parameters: [v.apiKeyEncrypted, v.keyFingerprint],
      });
      throw Object.assign(new Error(`Failed query: insert params: ${String(v.apiKeyEncrypted)}`), { name: 'DrizzleQueryError', params: [v.apiKeyEncrypted], cause: pg });
    };
    const key = 'sk-secret-key-123456';
    const err = await caught(createGatewayConnection({ partnerId: P, name: 'x', baseUrl: 'https://a.example.com', apiKey: key, connectedBy: null }));
    expect(err).toBeInstanceOf(RegistryWriteError);
    const surfaced = `${err.message} ${String(err.cause)} ${JSON.stringify(err.details ?? {})}`;
    expect(surfaced).not.toContain('enc:');
    expect(surfaced).not.toContain(key);
  });
});

describe('updateGatewayConnection', () => {
  it('stale config_version → 409 stale_write, nothing written', async () => {
    h.selectRows = [[conn()]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com', expectedConfigVersion: 4 }));
    expect([err.code, err.status]).toEqual(['stale_write', 409]);
    expect(h.updated).toHaveLength(0);
  });

  it('a concurrent bump between the read and the write is also stale_write', async () => {
    h.selectRows = [[conn()]];
    h.updateReturning = () => [];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['stale_write', 409]);
  });

  it('endpoint change: bumps config_version, clears last_error, uses the validated URL; null apiKey clears the triplet', async () => {
    h.selectRows = [[conn()]];
    await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: ' https://b.example.com/v1/ ', apiKey: null, expectedConfigVersion: 5 });
    expect(connUpdates()).toHaveLength(1);
    expect(connUpdates()[0]!.set).toMatchObject({
      baseUrl: 'https://b.example.com/v1', configVersion: 6, lastError: null, status: 'active',
      apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null,
    });
  });

  it('a base-URL change never writes offerings (verification goes stale by fingerprint) and never sets capabilities', async () => {
    h.selectRows = [[conn()]];
    await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com/v1', apiKey: 'sk-new-key-123', expectedConfigVersion: 5 });
    expect(offeringUpdates()).toHaveLength(0);
    expect(JSON.stringify(h.updated.map((u) => u.set))).not.toContain('capabilities');
  });

  it('key rotation: re-seals to the row id, keeps the URL, bumps config_version', async () => {
    h.selectRows = [[conn()]];
    const key = 'sk-rotated-key-9876';
    const out = await updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: key, expectedConfigVersion: 5 });
    const set = connUpdates()[0]!.set;
    expect(set).not.toHaveProperty('baseUrl');
    expect(set.configVersion).toBe(6);
    expect(set.keyLast4).toBe('9876');
    expect(set.keyFingerprint).toBe(hmacFingerprint(key));
    expect(decryptConnectionKey({ id: C, apiKeyEncrypted: String(set.apiKeyEncrypted) })).toBe(key);
    expect(JSON.stringify(set)).not.toContain(key);
    expect(offeringUpdates()).toHaveLength(0);
    expect(out).not.toHaveProperty('apiKeyEncrypted');
    expect(out).not.toHaveProperty('keyFingerprint');
  });

  it('validates a new URL outside every DB context before taking the lock; a rejection writes nothing', async () => {
    h.selectRows = [[conn()]];
    h.policy.mockRejectedValueOnce(new ByoEndpointRejected('blocked', 'egress_blocked'));
    await expect(updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://169.254.169.254', expectedConfigVersion: 5 }))
      .rejects.toBeInstanceOf(ByoEndpointRejected);
    expect(h.calls).toEqual(['validate']);
    expect(h.policyContexts).toEqual([{ outside: 1, system: 0 }]);
  });

  it('a key-only change does not re-validate the URL', async () => {
    h.selectRows = [[conn()]];
    await updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 5 });
    expect(h.calls).not.toContain('validate');
  });

  it('env-managed connections are read-only (409 managed_by_env) unless the env bootstrap says so', async () => {
    h.selectRows = [[conn({ providerConfig: { managedBy: 'env' }, configVersion: 1 })]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 1 }));
    expect([err.code, err.status]).toEqual(['managed_by_env', 409]);
    expect(h.updated).toHaveLength(0);

    h.selectRows = [[conn({ providerConfig: { managedBy: 'env' }, configVersion: 1 })]];
    await updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 1, allowManaged: true });
    expect(connUpdates()).toHaveLength(1);
  });

  it('a non-gateway connection is not found here (404 — the compat flows own it)', async () => {
    h.selectRows = [[conn({ kind: 'anthropic_byok', baseUrl: null })]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'x'.repeat(20), expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['not_found', 404]);
  });

  it('a disconnected connection is never edited or re-activated (404)', async () => {
    h.selectRows = [[conn({ status: 'disconnected' })]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['not_found', 404]);
    expect(h.updated).toHaveLength(0);
  });

  it('a missing (or other partner\'s) connection is 404', async () => {
    h.selectRows = [[]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, apiKey: 'sk-new-key-123', expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['not_found', 404]);
  });

  describe('the stored key never follows a new endpoint', () => {
    it.each([
      ['another origin', 'https://b.example.com/v1'],
      ['another path on the same origin', 'https://a.example.com/other/v1'],
      ['another port', 'https://a.example.com:8443/v1'],
    ])('%s without apiKey → 422 key_required_for_new_endpoint, nothing written', async (_label, url) => {
      h.selectRows = [[conn()]];
      const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: url, expectedConfigVersion: 5 }));
      expect(err).toBeInstanceOf(RegistryWriteError);
      expect([err.code, err.status]).toEqual(['key_required_for_new_endpoint', 422]);
      expect(err.message).toBe('Enter the key for the new URL (or remove the key).');
      expect(h.updated).toHaveLength(0);
    });

    it('a new URL with a new key, or with the key removed (null), is accepted', async () => {
      h.selectRows = [[conn()]];
      await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com/v1', apiKey: 'sk-new-key-123', expectedConfigVersion: 5 });
      h.selectRows = [[conn()]];
      await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com/v1', apiKey: null, expectedConfigVersion: 5 });
      expect(connUpdates()).toHaveLength(2);
      expect(connUpdates()[1]!.set).toMatchObject({ baseUrl: 'https://b.example.com/v1', apiKeyEncrypted: null });
    });

    it('re-submitting the same URL without a key is not an endpoint change', async () => {
      h.selectRows = [[conn()]];
      await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://a.example.com/v1/', expectedConfigVersion: 5 });
      expect(connUpdates()).toHaveLength(1);
    });

    it('a keyless connection may move without a key (there is no key to carry)', async () => {
      h.selectRows = [[conn({ keyLast4: null })]];
      await updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com/v1', expectedConfigVersion: 5 });
      expect(connUpdates()[0]!.set).toMatchObject({ baseUrl: 'https://b.example.com/v1' });
      expect(connUpdates()[0]!.set).not.toHaveProperty('apiKeyEncrypted');
    });

    it('applies to the env bootstrap too (it always sends the configured key with a new URL)', async () => {
      h.selectRows = [[conn({ providerConfig: { managedBy: 'env' } })]];
      const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://b.example.com/v1', expectedConfigVersion: 5, allowManaged: true }));
      expect(err.code).toBe('key_required_for_new_endpoint');
    });
  });

  it('a released env connection stays read-only: URL and key writes refused (409 managed_by_env)', async () => {
    h.selectRows = [[conn({ providerConfig: RELEASED })]];
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, baseUrl: 'https://evil.example.net/v1', apiKey: 'sk-mine-12345', expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['managed_by_env', 409]);
    expect(h.updated).toHaveLength(0);
  });

  it('refuses an update that changes neither the URL nor the key', async () => {
    const err = await caught(updateGatewayConnection({ partnerId: P, connectionId: C, expectedConfigVersion: 5 }));
    expect([err.code, err.status]).toEqual(['invalid', 422]);
    expect(h.calls).toEqual([]);
  });
});

describe('deleteGatewayConnection (soft-disconnect)', () => {
  it('disconnects: status, key triplet NULL, config_version bumped, base_url kept, offerings disabled, nothing deleted', async () => {
    h.selectRows = [[conn()], [{ id: OFF }], []];
    await deleteGatewayConnection({ partnerId: P, connectionId: C });
    expect(h.deleted).toHaveLength(0);
    expect(connUpdates()).toHaveLength(1);
    const set = connUpdates()[0]!.set;
    expect(set).toMatchObject({
      status: 'disconnected', apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null, lastError: null, configVersion: 6,
    });
    expect(set).not.toHaveProperty('baseUrl');
    expect(offeringUpdates()).toHaveLength(1);
    expect(offeringUpdates()[0]!.set).toMatchObject({ enabled: false });
    expect(h.calls.slice(0, 2)).toEqual(['system', `lock:${P}`]);
  });

  it('an offering that is still an assignment default blocks it: 409 connection_in_use listing the surfaces', async () => {
    h.selectRows = [[conn()], [{ id: OFF }], [
      { surface: 'chat', orgId: null },
      { surface: 'chat', orgId: '55555555-5555-4555-8555-555555555555' },
      { surface: 'script_reviewer', orgId: null },
    ]];
    const err = await caught(deleteGatewayConnection({ partnerId: P, connectionId: C }));
    expect([err.code, err.status]).toEqual(['connection_in_use', 409]);
    expect(err.details?.surfaces).toEqual(['chat', 'script_reviewer']);
    expect(err.details?.inUse).toHaveLength(3);
    expect(h.updated).toHaveLength(0);
  });

  it('a connection with no offerings skips the assignment lookup', async () => {
    h.selectRows = [[conn()], []];
    await deleteGatewayConnection({ partnerId: P, connectionId: C });
    expect(connUpdates()).toHaveLength(1);
    expect(h.selectRows).toEqual([]);
  });

  it('env-managed → 409 managed_by_env', async () => {
    h.selectRows = [[conn({ providerConfig: { managedBy: 'env' } })]];
    const err = await caught(deleteGatewayConnection({ partnerId: P, connectionId: C }));
    expect([err.code, err.status]).toEqual(['managed_by_env', 409]);
    expect(h.updated).toHaveLength(0);
  });

  it('a released env connection can be disconnected by the partner (its only permitted write)', async () => {
    h.selectRows = [[conn({ providerConfig: RELEASED })], []];
    await deleteGatewayConnection({ partnerId: P, connectionId: C });
    expect(connUpdates()).toHaveLength(1);
    expect(connUpdates()[0]!.set).toMatchObject({ status: 'disconnected', apiKeyEncrypted: null });
  });

  it('already disconnected, non-gateway or missing → 404', async () => {
    for (const rows of [[conn({ status: 'disconnected' })], [conn({ kind: 'catalog', baseUrl: null })], []]) {
      h.selectRows = [rows];
      const err = await caught(deleteGatewayConnection({ partnerId: P, connectionId: C }));
      expect([err.code, err.status]).toEqual(['not_found', 404]);
    }
    expect(h.updated).toHaveLength(0);
  });
});

describe('createManualOffering', () => {
  it('lands disabled, unverified (capabilities NULL), unpriced, source manual', async () => {
    h.selectRows = [[conn()], []];
    const off = await createManualOffering({ partnerId: P, connectionId: C, modelId: 'qwen2.5-coder:7b', displayName: ' Qwen coder ' });
    const row = h.inserted.at(-1)!;
    expect(row.table).toBe(partnerAiModels);
    expect(row.values).toMatchObject({
      partnerId: P, connectionId: C, modelId: 'qwen2.5-coder:7b', displayName: 'Qwen coder', source: 'manual',
      enabled: false, capabilities: null, platformModelId: null, lifecycle: 'available',
      priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null,
    });
    expect(off).toMatchObject({ source: 'manual', enabled: false });
    expect(h.calls.slice(0, 2)).toEqual(['system', `lock:${P}`]);
  });

  it('stores all four prices when given (0 is a valid local-model price)', async () => {
    h.selectRows = [[conn()], []];
    await createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3', prices: RATES });
    expect(h.inserted.at(-1)!.values).toMatchObject({
      priceInputCentsPerM: 0, priceOutputCentsPerM: 0, priceCacheReadCentsPerM: 0, priceCacheWriteCentsPerM: 0,
    });
  });

  it('never takes capabilities from the caller', async () => {
    h.selectRows = [[conn()], []];
    await createManualOffering({
      partnerId: P, connectionId: C, modelId: 'llama3',
      ...({ capabilities: { tool_use: { supported: true }, breeze_verification: { passed: true } } } as object),
    } as Parameters<typeof createManualOffering>[0]);
    expect(h.inserted.at(-1)!.values.capabilities).toBeNull();
  });

  it('an existing (connection, model) → 409 duplicate_model, nothing inserted', async () => {
    h.selectRows = [[conn()], [{ id: OFF }]];
    const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' }));
    expect([err.code, err.status]).toEqual(['duplicate_model', 409]);
    expect(h.inserted).toHaveLength(0);
  });

  it('a conflicting insert (no row returned) is also duplicate_model', async () => {
    h.selectRows = [[conn()], []];
    h.insertReturning = () => [];
    const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' }));
    expect([err.code, err.status]).toEqual(['duplicate_model', 409]);
  });

  it('refuses a non-gateway, disconnected or missing connection (404)', async () => {
    for (const rows of [[conn({ kind: 'anthropic_byok', baseUrl: null })], [conn({ status: 'disconnected' })], []]) {
      h.selectRows = [rows];
      const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' }));
      expect([err.code, err.status]).toEqual(['not_found', 404]);
    }
    expect(h.inserted).toHaveLength(0);
  });

  it('refuses a model id the endpoint could not have (422 invalid)', async () => {
    const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'bad id <script>' }));
    expect([err.code, err.status]).toEqual(['invalid', 422]);
    expect(h.inserted).toHaveLength(0);
  });

  it('an env-managed connection (managed or released) takes no hand-entered model: 409 managed_by_env', async () => {
    for (const providerConfig of [{ managedBy: 'env' }, RELEASED]) {
      h.selectRows = [[conn({ providerConfig })], []];
      const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' }));
      expect([err.code, err.status]).toEqual(['managed_by_env', 409]);
    }
    expect(h.inserted).toHaveLength(0);
  });

  it('the env bootstrap itself can still add its model (allowManaged, inside its own locked write)', async () => {
    h.selectRows = [[conn({ providerConfig: { managedBy: 'env' } })], [], [{ n: 0 }]];
    await createManualOfferingLocked({ partnerId: P, connectionId: C, modelId: 'llama3', allowManaged: true });
    expect(h.inserted).toHaveLength(1);
  });

  it('caps hand-entered models per connection: one past the cap is 409 too_many_models, nothing inserted', async () => {
    expect(MAX_MANUAL_OFFERINGS_PER_CONNECTION).toBe(200);
    h.selectRows = [[conn()], [], [{ n: MAX_MANUAL_OFFERINGS_PER_CONNECTION }]];
    const err = await caught(createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' }));
    expect([err.code, err.status]).toEqual(['too_many_models', 409]);
    expect(h.inserted).toHaveLength(0);

    h.selectRows = [[conn()], [], [{ n: MAX_MANUAL_OFFERINGS_PER_CONNECTION - 1 }]];
    await createManualOffering({ partnerId: P, connectionId: C, modelId: 'llama3' });
    expect(h.inserted).toHaveLength(1);
  });
});
