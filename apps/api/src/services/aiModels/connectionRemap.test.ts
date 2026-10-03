import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// SQL-shape unit coverage ported from the deleted compatRemap.test.ts (W03
// #7601 Task 6B), now id-keyed (W08 #7606). Real-Postgres behaviour is pinned
// by aiModelConnectionLifecycle.integration.test.ts.

const P = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const m = vi.hoisted(() => ({
  scope: 'system' as string | undefined,
  statements: [] as Array<{ text: string; params: unknown[] }>,
  respond: (_text: string, _params: unknown[]): unknown[] => [],
  createConnection: vi.fn(),
  ensurePlatformModelRow: vi.fn(),
}));

const dialect = new PgDialect();
vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => (m.scope ? { scope: m.scope } : undefined),
  db: {
    execute: vi.fn(async (query: unknown) => {
      const { sql: text, params } = dialect.sqlToQuery(query as never);
      const normalized = text.replace(/\s+/g, ' ').trim();
      m.statements.push({ text: normalized, params });
      return m.respond(normalized, params);
    }),
  },
}));
vi.mock('./connections', () => ({
  createConnection: m.createConnection,
  encryptConnectionKey: (id: string, key: string) => `sealed:${id}:${key.length}`,
}));
vi.mock('./registryBootstrap', () => ({
  ensurePlatformModelRow: m.ensurePlatformModelRow,
  resolveBootstrapDefaultModelId: async () => 'bootstrap-default',
}));
vi.mock('../secretCrypto', () => ({ hmacFingerprint: () => 'fp' }));

import {
  connectAnthropicConnection,
  connectionPrimaryModelId,
  disconnectAnthropicConnection,
  lockAnthropicConnection,
  lockAnthropicConnectionIds,
  remapPartnerOfferings,
  RegistryNotCutOverError,
  rotateAnthropicConnectionKey,
  switchAnthropicConnectionKind,
} from './connectionRemap';

const writes = () => m.statements.filter((s) => /^(WITH .*?\) )?(UPDATE|INSERT|DELETE)/.test(s.text) || /^(UPDATE|INSERT|DELETE)/.test(s.text));
const deletes = () => m.statements.filter((s) => /\bDELETE FROM\b/.test(s.text));
const LOCKED = { id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, config_version: 3, connected_by: null, verified_at: null };

/** A partner with registry rows, and (unless overridden) a legacy table that still exists. */
function baseRespond(extra: (text: string, params: unknown[]) => unknown[] | undefined = () => undefined) {
  return (text: string, params: unknown[]): unknown[] => {
    const hit = extra(text, params);
    if (hit) return hit;
    if (text.includes('FROM ai_model_registry_partner_cutover')) return [{ ok: 1 }];
    if (text.includes("to_regclass('public.partner_llm_configs')")) return [{ present: true }];
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.scope = 'system';
  m.statements = [];
  m.respond = baseRespond();
});

