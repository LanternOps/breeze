import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only `../db` is mocked — NEVER `../db/schema`. The query is built with real
// Drizzle columns (organizations.id, organizations.partnerId,
// tenantVariables.orgId, ...), and the WHERE-clause assertions below walk the
// captured condition's actual bound parameters. Stubbing the schema with
// plain strings would make those assertions vacuous (see
// services/tenantVariables.test.ts, whose `boundParams` helper this file
// copies for the same reason).
// runOutsideDbContext / withSystemDbAccessContext are mocked as flag-tracking
// passthroughs (vi.fn() wrapping the real behaviour), not bare identity
// functions, specifically so Task 3b's "database supplied -> escape hatch
// NOT invoked" tests can assert on call counts rather than merely on side
// effects. Same pattern as aiToolsScripts.runScript.orgEquality.test.ts.
// getCurrentDbAccessContext backs the `opts.database` system-scope assertion;
// it defaults to the system context the real callers hold, and the assertion
// test below overrides it per-case.
vi.mock('../db', () => {
  const dbMock = { select: vi.fn() };
  return {
    db: dbMock,
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
    runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
    withSystemDbAccessContext: vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => fn())
  };
});

// `./sentry` is mocked so the decrypt-failure report can be ASSERTED rather
// than merely not-crashing: a real `captureException` no-ops without a DSN
// (services/sentry.ts's `initialized` guard), which is exactly the unit-test
// environment — so an un-mocked module would let the missing report pass.
vi.mock('./sentry', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args)
}));

const mockCaptureException = vi.fn();

import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
  type Database
} from '../db';
import { encryptTenantVariableValue } from './tenantVariables';
import {
  describeVariableFailure,
  loadTenantVariableScope,
  resolveForOrg,
  substituteTenantVariables,
  unreadableForOrg,
  type ResolvedVariable
} from './tenantVariableResolution';

