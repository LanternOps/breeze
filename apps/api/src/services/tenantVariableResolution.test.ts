import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only `../db` is mocked — NEVER `../db/schema`. The query is built with real
// Drizzle columns (organizations.id, organizations.partnerId,
// tenantVariables.orgId, ...), and the WHERE-clause assertions below walk the
// captured condition's actual bound parameters. Stubbing the schema with
// plain strings would make those assertions vacuous (see
// services/tenantVariables.test.ts, whose `boundParams` helper this file
// copies for the same reason).
vi.mock('../db', () => {
  const dbMock = { select: vi.fn() };
  return {
    db: dbMock,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn()
  };
});

import { db } from '../db';
import { encryptTenantVariableValue } from './tenantVariables';
import {
  describeVariableFailure,
  loadTenantVariableScope,
  resolveForOrg,
  substituteTenantVariables,
  type ResolvedVariable
} from './tenantVariableResolution';

const dbMock = db as unknown as { select: ReturnType<typeof vi.fn> };

const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ROW_ORG = '11111111-1111-1111-1111-111111111111';
const ROW_PARTNER = '22222222-2222-2222-2222-222222222222';
const ROW_ORG_B = '33333333-3333-3333-3333-333333333333';
const ROW_SECRET = '44444444-4444-4444-4444-444444444444';
const ROW_BAD = '55555555-5555-5555-5555-555555555555';

const ENV_KEYS = ['APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.APP_ENCRYPTION_KEY = 'unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'unit';
});

/**
 * Every bound parameter in a Drizzle condition tree, in order. Copied from
 * `services/tenantVariables.test.ts` — see its comment for why walking real
 * bound params (rather than stringifying the condition) is what makes these
 * assertions discriminating: delete the org filter and these tests go red.
 */
function boundParams(node: unknown, out: unknown[] = []): unknown[] {
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const entry of node) boundParams(entry, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;

  const record = node as Record<string, unknown>;
  if (record.constructor?.name === 'StringChunk') return out;
  if ('encoder' in record && 'value' in record) {
    boundParams(record.value, out);
    return out;
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) boundParams(chunk, out);
  }
  return out;
}

interface StubRow {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  version: number;
  ownerOrgId: string | null;
  forOrgId: string;
}

function encryptedRow(id: string, plaintext: string, overrides: Partial<StubRow> = {}): StubRow {
  return {
    id,
    key: 'repo_url',
    value: encryptTenantVariableValue(id, plaintext),
    isSecret: false,
    version: 1,
    ownerOrgId: null,
    forOrgId: ORG_A,
    ...overrides
  };
}

/** Chainable select stub matching `.select().from().innerJoin().where()`. */
function stubSelect(rows: StubRow[]) {
  const captured: { on?: unknown; where?: unknown } = {};
  dbMock.select.mockReturnValue({
    from: () => ({
      innerJoin: (_table: unknown, on: unknown) => {
        captured.on = on;
        return {
          where: (condition: unknown) => {
            captured.where = condition;
            return Promise.resolve(rows);
          }
        };
      }
    })
  });
  return captured;
}

function mapWith(entry: Partial<ResolvedVariable> & { key: string }): Map<string, ResolvedVariable> {
  return new Map([
    [
      entry.key,
      {
        key: entry.key,
        value: entry.value ?? 'v',
        isSecret: entry.isSecret ?? false,
        variableId: entry.variableId ?? ROW_ORG,
        version: entry.version ?? 1
      }
    ]
  ]);
}