describe('remapPartnerOfferings (registry-native id remaps, never a re-projection)', () => {
  it('touches exactly the four reference sites, by array_replace, and only live sessions', async () => {
    m.respond = () => [{ id: 'x' }];
    const counts = await remapPartnerOfferings(P, new Map([[A, B]]));
    expect(counts).toEqual({ assignments: 1, agents: 1, sessions: 1, offerings: 1 });

    const [assign, agents, sessions, offerings] = m.statements;
    expect(assign!.text).toMatch(/^UPDATE ai_model_assignments SET default_offering_id = CASE/);
    expect(assign!.text).toContain('unnest(array_replace(permitted_offering_ids,');
    expect(assign!.text).toContain('unnest(array_replace(fallback_offering_ids,');
    expect(assign!.text).toContain('WHERE offering_partner_id =');
    expect(agents!.text).toMatch(/^UPDATE ai_agents SET offering_id = /);
    expect(sessions!.text).toMatch(/^UPDATE ai_sessions SET offering_id = /);
    expect(sessions!.text).toContain("status = 'active'");
    expect(offerings!.text).toMatch(/^UPDATE partner_ai_models SET refusal_fallback_offering_id = /);
    for (const s of m.statements) {
      expect(s.params).toContain(A);
      expect(s.params).toContain(B);
      expect(s.params).toContain(P);
    }
  });

  it('never deletes an assignment and never touches options or allow_user_choice', async () => {
    await remapPartnerOfferings(P, new Map([[A, B], [B, A]]));
    expect(deletes()).toEqual([]);
    for (const s of m.statements) {
      expect(s.text).not.toMatch(/\boptions\b/);
      expect(s.text).not.toMatch(/allow_user_choice/);
    }
  });

  it('can leave platform-pinned surfaces (patch_test) where they are', async () => {
    await remapPartnerOfferings(P, new Map([[A, B]]), { skipSurfaces: ['patch_test'] });
    expect(m.statements[0]!.text).toContain('surface NOT IN (');
    expect(m.statements[0]!.params).toContain('patch_test');
  });

  it('refuses to run outside a held system context', async () => {
    m.scope = 'partner';
    await expect(remapPartnerOfferings(P, new Map([[A, B]]))).rejects.toThrow(/system/);
    expect(m.statements).toEqual([]);
  });

  it('moves a refusal fallback only on rows on the TARGET offering\'s connection (never across connections)', async () => {
    await remapPartnerOfferings(P, new Map([[A, B]]));
    const refusal = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_models SET refusal_fallback_offering_id'))!;
    expect(refusal.text).toMatch(/AND connection_id IS NOT DISTINCT FROM \(SELECT t\.connection_id FROM partner_ai_models t WHERE t\.id = \$\d+::uuid AND t\.partner_id = \$\d+::uuid\)/);
  });

  it('collapses a duplicate the replace creates in permitted / fallback lists, first occurrence kept, NULL stays NULL', async () => {
    await remapPartnerOfferings(P, new Map([[A, B]]));
    const assign = m.statements[0]!.text;
    for (const col of ['permitted_offering_ids', 'fallback_offering_ids']) {
      expect(assign).toContain(`${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE ARRAY( SELECT x FROM unnest(array_replace(${col},`);
    }
    expect(assign.match(/WITH ORDINALITY AS t\(x, n\) GROUP BY x ORDER BY min\(n\)\)/g)).toHaveLength(2);
  });
});

describe('connectionPrimaryModelId (the one model a connection\'s endpoint is validated and probed against)', () => {
  const chatOnConnection = (t: string) => t.includes("a.surface = 'chat'") && t.includes('AND m.connection_id =');
  const ownOfferings = (t: string) => t.startsWith('WITH assignment_rows') && t.includes('AND m.enabled');
  const chatAnywhere = (t: string) => t.includes("a.surface = 'chat'") && !t.includes('AND m.connection_id =');

  it('(a) the partner chat default when that offering is on this connection — nothing else is read', async () => {
    m.respond = baseRespond((t) => (chatOnConnection(t) ? [{ model_id: 'chat-on-conn' }] : undefined));
    await expect(connectionPrimaryModelId(P, CONN)).resolves.toBe('chat-on-conn');
    expect(m.statements).toHaveLength(1);
    expect(m.statements[0]!.params).toEqual(expect.arrayContaining([P, CONN]));
  });

  it('(b)/(c) else an enabled offering on it: referenced first, an assignment default first among those, then oldest', async () => {
    m.respond = baseRespond((t) => (ownOfferings(t) ? [{ model_id: 'own' }] : undefined));
    await expect(connectionPrimaryModelId(P, CONN)).resolves.toBe('own');
    const own = m.statements.find((s) => ownOfferings(s.text))!;
    expect(own.text).toMatch(/ORDER BY \(m\.id IN \(SELECT id FROM refs WHERE id IS NOT NULL\)\) DESC, \(m\.id IN \(SELECT default_offering_id FROM assignment_rows WHERE default_offering_id IS NOT NULL\)\) DESC, m\.created_at, m\.id LIMIT 1$/);
    expect(own.params).toEqual(expect.arrayContaining([P, CONN]));
    expect(m.statements.some((s) => chatAnywhere(s.text))).toBe(false);
  });

  it('(d) else the partner chat default model wherever it lives, then the bootstrap default', async () => {
    m.respond = baseRespond((t) => (chatAnywhere(t) ? [{ model_id: 'chat-elsewhere' }] : undefined));
    await expect(connectionPrimaryModelId(P, CONN)).resolves.toBe('chat-elsewhere');
    m.respond = baseRespond();
    await expect(connectionPrimaryModelId(P, CONN)).resolves.toBe('bootstrap-default');
  });

  it('refuses to run outside a held system context', async () => {
    m.scope = 'partner';
    await expect(connectionPrimaryModelId(P, CONN)).rejects.toThrow(/system/);
  });
});

