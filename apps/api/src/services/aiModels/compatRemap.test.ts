import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const P = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const m = vi.hoisted(() => ({
  scope: 'system' as string | undefined,
  statements: [] as Array<{ text: string; params: unknown[] }>,
  respond: (_text: string, _params: unknown[]): unknown[] => [],
  createConnection: vi.fn(),
  ensureLegacyPlatformModel: vi.fn(),
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
vi.mock('../aiModel', () => ({ resolveDefaultModel: () => 'env-default' }));
vi.mock('./legacySurfaceModels', () => ({
  getLegacyModelRates: () => ({ rates: { inputCentsPerM: 1, outputCentsPerM: 2, cacheReadCentsPerM: 3, cacheWriteCentsPerM: 4 }, source: 'priced' }),
}));
vi.mock('./connections', () => ({
  createConnection: m.createConnection,
  encryptConnectionKey: (id: string, key: string) => `sealed:${id}:${key.length}`,
}));
vi.mock('./legacyReconcile', () => ({ ensureLegacyPlatformModel: m.ensureLegacyPlatformModel }));
vi.mock('../secretCrypto', () => ({ hmacFingerprint: () => 'fp' }));

import {
  changeCompatDefaultModel,
  connectCompat,
  disconnectCompat,
  remapPartnerOfferings,
  RegistryNotCutOverError,
  rotateCompatKey,
} from './compatRemap';

const writes = () => m.statements.filter((s) => /^(WITH .*?\) )?(UPDATE|INSERT|DELETE)/.test(s.text) || /^(UPDATE|INSERT|DELETE)/.test(s.text));
const deletes = () => m.statements.filter((s) => /\bDELETE FROM\b/.test(s.text));

/** A cut-over partner with no special rows unless a test overrides `respond`. */
function baseRespond(extra: (text: string, params: unknown[]) => unknown[] | undefined = () => undefined) {
  return (text: string, params: unknown[]): unknown[] => {
    const hit = extra(text, params);
    if (hit) return hit;
    if (text.includes('FROM ai_model_registry_partner_cutover')) return [{ ok: 1 }];
    if (text.startsWith('UPDATE') || text.startsWith('INSERT') || text.startsWith('DELETE') || text.startsWith('WITH')) return [];
    return [];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.scope = 'system';
  m.statements = [];
  m.respond = baseRespond();
});

describe('remapPartnerOfferings (Task 6B: registry-native id remaps, never a re-projection)', () => {
  it('touches exactly the four reference sites, by array_replace, and only live sessions', async () => {
    m.respond = () => [{ id: 'x' }];
    const counts = await remapPartnerOfferings(P, new Map([[A, B]]));
    expect(counts).toEqual({ assignments: 1, agents: 1, sessions: 1, offerings: 1 });

    const [assign, agents, sessions, offerings] = m.statements;
    expect(assign!.text).toMatch(/^UPDATE ai_model_assignments SET default_offering_id = CASE/);
    expect(assign!.text).toContain('permitted_offering_ids = array_replace(permitted_offering_ids,');
    expect(assign!.text).toContain('fallback_offering_ids = array_replace(fallback_offering_ids,');
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
});

describe('the gate: no registry-native write before the partner is cut over', () => {
  it.each([
    ['connectCompat', () => connectCompat(P, { kind: 'anthropic_byok', apiKey: 'sk-ant-x', catalogEntryId: null, connectedBy: null, defaultModel: null })],
    ['disconnectCompat', () => disconnectCompat(P)],
    ['changeCompatDefaultModel', () => changeCompatDefaultModel(P, 'm2')],
  ])('%s throws RegistryNotCutOverError and writes nothing', async (_name, run) => {
    m.respond = (text) => (text.includes('FROM ai_model_registry_partner_cutover') ? [] : [{ id: 'x' }]);
    await expect(run()).rejects.toBeInstanceOf(RegistryNotCutOverError);
    expect(writes()).toEqual([]);
    expect(m.createConnection).not.toHaveBeenCalled();
  });
});

describe('connectCompat', () => {
  it('creates the connection, moves platform references onto it (patch_test stays), and disables what no longer routes', async () => {
    m.createConnection.mockResolvedValue({ id: CONN });
    m.respond = baseRespond((text) => {
      if (text.includes('FROM partner_ai_connections') && text.includes('SELECT kind')) return [{ kind: 'anthropic_byok' }];
      // the referenced platform offerings
      if (text.startsWith('WITH') && text.includes('SELECT m.id, COALESCE(m.model_id, pm.model_id) AS model_id')) return [{ id: A, model_id: 'm1' }];
      if (text.startsWith('SELECT id, input_cents_per_m')) return [{ id: 'pm1', input_cents_per_m: 1, output_cents_per_m: 1, cache_read_cents_per_m: 1, cache_write_cents_per_m: 1 }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: B }];
      return undefined;
    });
    const id = await connectCompat(P, { kind: 'anthropic_byok', apiKey: 'sk-ant-x', catalogEntryId: null, connectedBy: null, defaultModel: null });
    expect(id).toBe(CONN);
    expect(m.createConnection).toHaveBeenCalledWith(expect.objectContaining({ partnerId: P, kind: 'anthropic_byok', apiKey: 'sk-ant-x' }));

    const referenced = m.statements.find((s) => s.text.includes('AS model_id'))!;
    expect(referenced.text).toContain('surface NOT IN (');
    expect(referenced.params).toContain('patch_test');
    expect(referenced.text).toContain('m.connection_id IS NULL');

    const insert = m.statements.find((s) => s.text.startsWith('INSERT INTO partner_ai_models'))!;
    expect(insert.params).toEqual(expect.arrayContaining([P, CONN, 'm1', 'discovered', 'pm1']));
    expect(insert.text).toContain('ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL DO UPDATE SET enabled = true');

    const remap = m.statements.find((s) => s.text.startsWith('UPDATE ai_model_assignments SET default_offering_id = CASE'))!;
    expect(remap.params).toEqual(expect.arrayContaining([A, B]));
    expect(remap.params).toContain('patch_test');

    const disable = m.statements.find((s) => s.text.includes('SET enabled = false'))!;
    expect(disable.params).toContain(A);
    expect(disable.text).toContain('NOT IN (SELECT id FROM refs');
    expect(deletes()).toEqual([]);
  });
});

describe('disconnectCompat', () => {
  it('returns references to platform offerings on every surface, then SOFT-disconnects the connection (#7700 finding 1)', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: null, config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('WITH') && text.includes('AS model_id')) return [{ id: B, model_id: 'm1' }];
      if (text.startsWith('SELECT id FROM ai_platform_models')) return [{ id: 'pm1' }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: A }];
      return undefined;
    });
    expect(await disconnectCompat(P)).toBe(true);
    const referenced = m.statements.find((s) => s.text.includes('AS model_id'))!;
    expect(referenced.text).not.toContain('surface NOT IN (');
    expect(referenced.params).toContain(CONN);
    const insert = m.statements.find((s) => s.text.startsWith('INSERT INTO partner_ai_models'))!;
    expect(insert.text).toContain("'platform'");
    expect(insert.text).toContain('ON CONFLICT (partner_id, platform_model_id) WHERE connection_id IS NULL DO UPDATE SET enabled = true');
    const remap = m.statements.find((s) => s.text.startsWith('UPDATE ai_model_assignments SET default_offering_id = CASE'))!;
    expect(remap.text).not.toContain('surface NOT IN (');
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
    // after every remap
    const order = m.statements.map((s) => s.text);
    expect(order.indexOf(soft.text)).toBeGreaterThan(order.findIndex((t) => t.startsWith('UPDATE ai_model_assignments')));
  });

  it('is a no-op (false) when there is no compat connection', async () => {
    expect(await disconnectCompat(P)).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('a pinned default goes back to tracking the deployment default on the platform (legacy: no row = env default)', async () => {
    m.respond = baseRespond((text, params) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: 'm-pinned', config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('SELECT m.id FROM partner_ai_models m JOIN ai_platform_models')) return params.includes('m-pinned') ? [{ id: 'old-platform' }] : [];
      if (text.startsWith('SELECT id FROM ai_platform_models')) return [{ id: 'pm-env' }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: 'env-platform' }];
      return undefined;
    });
    await disconnectCompat(P);
    const repoint = m.statements.find((s) => s.text.startsWith('UPDATE ai_model_assignments SET default_offering_id =') && !s.text.includes('CASE'))!;
    expect(repoint.params).toEqual(expect.arrayContaining(['env-platform', 'old-platform', P]));
  });

  it('a deployment default with no platform row is bootstrapped at its legacy rates (#7601 gap A)', async () => {
    m.ensureLegacyPlatformModel.mockResolvedValue('pm-boot');
    m.respond = baseRespond((text, params) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: 'm-pinned', config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('SELECT m.id FROM partner_ai_models m JOIN ai_platform_models')) return params.includes('m-pinned') ? [{ id: 'old-platform' }] : [];
      if (text.startsWith('SELECT id FROM ai_platform_models')) return [];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: 'env-platform' }];
      return undefined;
    });
    await disconnectCompat(P);
    expect(m.ensureLegacyPlatformModel).toHaveBeenCalledWith('env-default',
      { inputCentsPerM: 1, outputCentsPerM: 2, cacheReadCentsPerM: 3, cacheWriteCentsPerM: 4 });
  });
});