describe('loadTenantVariableScope', () => {
  it('returns an empty scope without querying for an empty input', async () => {
    const scope = await loadTenantVariableScope([]);
    expect(scope.orgIds.size).toBe(0);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('issues ONE query for many orgs', async () => {
    stubSelect([]);
    await loadTenantVariableScope([ORG_A, ORG_B]);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });

  it('filters on the requested org ids — the sole tenancy boundary under system scope', async () => {
    const captured = stubSelect([]);
    await loadTenantVariableScope([ORG_A, ORG_B]);
    const params = boundParams(captured.where);
    expect(params).toContain(ORG_A);
    expect(params).toContain(ORG_B);
  });

  it('org value shadows a partner-wide value for the same key', async () => {
    stubSelect([
      encryptedRow(ROW_PARTNER, 'partner-value', { key: 'k', ownerOrgId: null, forOrgId: ORG_A }),
      encryptedRow(ROW_ORG, 'org-value', { key: 'k', ownerOrgId: ORG_A, forOrgId: ORG_A })
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    expect(resolved.get('k')?.value).toBe('org-value');
  });

  it('a partner-wide key with no org override still resolves', async () => {
    stubSelect([encryptedRow(ROW_PARTNER, 'partner-value', { key: 'k', ownerOrgId: null, forOrgId: ORG_A })]);
    const scope = await loadTenantVariableScope([ORG_A]);
    expect(resolveForOrg(scope, ORG_A).get('k')?.value).toBe('partner-value');
  });

  it('never leaks another org value into this org resolution', async () => {
    stubSelect([
      encryptedRow(ROW_ORG, 'a-value', { key: 'k', ownerOrgId: ORG_A, forOrgId: ORG_A }),
      encryptedRow(ROW_ORG_B, 'b-value', { key: 'k', ownerOrgId: ORG_B, forOrgId: ORG_B })
    ]);
    const scope = await loadTenantVariableScope([ORG_A, ORG_B]);
    expect(resolveForOrg(scope, ORG_A).get('k')?.value).toBe('a-value');
    expect(resolveForOrg(scope, ORG_B).get('k')?.value).toBe('b-value');
  });

  it('an undecryptable row is treated as unresolved, not as an empty value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      { id: ROW_BAD, key: 'broken', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    expect(resolved.has('broken')).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[1]?.id ?? '')).toBe(ROW_BAD);
    // The warning must never carry the value / attempted plaintext.
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('not.real.ciphertext');
    warn.mockRestore();
  });

  it('carries a secret row through to the snapshot (unredacted internally — redaction happens at substitution)', async () => {
    stubSelect([encryptedRow(ROW_SECRET, 'shh', { key: 's1_token', isSecret: true, ownerOrgId: ORG_A, forOrgId: ORG_A })]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    expect(resolved.get('s1_token')).toMatchObject({ isSecret: true, value: 'shh' });
  });
});

describe('resolveForOrg', () => {
  it('throws when asked to resolve for an org the snapshot was not built for', async () => {
    stubSelect([]);
    const scope = await loadTenantVariableScope([ORG_A]);
    expect(() => resolveForOrg(scope, ORG_B)).toThrow(/not in this snapshot/i);
  });

  it('returns a fresh map each call — mutating the result cannot corrupt the snapshot', async () => {
    stubSelect([encryptedRow(ROW_ORG, 'v', { key: 'k', ownerOrgId: ORG_A, forOrgId: ORG_A })]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const first = resolveForOrg(scope, ORG_A);
    first.delete('k');
    const second = resolveForOrg(scope, ORG_A);
    expect(second.has('k')).toBe(true);
  });
});

describe('substituteTenantVariables', () => {
  it('substitutes a non-secret variable', () => {
    const out = substituteTenantVariables('{{var.k}}', mapWith({ key: 'k', value: 'hello' }));
    expect(out).toEqual({ content: 'hello', unresolved: [], secretsReferenced: [] });
  });

  it('reports a missing key as unresolved, not as a secret', () => {
    const out = substituteTenantVariables('{{var.missing}}', new Map());
    expect(out).toEqual({ content: '{{var.missing}}', unresolved: ['missing'], secretsReferenced: [] });
  });

  it('reports a secret key instead of substituting it', () => {
    const out = substituteTenantVariables('{{var.s1_token}}', mapWith({ key: 's1_token', isSecret: true, value: 'shh' }));
    expect(out.content).toBe('{{var.s1_token}}');
    expect(out.secretsReferenced).toEqual(['s1_token']);
    expect(out.unresolved).toEqual([]);
  });

  it('never puts a secret value in the returned content even when the same key is referenced twice', () => {
    const out = substituteTenantVariables(
      '{{var.s1_token}} and again {{var.s1_token}}',
      mapWith({ key: 's1_token', isSecret: true, value: 'top-secret-value' })
    );
    expect(out.content).not.toContain('top-secret-value');
    expect(out.secretsReferenced).toEqual(['s1_token']);
  });

  it('mixes a resolved, a missing, and a secret key correctly in one pass', () => {
    const resolved = new Map<string, ResolvedVariable>([
      ['ok', { key: 'ok', value: 'fine', isSecret: false, variableId: ROW_ORG, version: 1 }],
      ['sekret', { key: 'sekret', value: 'nope', isSecret: true, variableId: ROW_SECRET, version: 1 }]
    ]);
    const out = substituteTenantVariables('{{var.ok}} {{var.sekret}} {{var.gone}}', resolved);
    expect(out.content).toBe('fine {{var.sekret}} {{var.gone}}');
    expect(out.unresolved).toEqual(['gone']);
    expect(out.secretsReferenced).toEqual(['sekret']);
  });
});

describe('describeVariableFailure', () => {
  it('returns null when nothing is wrong', () => {
    expect(describeVariableFailure({ content: 'ok', unresolved: [], secretsReferenced: [] })).toBeNull();
  });

  it('names the keys but never a value', () => {
    const message = describeVariableFailure({
      content: 'x',
      unresolved: ['missing_key'],
      secretsReferenced: ['secret_key']
    });
    expect(message).toContain('missing_key');
    expect(message).toContain('secret_key');
    expect(message).not.toContain('shh');
    expect(message).not.toContain('top-secret-value');
  });

  it('distinguishes missing keys from secret keys in the message', () => {
    const missingOnly = describeVariableFailure({ content: 'x', unresolved: ['a'], secretsReferenced: [] });
    const secretOnly = describeVariableFailure({ content: 'x', unresolved: [], secretsReferenced: ['b'] });
    expect(missingOnly).not.toBe(secretOnly);
    expect(secretOnly).toMatch(/secret/i);
  });
});