describe('the gate: no registry-native write before the partner has its registry rows', () => {
  it.each([
    ['connectAnthropicConnection', () => connectAnthropicConnection(P, { kind: 'anthropic_byok', apiKey: 'sk-ant-x', catalogEntryId: null, connectedBy: null, movePlatformReferences: true })],
    ['disconnectAnthropicConnection', () => disconnectAnthropicConnection(P, CONN)],
    ['rotateAnthropicConnectionKey', () => rotateAnthropicConnectionKey(P, CONN, { apiKey: 'sk-ant-x', connectedBy: null, verifiedAt: new Date() })],
    ['switchAnthropicConnectionKind', () => switchAnthropicConnectionKind(P, CONN, { kind: 'catalog', catalogEntryId: 'e1' })],
  ])('%s throws RegistryNotCutOverError and writes nothing', async (_name, run) => {
    m.respond = (text) => (text.includes('FROM ai_model_registry_partner_cutover') ? [] : [{ id: 'x' }]);
    await expect(run()).rejects.toBeInstanceOf(RegistryNotCutOverError);
    expect(writes()).toEqual([]);
    expect(m.createConnection).not.toHaveBeenCalled();
  });
});

describe('locks never see a soft-disconnected connection (#7700 finding 1)', () => {
  it('lockAnthropicConnection and lockAnthropicConnectionIds exclude disconnected rows and pin the partner', async () => {
    await lockAnthropicConnection(P, CONN);
    await lockAnthropicConnectionIds(P);
    for (const s of m.statements) {
      expect(s.text).toContain("status <> 'disconnected'");
      expect(s.text).toContain('FOR UPDATE');
      expect(s.params).toContain(P);
    }
  });
});