const dbMock = db as unknown as { select: ReturnType<typeof vi.fn> };
const runOutsideDbContextMock = runOutsideDbContext as unknown as ReturnType<typeof vi.fn>;
const withSystemDbAccessContextMock = withSystemDbAccessContext as unknown as ReturnType<typeof vi.fn>;
const getCurrentDbAccessContextMock = getCurrentDbAccessContext as unknown as ReturnType<typeof vi.fn>;

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
function stubSelectOn(select: ReturnType<typeof vi.fn>, rows: StubRow[]) {
  const captured: { on?: unknown; where?: unknown } = {};
  select.mockReturnValue({
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

function stubSelect(rows: StubRow[]) {
  return stubSelectOn(dbMock.select, rows);
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
        version: entry.version ?? 1,
        ownerScope: entry.ownerScope ?? 'organization'
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

  // #3409 PR3 carries `ownerScope` on every resolved row so a persisted
  // binding descriptor can say WHICH axis a device actually resolved on —
  // `variableId` alone can't, once an org override shadows a partner-wide
  // row of the same key.
  it('tags each resolved row with the axis it was owned on', async () => {
    stubSelect([
      encryptedRow(ROW_PARTNER, 'partner-value', { key: 'inherited', ownerOrgId: null, forOrgId: ORG_A }),
      encryptedRow(ROW_ORG, 'org-value', { key: 'overridden', ownerOrgId: ORG_A, forOrgId: ORG_A })
    ]);
    const resolved = resolveForOrg(await loadTenantVariableScope([ORG_A]), ORG_A);
    expect(resolved.get('inherited')?.ownerScope).toBe('partner');
    expect(resolved.get('overridden')?.ownerScope).toBe('organization');
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

  it('an undecryptable row is reported as unreadable, not merely absent — and is still never given a value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      { id: ROW_BAD, key: 'broken', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    // Never resolves to a value — no placeholder, no empty string.
    expect(resolved.has('broken')).toBe(false);
    // But it must be distinguishable from a key that was never defined at all.
    expect(unreadableForOrg(scope, ORG_A).has('broken')).toBe(true);
    warn.mockRestore();
  });

  // A bare empty-rows stub would pass against ANY implementation that
  // returns empty collections (including a stub that never populates
  // `unreadableKeysByOrg` at all) — not discriminating. Mix in one readable
  // and one unreadable key so "never defined" is asserted against a
  // populated snapshot, proving the never-defined key is excluded from both
  // collections rather than both collections simply being empty.
  it('a key that was never defined is absent from BOTH the resolved map and the unreadable set, alongside other readable/unreadable keys', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      encryptedRow(ROW_ORG, 'v', { key: 'defined_readable', ownerOrgId: ORG_A, forOrgId: ORG_A }),
      { id: ROW_BAD, key: 'defined_unreadable', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    const unreadable = unreadableForOrg(scope, ORG_A);
    // Sanity: the mixed snapshot actually populated both collections.
    expect(resolved.has('defined_readable')).toBe(true);
    expect(unreadable.has('defined_unreadable')).toBe(true);
    // The never-defined key is in neither.
    expect(resolved.has('never_defined')).toBe(false);
    expect(unreadable.has('never_defined')).toBe(false);
    warn.mockRestore();
  });

  // An unreadable row in the PARTNER-WIDE pass (not just the org-owned pass
  // above) must also be reported as unreadable, never as absent. This is the
  // likelier real case for an MSP-defined default that fails to decrypt (no
  // org override involved at all) — and it exercises a different code path
  // (the second loop in loadTenantVariableScope) than the org-owned case
  // above, so it needs its own coverage rather than being assumed from it.
  it('an unreadable partner-wide row (no org override) is reported as unreadable, not absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      { id: ROW_BAD, key: 'broken_default', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: null, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    expect(resolved.has('broken_default')).toBe(false);
    expect(unreadableForOrg(scope, ORG_A).has('broken_default')).toBe(true);
    warn.mockRestore();
  });

  // The subtle precedence case: an org-owned row for key `k` fails to
  // decrypt, and a readable partner-wide row for the SAME key `k` also
  // exists. The org row won the precedence contest (org > partner, see the
  // two-pass loop above), so `k` must be UNREADABLE for this org — it must
  // NOT silently fall back to the partner-wide value. That value is this
  // org's own DEFAULT (not another tenant's data — the join and every write
  // are keyed by `forOrgId`), and falling back to it would mean the default
  // silently wins over the override that was meant to replace it. Before
  // this task, `orgOwnedKeys` was only populated on a *successful* decrypt,
  // so an unreadable org row left the key unclaimed and the partner-wide
  // pass resolved right over it with the default's value.
  it('an unreadable org row shadows a readable partner row — it must NOT fall back to the partner value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      encryptedRow(ROW_PARTNER, 'partner-value', { key: 'k', ownerOrgId: null, forOrgId: ORG_A }),
      { id: ROW_BAD, key: 'k', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const resolved = resolveForOrg(scope, ORG_A);
    expect(resolved.has('k')).toBe(false);
    expect(resolved.get('k')?.value).not.toBe('partner-value');
    expect(unreadableForOrg(scope, ORG_A).has('k')).toBe(true);
    warn.mockRestore();
  });

  // #3409 PR4c-2 review finding 1 — a decrypt failure is a KEY-MATERIAL
  // incident (a botched rotation, a keyring missing the id a row was sealed
  // under), not a per-row curiosity. Reported only to `console.warn`, it is
  // invisible on hosted, where nobody reads container logs and the operator's
  // only symptom is scripts failing on a variable that visibly exists. It has
  // to reach Sentry.
  it('reports a decrypt failure to Sentry, carrying the row id and never the value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      { id: ROW_BAD, key: 'broken', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);

    await loadTenantVariableScope([ORG_A]);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [err, context, tags] = mockCaptureException.mock.calls[0] as [unknown, unknown, Record<string, string>];
    expect(err).toBeInstanceOf(Error);
    expect(context).toBeUndefined();
    expect(tags?.tenantVariableId).toBe(ROW_BAD);
    // Identity only: never the ciphertext, never an attempted plaintext, and
    // never the variable's key name (which can itself be descriptive).
    expect(JSON.stringify({ tags, message: (err as Error).message })).not.toContain('not.real.ciphertext');
    // The existing log line is kept — Sentry is an addition, not a swap.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not report to Sentry when every row decrypts', async () => {
    stubSelect([encryptedRow(ROW_ORG, 'v', { key: 'k', ownerOrgId: ORG_A, forOrgId: ORG_A })]);
    await loadTenantVariableScope([ORG_A]);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});

// Task 3b (#3409 PR4c-1): the digest path computes inside an
// already-open, already-system-scoped transaction (intentService.ts:385-408)
// and must reuse THAT connection rather than acquiring a second pooled one
// via the escape hatch — see tenantVariableResolution.ts's doc comment on
// `opts.database` for the caller contract this enforces.
describe('loadTenantVariableScope given an explicit database', () => {
  it('queries the supplied database directly and does NOT call the escape helpers', async () => {
    const suppliedSelect = vi.fn();
    stubSelectOn(suppliedSelect, []);
    const suppliedDb = { select: suppliedSelect } as unknown as Database;

    const scope = await loadTenantVariableScope([ORG_A], { database: suppliedDb });

    expect(scope.orgIds.has(ORG_A)).toBe(true);
    expect(suppliedSelect).toHaveBeenCalledTimes(1);
    // The module-level `db` (today's ambient escape target) must be
    // untouched — the query ran on the supplied connection, not a second one.
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('still returns an empty scope without querying ANYTHING for an empty input, database or not', async () => {
    const suppliedSelect = vi.fn();
    const suppliedDb = { select: suppliedSelect } as unknown as Database;

    const scope = await loadTenantVariableScope([], { database: suppliedDb });

    expect(scope.orgIds.size).toBe(0);
    expect(suppliedSelect).not.toHaveBeenCalled();
    expect(dbMock.select).not.toHaveBeenCalled();
    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  // `opts.database` is a caller ASSERTION that a system context is already
  // open, and nothing but this check enforces it. A false assertion never
  // errors on its own: the query just runs under the caller's RLS, which can
  // NARROW the result set silently — for the effect-digest callers that means
  // a recomputed digest that no longer matches the pinned one and
  // `content_changed` on every approved release.
  it.each([
    ['an org-scoped context', { scope: 'organization' }],
    ['a partner-scoped context', { scope: 'partner' }],
    ['no context at all', undefined]
  ])('refuses the supplied database under %s', async (_case, ambient) => {
    getCurrentDbAccessContextMock.mockReturnValueOnce(ambient);
    const suppliedSelect = vi.fn();
    stubSelectOn(suppliedSelect, []);
    const suppliedDb = { select: suppliedSelect } as unknown as Database;

    await expect(loadTenantVariableScope([ORG_A], { database: suppliedDb })).rejects.toThrow(
      /requires an already-open system-scoped DB context/i
    );
    // Fails BEFORE the query — an RLS-narrowed row set never reaches a snapshot.
    expect(suppliedSelect).not.toHaveBeenCalled();
  });
});

// Byte-for-byte-unaffected proof for the five existing callers (Step 3 of
// Task 3b): omitting `opts` — exactly what all five call sites do — must
// still ride the escape hatch, on the module's own `db`, exactly as before
// this task.
describe('loadTenantVariableScope with no explicit database (today\'s five callers)', () => {
  it('escapes via runOutsideDbContext + withSystemDbAccessContext and queries the module-level db', async () => {
    stubSelect([]);

    await loadTenantVariableScope([ORG_A]);

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(dbMock.select).toHaveBeenCalledTimes(1);
  });
});

describe('unreadableForOrg', () => {
  it('throws when asked to resolve for an org the snapshot was not built for', async () => {
    stubSelect([]);
    const scope = await loadTenantVariableScope([ORG_A]);
    expect(() => unreadableForOrg(scope, ORG_B)).toThrow(/not in this snapshot/i);
  });

  it('returns a fresh set each call — mutating the result cannot corrupt the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubSelect([
      { id: ROW_BAD, key: 'broken', value: 'enc:v3:unit:not.real.ciphertext', isSecret: false, version: 1, ownerOrgId: ORG_A, forOrgId: ORG_A }
    ]);
    const scope = await loadTenantVariableScope([ORG_A]);
    const first = unreadableForOrg(scope, ORG_A);
    (first as Set<string>).delete('broken');
    const second = unreadableForOrg(scope, ORG_A);
    expect(second.has('broken')).toBe(true);
    warn.mockRestore();
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
      ['ok', { key: 'ok', value: 'fine', isSecret: false, variableId: ROW_ORG, version: 1, ownerScope: 'organization' }],
      ['sekret', { key: 'sekret', value: 'nope', isSecret: true, variableId: ROW_SECRET, version: 1, ownerScope: 'partner' }]
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