describe('rotateCompatKey', () => {
  it('rotates in place and drops the legacy partner_llm_configs copy of the revoked key (#7700 finding 4)', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: null, config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('UPDATE partner_ai_connections SET')) return [{ config_version: 4 }];
      return undefined;
    });
    expect(await rotateCompatKey(P, { apiKey: 'sk-new-key-0001', connectedBy: null, verifiedAt: new Date() }))
      .toEqual({ configVersion: 4, defaultModel: null });
    expect(deletes().map((d) => d.text)).toEqual(['DELETE FROM partner_llm_configs WHERE partner_id = $1::uuid']);
    expect(deletes()[0]!.params).toEqual([P]);
  });
});

describe('changeCompatDefaultModel', () => {
  it('re-points only partner-level default rows of surfaces that follow the partner default, from the old default offering', async () => {
    m.respond = baseRespond((text, params) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: 'm-old', config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('UPDATE partner_ai_connections')) return [{ config_version: 4 }];
      if (text.startsWith('SELECT kind FROM partner_ai_connections')) return [{ kind: 'anthropic_byok' }];
      if (text.startsWith('SELECT id FROM partner_ai_models WHERE')) return params.includes('m-old') ? [{ id: 'old-o' }] : [];
      if (text.startsWith('SELECT id, input_cents_per_m')) return [{ id: 'pm-new', input_cents_per_m: 1, output_cents_per_m: 1, cache_read_cents_per_m: 1, cache_write_cents_per_m: 1 }];
      if (text.startsWith('INSERT INTO partner_ai_models')) return [{ id: 'new-o' }];
      return undefined;
    });
    expect(await changeCompatDefaultModel(P, 'm-new')).toEqual({ configVersion: 4 });
    const conn = m.statements.find((s) => s.text.startsWith('UPDATE partner_ai_connections'))!;
    expect(conn.text).toContain('legacy_default_model =');
    expect(conn.text).toContain('config_version = config_version + 1');
    const repoint = m.statements.find((s) => s.text.startsWith('UPDATE ai_model_assignments SET default_offering_id ='))!;
    expect(repoint.text).toContain('org_id IS NULL');
    expect(repoint.text).toContain("role = 'default'");
    expect(repoint.params).toEqual(expect.arrayContaining(['new-o', 'old-o', 'chat', 'helper', 'ai_agents']));
    expect(repoint.params).not.toContain('script_reviewer');
    expect(repoint.params).not.toContain('extension_content');
    expect(repoint.params).not.toContain('patch_test');
    expect(m.statements.find((s) => s.text.includes('SET enabled = false'))!.params).toContain('old-o');
    expect(deletes()).toEqual([]);
  });

  it('changes nothing in the assignments when the effective default is unchanged (null pin = deployment default)', async () => {
    m.respond = baseRespond((text) => {
      if (text.includes('FOR UPDATE')) return [{ id: CONN, kind: 'anthropic_byok', catalog_entry_id: null, legacy_default_model: 'env-default', config_version: 3, connected_by: null, verified_at: null }];
      if (text.startsWith('UPDATE partner_ai_connections')) return [{ config_version: 4 }];
      return undefined;
    });
    await changeCompatDefaultModel(P, null);
    expect(m.statements.some((s) => s.text.startsWith('UPDATE ai_model_assignments'))).toBe(false);
  });
});