describe('connectAnthropicConnection', () => {
  it('creates the connection, moves platform references onto it (patch_test stays), and disables what no longer routes', async () => {
    m.createConnection.mockResolvedValue({ id: CONN });
    m.respond = baseRespond((text) => {
      if (text.includes('FROM partner_ai_connections') && text.includes('SELECT kind')) return [{ kind: 'anthropic_byok' }];
      if (text.startsWith('WITH') && text.includes('SELECT m.id, COALESCE(m.model_id, pm.model_id) AS model_id')) return [{ id: A, model_id: 'm1' }];
      if (text.startsWith('SELECT id FROM ai_platform_models')) return [{ id: 'pm1' }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: B }];
      return undefined;
    });
    const id = await connectAnthropicConnection(P, { kind: 'anthropic_byok', apiKey: 'sk-ant-x', catalogEntryId: null, connectedBy: null, movePlatformReferences: true });
    expect(id).toBe(CONN);
    expect(m.createConnection).toHaveBeenCalledWith(expect.objectContaining({ partnerId: P, kind: 'anthropic_byok', apiKey: 'sk-ant-x' }));

    const referenced = m.statements.find((s) => s.text.includes('AS model_id'))!;
    expect(referenced.text).toContain('surface NOT IN (');
    expect(referenced.params).toContain('patch_test');
    expect(referenced.text).toContain('m.connection_id IS NULL');

    const insert = m.statements.find((s) => s.text.startsWith('INSERT INTO partner_ai_models'))!;
    expect(insert.params).toEqual(expect.arrayContaining([P, CONN, 'm1', 'discovered', 'pm1', true]));
    // spec §8: a BYOK offering never carries a guessed (legacy) price.
    expect(insert.text).not.toContain('price_');

    const remap = m.statements.find((s) => s.text.startsWith('UPDATE ai_model_assignments SET default_offering_id = CASE'))!;
    expect(remap.params).toEqual(expect.arrayContaining([A, B]));
    expect(remap.params).toContain('patch_test');

    const disable = m.statements.find((s) => s.text.includes('SET enabled = false'))!;
    expect(disable.params).toContain(A);
    expect(disable.text).toContain('NOT IN (SELECT id FROM refs');
    expect(deletes()).toEqual([]);
  });

  it('a non-first connection moves nothing', async () => {
    m.createConnection.mockResolvedValue({ id: CONN });
    await connectAnthropicConnection(P, { kind: 'anthropic_byok', apiKey: 'sk-ant-x', catalogEntryId: null, connectedBy: null, movePlatformReferences: false });
    expect(m.statements.some((s) => s.text.startsWith('UPDATE ai_model_assignments'))).toBe(false);
  });
});

describe('disconnectAnthropicConnection', () => {
  it('returns only that connection\'s references to platform offerings, then SOFT-disconnects it and purges the legacy key copy', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [LOCKED];
      if (text.startsWith('WITH') && text.includes('AS model_id')) return [{ id: B, model_id: 'm1' }];
      if (text.startsWith('SELECT id FROM ai_platform_models')) return [{ id: 'pm1' }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: A }];
      return undefined;
    });
    expect(await disconnectAnthropicConnection(P, CONN)).toBe(true);
    const lock = m.statements.find((s) => s.text.includes('FOR UPDATE'))!;
    expect(lock.params).toEqual(expect.arrayContaining([CONN, P]));
    const referenced = m.statements.find((s) => s.text.includes('AS model_id'))!;
    expect(referenced.text).not.toContain('surface NOT IN (');
    expect(referenced.params).toContain(CONN);
    const insert = m.statements.find((s) => s.text.startsWith('INSERT INTO partner_ai_models'))!;
    expect(insert.text).toContain("'platform'");
    expect(insert.text).toContain('ON CONFLICT (partner_id, platform_model_id) WHERE connection_id IS NULL DO UPDATE SET enabled = true');
    // Never deleted: a delete cascades to offerings in-flight turns are bound to.
    // The only delete is the frozen legacy row holding the revoked key (finding 4).
    expect(deletes().map((d) => d.text)).toEqual(['DELETE FROM partner_llm_configs WHERE partner_id = $1::uuid']);
    expect(deletes()[0]!.params).toEqual([P]);
    const soft = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_connections SET'))!;
    expect(soft.text).toContain("status = 'disconnected'");
    expect(soft.text).toContain('api_key_encrypted = NULL, key_last4 = NULL, key_fingerprint = NULL');
    expect(soft.text).toContain('config_version = config_version + 1');
    expect(soft.params).toContain(CONN);
    const disable = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_models SET enabled = false'))!;
    expect(disable.params).toContain(CONN);
    const order = m.statements.map((s) => s.text);
    expect(order.indexOf(soft.text)).toBeGreaterThan(order.findIndex((t) => t.startsWith('UPDATE ai_model_assignments')));
  });

  it('is a no-op (false) when the id is not a live Anthropic connection of the partner', async () => {
    expect(await disconnectAnthropicConnection(P, CONN)).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('a model with no platform row falls back to the bootstrap default; none available is an actionable 409', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [LOCKED];
      if (text.startsWith('WITH') && text.includes('AS model_id')) return [{ id: B, model_id: 'tenant-typed' }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: A }];
      return undefined;
    });
    m.ensurePlatformModelRow.mockResolvedValueOnce({ id: 'pm-boot', created: false });
    await disconnectAnthropicConnection(P, CONN);
    expect(m.ensurePlatformModelRow).toHaveBeenCalledWith('bootstrap-default');
    expect(m.statements.find((s) => s.text.startsWith('INSERT INTO partner_ai_models'))!.params).toContain('pm-boot');

    m.statements = [];
    m.ensurePlatformModelRow.mockResolvedValueOnce(null);
    await expect(disconnectAnthropicConnection(P, CONN)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('No platform AI model') });
  });

  it('skips the legacy purge once W08b has dropped the table (rollback-safe)', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [LOCKED];
      if (text.includes("to_regclass('public.partner_llm_configs')")) return [{ present: false }];
      return undefined;
    });
    expect(await disconnectAnthropicConnection(P, CONN)).toBe(true);
    expect(deletes()).toEqual([]);
  });
});

