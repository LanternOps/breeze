import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only `../db` is mocked — NOT `../db/schema`. The tenancy conditions are
// built with real Drizzle columns and `sql` templates, and the assertions
// below inspect the BOUND PARAMETERS of the captured condition. Stubbing the
// schema with strings would make those assertions vacuous.
vi.mock('../db', () => {
  const dbMock = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  };
  return { db: dbMock, withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
});

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import { tenantVariables, type TenantVariableRow } from '../db/schema';
import {
  createTenantVariable,
  decryptTenantVariableValue,
  deleteTenantVariable,
  encryptTenantVariableValue,
  listTenantVariables,
  TenantVariableError,
  toApiTenantVariable,
  updateTenantVariable
} from './tenantVariables';

const dbMock = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

const ROW_A = '11111111-1111-1111-1111-111111111111';
const ROW_B = '22222222-2222-2222-2222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PARTNER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const ENV_KEYS = ['APP_ENCRYPTION_KEY', 'APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function makeRow(overrides: Partial<TenantVariableRow> = {}): TenantVariableRow {
  const id = overrides.id ?? ROW_A;
  return {
    id,
    partnerId: null,
    orgId: ORG_A,
    key: 's1_site_token',
    value: encryptTenantVariableValue(id, 'plaintext-value'),
    isSecret: false,
    description: null,
    version: 1,
    createdBy: USER,
    updatedBy: USER,
    createdAt: new Date('2026-08-11T00:00:00Z'),
    updatedAt: new Date('2026-08-11T00:00:00Z'),
    ...overrides
  } as TenantVariableRow;
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  const scope = overrides.scope ?? 'partner';
  const accessibleOrgIds = overrides.accessibleOrgIds ?? [ORG_A];
  return {
    principal: 'user',
    user: { id: USER, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: PARTNER,
    orgId: scope === 'organization' ? ORG_A : null,
    scope,
    accessibleOrgIds,
    partnerOrgAccess: scope === 'partner' ? 'all' : undefined,
    orgCondition: (column) =>
      accessibleOrgIds === null ? undefined : (require('drizzle-orm').inArray(column, accessibleOrgIds) as never),
    canAccessOrg: (orgId: string) => accessibleOrgIds === null || accessibleOrgIds.includes(orgId),
    ...overrides
  } as AuthContext;
}

/**
 * Every bound parameter in a Drizzle condition tree, in order.
 *
 * A Drizzle `Param` is identified by carrying an `encoder` alongside `value` —
 * that distinguishes it from a `StringChunk`, whose `value` is the literal SQL
 * text. Walking for real params (rather than stringifying the condition) is
 * what makes the tenancy assertions discriminating: delete the org branch from
 * the condition and these tests go red.
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
  // StringChunk carries literal SQL text, not a value — skip it entirely.
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

/** Chainable select stub: awaitable, and also exposes .limit()/.orderBy(). */
function stubSelect(rows: unknown[]) {
  const captured: { where?: unknown } = {};
  const terminal = {
    limit: () => Promise.resolve(rows),
    orderBy: () => Promise.resolve(rows),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve)
  };
  dbMock.select.mockReturnValue({
    from: () => ({
      where: (condition: unknown) => {
        captured.where = condition;
        return terminal;
      }
    })
  });
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.APP_ENCRYPTION_KEY = 'unit-test-key-material';
  process.env.APP_ENCRYPTION_KEY_ID = 'unit';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('value encryption', () => {
  it('round-trips through the row-bound AAD', () => {
    const sealed = encryptTenantVariableValue(ROW_A, 'hunter2');
    expect(sealed).not.toContain('hunter2');
    expect(decryptTenantVariableValue({ id: ROW_A, value: sealed })).toBe('hunter2');
  });

  it('refuses a plaintext that impersonates the at-rest envelope', () => {
    // encryptSecret would pass `enc:v1:…` straight through as "already
    // encrypted", persisting caller-controlled text as if it were ciphertext.
    expect(() => encryptTenantVariableValue(ROW_A, 'enc:v1:pretend')).toThrow(TenantVariableError);
  });

  it('refuses a value transplanted from another row', () => {
    const sealed = encryptTenantVariableValue(ROW_A, 'hunter2');
    expect(() => decryptTenantVariableValue({ id: ROW_B, value: sealed })).toThrow();
  });
});

describe('toApiTenantVariable', () => {
  it('returns the plaintext for a non-secret variable', () => {
    expect(toApiTenantVariable(makeRow()).value).toBe('plaintext-value');
  });

  it('never returns a secret value', () => {
    const row = makeRow({ isSecret: true });
    const api = toApiTenantVariable(row);
    expect(api.value).toBeNull();
    expect(JSON.stringify(api)).not.toContain('plaintext-value');
  });

  it('reports the owner scope from the org axis', () => {
    expect(toApiTenantVariable(makeRow()).ownerScope).toBe('organization');
    expect(toApiTenantVariable(makeRow({ orgId: null, partnerId: PARTNER })).ownerScope).toBe('partner');
  });

  it('degrades an undecryptable value to null instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toApiTenantVariable(makeRow({ value: 'enc:v3:unit:not.real.ciphertext' })).value).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('tenancy conditions', () => {
  it('an org-scoped read reaches the caller partner-wide rows', async () => {
    const captured = stubSelect([]);
    await listTenantVariables(auth({ scope: 'organization' }));
    expect(boundParams(captured.where)).toContain(PARTNER);
  });

  it('an org-scoped WRITE lookup does NOT reach partner-wide rows', async () => {
    const captured = stubSelect([]);
    await expect(deleteTenantVariable(auth({ scope: 'organization' }), ROW_A)).rejects.toMatchObject({ status: 404 });
    const params = boundParams(captured.where);
    expect(params).toContain(ROW_A);
    expect(params).toContain(ORG_A);
    // The partner branch must be absent — otherwise an org admin could delete
    // a partner-wide variable that applies to every other customer.
    expect(params).not.toContain(PARTNER);
  });

  it('a partner-scoped write lookup DOES reach partner-wide rows', async () => {
    const captured = stubSelect([]);
    await expect(deleteTenantVariable(auth({ scope: 'partner' }), ROW_A)).rejects.toMatchObject({ status: 404 });
    expect(boundParams(captured.where)).toContain(PARTNER);
  });

  it('a list filtered by org still carries the caller access condition', async () => {
    const captured = stubSelect([]);
    await listTenantVariables(auth(), { orgId: ORG_B });
    const params = boundParams(captured.where);
    expect(params).toContain(ORG_B);
    expect(params).toContain(ORG_A); // accessible-org allowlist, not dropped by the filter
  });
});

describe('createTenantVariable', () => {
  function stubInsert(row: TenantVariableRow) {
    const captured: { values?: Record<string, unknown> } = {};
    dbMock.insert.mockReturnValue({
      values: (values: Record<string, unknown>) => {
        captured.values = values;
        return { returning: () => Promise.resolve([row]) };
      }
    });
    return captured;
  }

  it('rejects a partner-wide create from an org-scoped caller', async () => {
    stubSelect([{ total: 0 }]);
    stubInsert(makeRow());
    await expect(
      createTenantVariable(auth({ scope: 'organization' }), {
        ownerScope: 'partner',
        key: 'k',
        value: 'v',
        isSecret: false
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('rejects a partner-wide create from a partner admin without full org access', async () => {
    stubSelect([{ total: 0 }]);
    stubInsert(makeRow());
    await expect(
      createTenantVariable(auth({ partnerOrgAccess: 'selected' }), {
        ownerScope: 'partner',
        key: 'k',
        value: 'v',
        isSecret: false
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('takes the partner from the token, never from the payload', async () => {
    stubSelect([{ total: 0 }]);
    const captured = stubInsert(makeRow({ orgId: null, partnerId: PARTNER }));
    await createTenantVariable(auth(), {
      ownerScope: 'partner',
      key: 'k',
      value: 'v',
      isSecret: false,
      // A forged partner id on the payload must be ignored entirely.
      partnerId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    } as never);
    expect(captured.values).toMatchObject({ partnerId: PARTNER, orgId: null });
  });

  it('encrypts the value with the id it inserts', async () => {
    stubSelect([{ total: 0 }]);
    const captured = stubInsert(makeRow());
    await createTenantVariable(auth({ scope: 'organization' }), {
      ownerScope: 'organization',
      key: 'k',
      value: 'top-secret',
      isSecret: true
    });
    const values = captured.values!;
    expect(values.value).not.toBe('top-secret');
    expect(decryptTenantVariableValue({ id: values.id as string, value: values.value as string })).toBe('top-secret');
  });

  it('rejects the 201st variable for an owner', async () => {
    stubSelect([{ total: 200 }]);
    stubInsert(makeRow());
    await expect(
      createTenantVariable(auth({ scope: 'organization' }), {
        ownerScope: 'organization',
        key: 'k',
        value: 'v',
        isSecret: false
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(dbMock.insert).not.toHaveBeenCalled();
  });

  it('maps a unique violation to 409', async () => {
    stubSelect([{ total: 0 }]);
    dbMock.insert.mockReturnValue({
      values: () => ({
        returning: () => Promise.reject(Object.assign(new Error('dup'), { cause: { code: '23505' } }))
      })
    });
    await expect(
      createTenantVariable(auth({ scope: 'organization' }), {
        ownerScope: 'organization',
        key: 'k',
        value: 'v',
        isSecret: false
      })
    ).rejects.toBeInstanceOf(TenantVariableError);
  });
});

describe('updateTenantVariable', () => {
  function stubUpdate(row: TenantVariableRow) {
    const captured: { set?: Record<string, unknown> } = {};
    dbMock.update.mockReturnValue({
      set: (values: Record<string, unknown>) => {
        captured.set = values;
        return { where: () => ({ returning: () => Promise.resolve([row]) }) };
      }
    });
    return captured;
  }

  it('leaves the stored value untouched when value is omitted', async () => {
    const row = makeRow({ isSecret: true });
    stubSelect([row]);
    const captured = stubUpdate(row);
    await updateTenantVariable(auth(), row.id, { description: 'just a note' });
    expect(captured.set).not.toHaveProperty('value');
    expect(captured.set).toMatchObject({ description: 'just a note' });
  });

  it('does not bump version for a description-only edit', async () => {
    const row = makeRow();
    stubSelect([row]);
    const captured = stubUpdate(row);
    await updateTenantVariable(auth(), row.id, { description: 'note' });
    expect(captured.set).not.toHaveProperty('version');
  });

  it('bumps version when the value actually changes', async () => {
    const row = makeRow();
    stubSelect([row]);
    const captured = stubUpdate(row);
    await updateTenantVariable(auth(), row.id, { value: 'different' });
    expect(captured.set).toMatchObject({ version: row.version + 1 });
  });

  it('does not bump version when the same value is re-submitted', async () => {
    const row = makeRow();
    stubSelect([row]);
    const captured = stubUpdate(row);
    await updateTenantVariable(auth(), row.id, { value: 'plaintext-value' });
    expect(captured.set).not.toHaveProperty('version');
  });

  it('refuses to un-secret a variable without a replacement value', async () => {
    const row = makeRow({ isSecret: true });
    stubSelect([row]);
    stubUpdate(row);
    await expect(updateTenantVariable(auth(), row.id, { isSecret: false })).rejects.toMatchObject({ status: 400 });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('allows un-secreting when a replacement value is supplied', async () => {
    const row = makeRow({ isSecret: true });
    stubSelect([row]);
    const captured = stubUpdate(row);
    await updateTenantVariable(auth(), row.id, { isSecret: false, value: 'now-public' });
    expect(captured.set).toMatchObject({ isSecret: false });
  });

  it('blocks a partner-wide edit from a partner admin without full org access', async () => {
    const row = makeRow({ orgId: null, partnerId: PARTNER });
    stubSelect([row]);
    stubUpdate(row);
    await expect(
      updateTenantVariable(auth({ partnerOrgAccess: 'selected' }), row.id, { description: 'x' })
    ).rejects.toMatchObject({ status: 403 });
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('404s a row the caller cannot reach', async () => {
    stubSelect([]);
    await expect(updateTenantVariable(auth(), ROW_A, { description: 'x' })).rejects.toMatchObject({ status: 404 });
  });

  it('409s — not 500s — when the row changed between the read and the write', async () => {
    const row = makeRow();
    stubSelect([row]);
    // The version predicate matched nothing: a concurrent edit already bumped it.
    dbMock.update.mockReturnValue({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) })
    });
    await expect(updateTenantVariable(auth(), row.id, { value: 'racing' })).rejects.toMatchObject({ status: 409 });
  });
});

describe('deleteTenantVariable', () => {
  it('deletes a reachable row and returns it for auditing', async () => {
    const row = makeRow();
    stubSelect([row]);
    dbMock.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([row]) }) });
    await expect(deleteTenantVariable(auth(), row.id)).resolves.toMatchObject({ id: row.id, key: row.key });
  });

  it('404s when the delete itself removes nothing (row vanished after the read)', async () => {
    const row = makeRow();
    stubSelect([row]);
    dbMock.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([]) }) });
    await expect(deleteTenantVariable(auth(), row.id)).rejects.toMatchObject({ status: 404 });
  });

  it('blocks a partner-wide delete from a partner admin without full org access', async () => {
    const row = makeRow({ orgId: null, partnerId: PARTNER });
    stubSelect([row]);
    dbMock.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([row]) }) });
    await expect(deleteTenantVariable(auth({ partnerOrgAccess: 'selected' }), row.id)).rejects.toMatchObject({
      status: 403
    });
    expect(dbMock.delete).not.toHaveBeenCalled();
  });
});