describe('rotateAnthropicConnectionKey', () => {
  it('rotates in place by id and drops the legacy partner_llm_configs copy of the revoked key (#7700 finding 4)', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [LOCKED];
      if (text.startsWith('UPDATE partner_ai_connections SET')) return [{ config_version: 4 }];
      return undefined;
    });
    expect(await rotateAnthropicConnectionKey(P, CONN, { apiKey: 'sk-new-key-0001', connectedBy: null, verifiedAt: new Date() }))
      .toEqual({ configVersion: 4 });
    const update = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_connections SET'))!;
    expect(update.params).toEqual(expect.arrayContaining([CONN, P, '0001']));
    expect(deletes().map((d) => d.text)).toEqual(['DELETE FROM partner_llm_configs WHERE partner_id = $1::uuid']);
    expect(deletes()[0]!.params).toEqual([P]);
  });

  it('a disconnected (or foreign) id is refused before any write', async () => {
    await expect(rotateAnthropicConnectionKey(P, CONN, { apiKey: 'sk-new-key-0001', connectedBy: null, verifiedAt: new Date() }))
      .rejects.toMatchObject({ name: 'AnthropicConnectionMissingError' });
    expect(writes()).toEqual([]);
  });
});

describe('switchAnthropicConnectionKind (in place)', () => {
  it('BYOK → catalog converts the offerings to the catalog shape and keeps the connection id; no remap, no delete', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [LOCKED];
      if (text.startsWith('SELECT name FROM llm_provider_catalog')) return [{ name: 'Gateway' }];
      if (text.startsWith('UPDATE partner_ai_connections SET')) return [{ config_version: 4 }];
      return undefined;
    });
    expect(await switchAnthropicConnectionKind(P, CONN, { kind: 'catalog', catalogEntryId: 'e1' })).toEqual({ connectionId: CONN, configVersion: 4 });
    const offerings = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_models SET'))!;
    expect(offerings.text).toContain("source = 'catalog', platform_model_id = NULL, capabilities = NULL");
    expect(offerings.params).toEqual(expect.arrayContaining([P, CONN]));
    const conn = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_connections SET'))!;
    expect(conn.params).toEqual(expect.arrayContaining(['catalog', 'e1', 'Gateway', CONN, P]));
    expect(m.statements.some((s) => s.text.startsWith('UPDATE ai_model_assignments'))).toBe(false);
    expect(deletes()).toEqual([]);
    expect(m.createConnection).not.toHaveBeenCalled();
  });

  it('a switch to the kind it already has is refused (stale)', async () => {
    m.respond = baseRespond((text) => (text.includes('FOR UPDATE') ? [LOCKED] : undefined));
    await expect(switchAnthropicConnectionKind(P, CONN, { kind: 'anthropic_byok', catalogEntryId: null }))
      .rejects.toMatchObject({ name: 'AnthropicConnectionMissingError' });
    expect(writes()).toEqual([]);
  });
});
