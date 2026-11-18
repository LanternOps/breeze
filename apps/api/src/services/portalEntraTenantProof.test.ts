import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Unit cover for the tenant proof service (portal registration W4 #11381, plan
 * Task 2): the error mapping and the DB-context rules. The transaction body
 * (lock, displacement, upsert, audits, epoch bump, after-commit mail) is proven
 * against real Postgres in
 * __tests__/integration/portalEntraTenantProof.integration.test.ts.
 */

const state = vi.hoisted(() => ({
  /** What hasDbAccessContext() / getCurrentDbAccessContext() report. */
  held: null as null | { scope: 'system' | 'partner' | 'organization' },
  /** Ordered record of context / transaction entries and statements. */
  events: [] as string[],
  /** Rows any awaited select chain resolves to. */
  selectRows: [] as unknown[],
  /** When set, the next withDbTransaction rejects with it instead of running fn. */
  txError: null as unknown,
  /** >0 while a mocked system context / savepoint callback runs. */
  depth: 0,
}));

function selectChain() {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'for']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    state.events.push('select');
    return Promise.resolve(state.selectRows).then(resolve, reject);
  };
  return chain;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => selectChain()),
    execute: vi.fn(async () => { state.events.push('execute'); return []; }),
    insert: vi.fn(() => { throw new Error('unexpected insert in a unit test'); }),
    update: vi.fn(() => { throw new Error('unexpected update in a unit test'); }),
    delete: vi.fn(() => { throw new Error('unexpected delete in a unit test'); }),
  },
  hasDbAccessContext: vi.fn(() => state.held !== null),
  getCurrentDbAccessContext: vi.fn(() => state.held ?? undefined),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    state.events.push('system:open');
    state.depth += 1;
    try {
      return await fn();
    } finally {
      state.depth -= 1;
      state.events.push('system:close');
    }
  }),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
    state.events.push('tx');
    if (state.txError) {
      const err = state.txError;
      state.txError = null;
      throw err;
    }
    state.depth += 1;
    try {
      return await fn();
    } finally {
      state.depth -= 1;
    }
  }),
  assertInTransaction: vi.fn((label: string) => {
    if (state.depth === 0 && state.held === null) throw new Error(`${label} must run inside withDbAccessContext / withSystemDbAccessContext`);
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
}));

vi.mock('./unassignedPool/protectedOrg', () => ({
  isHoldingOrg: vi.fn(async () => {
    state.events.push('isHoldingOrg');
    return false;
  }),
}));
vi.mock('./partnerAdminRecipients', () => ({ listActivePartnerAdmins: vi.fn(async () => []) }));
vi.mock('./email', () => ({ getEmailService: vi.fn(() => null) }));
vi.mock('./sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import * as dbModule from '../db';
import { isHoldingOrg } from './unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from './unassignedPool/orgType';
import {
  PortalEntraProofError,
  findOrgByProvenEntraTenant,
  findProvenEntraTenantForOrg,
  lockPortalEntraOrgMappings,
  proveEntraTenantFromM365Connection,
  recordEntraTenantProof,
  type RecordEntraProofInput,
} from './portalEntraTenantProof';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const USER = '22222222-2222-4222-8222-222222222222';

const proofRun = (over: Partial<RecordEntraProofInput> = {}): RecordEntraProofInput => ({
  orgId: ORG,
  tenantId: TENANT,
  via: 'proof_run',
  evidence: { adminOid: '33333333-3333-4333-8333-333333333333', runId: 'run-1' },
  provenByUserId: USER,
  ...over,
} as RecordEntraProofInput);

async function caught(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => {
    throw new Error('expected a rejection');
  }, (err: unknown) => err);
}

beforeEach(() => {
  state.held = null;
  state.events = [];
  state.selectRows = [];
  state.txError = null;
  state.depth = 0;
  vi.mocked(isHoldingOrg).mockClear();
  vi.mocked(dbModule.withDbTransaction).mockClear();
  vi.mocked(dbModule.withSystemDbAccessContext).mockClear();
  vi.mocked(dbModule.db.execute).mockClear();
});

describe('PortalEntraProofError', () => {
  it('carries the code and the HTTP status the routes answer with', () => {
    const err = new PortalEntraProofError('PORTAL_ENTRA_NO_VERIFIED_CONNECTION', 422, 'no connection');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PortalEntraProofError');
    expect(err.code).toBe('PORTAL_ENTRA_NO_VERIFIED_CONNECTION');
    expect(err.httpStatus).toBe(422);
    expect(err.message).toBe('no connection');
  });
});

describe('recordEntraTenantProof: refusals and error mapping', () => {
  it('maps a holding org to PORTAL_ENTRA_PROTECTED_ORG without opening a transaction', async () => {
    vi.mocked(isHoldingOrg).mockImplementationOnce(async () => {
      state.events.push('isHoldingOrg');
      return true;
    });

    const err = await caught(recordEntraTenantProof(proofRun()));

    expect(err).toBeInstanceOf(PortalEntraProofError);
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_PROTECTED_ORG', httpStatus: 409, message: PROTECTED_ORG_ERROR.error });
    // The holding-org read runs under system scope (it reads organizations under
    // forced RLS), and nothing after it: no savepoint, no advisory lock.
    expect(state.events).toEqual(['system:open', 'isHoldingOrg', 'system:close']);
    expect(dbModule.withDbTransaction).not.toHaveBeenCalled();
    expect(dbModule.db.execute).not.toHaveBeenCalled();
  });

  it('maps a drizzle-wrapped 23505 on client_ai_tenant_mappings_tenant_uniq to 409 TENANT_PROVEN_ELSEWHERE', async () => {
    state.txError = Object.assign(new Error('Failed query: insert into "client_ai_tenant_mappings"'), {
      cause: Object.assign(new Error('duplicate key value'), {
        code: '23505',
        constraint_name: 'client_ai_tenant_mappings_tenant_uniq',
      }),
    });

    const err = await caught(recordEntraTenantProof(proofRun()));

    expect(err).toBeInstanceOf(PortalEntraProofError);
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', httpStatus: 409 });
    // The catch sits OUTSIDE the savepoint, inside the one system context.
    expect(state.events).toEqual(['system:open', 'isHoldingOrg', 'tx', 'system:close']);
  });

  it('rethrows any other failure unchanged (a 23505 on another index is not a tenant conflict)', async () => {
    const other = Object.assign(new Error('duplicate key value'), { code: '23505', constraint_name: 'client_ai_tenant_mappings_org_uniq' });
    state.txError = other;
    expect(await caught(recordEntraTenantProof(proofRun()))).toBe(other);

    const boom = new Error('connection reset');
    state.txError = boom;
    expect(await caught(recordEntraTenantProof(proofRun()))).toBe(boom);
  });

  it('refuses to run inside a held DB context (callers use runOutsideDbContext) and touches nothing', async () => {
    state.held = { scope: 'partner' };
    const err = await caught(recordEntraTenantProof(proofRun()));
    expect(err).not.toBeInstanceOf(PortalEntraProofError);
    expect((err as Error).message).toMatch(/runOutsideDbContext/);
    expect(state.events).toEqual([]);
  });

  it('refuses a malformed tenant id before any DB access', async () => {
    const err = await caught(recordEntraTenantProof(proofRun({ tenantId: 'contoso.onmicrosoft.com' })));
    expect((err as Error).message).toMatch(/tenant id/i);
    expect(state.events).toEqual([]);
  });

  it('refuses a malformed org id before any DB access', async () => {
    const err = await caught(recordEntraTenantProof(proofRun({ orgId: 'not-a-uuid' })));
    expect((err as Error).message).toMatch(/org id/i);
    expect(state.events).toEqual([]);
  });
});

/**
 * Org merge race (plan D8 / OD7): FOR UPDATE cannot lock a mapping row that
 * does not exist yet, so every writer that can CREATE an org's mapping takes a
 * per-org advisory lock the merge also holds. The interleavings themselves are
 * proven on real Postgres in portalEntraTenantMerge.integration.test.ts.
 */
describe('the per-org portal Entra mapping lock', () => {
  const dialect = new PgDialect();
  const executed = () => vi.mocked(dbModule.db.execute).mock.calls.map(([q]) => dialect.sqlToQuery(q as never));
  const A = '0a0a0a0a-1111-4111-8111-111111111111';
  const B = 'b0b0b0b0-2222-4222-8222-222222222222';

  it('takes one transaction-scoped lock per distinct org, ascending by id, on the canonical uuid text', async () => {
    await dbModule.withSystemDbAccessContext(() => lockPortalEntraOrgMappings([B, A, B.toUpperCase()]));

    const locks = executed();
    expect(locks.map((q) => q.params)).toEqual([[A], [B]]);
    for (const q of locks) {
      expect(q.sql).toBe(`SELECT pg_advisory_xact_lock(hashtext('portal-entra-org:' || $1::uuid::text))`);
    }
  });

  it('refuses outside a transaction: an xact lock on the bare pool would be released at once', async () => {
    await expect(lockPortalEntraOrgMappings([A])).rejects.toThrow(/withDbAccessContext/);
    expect(dbModule.db.execute).not.toHaveBeenCalled();
  });

  it('recordEntraTenantProof takes the tenant lock, then the org lock, before reading the mapping rows FOR UPDATE', async () => {
    // No rows: the transaction body reaches the upsert, which this unit mock refuses.
    const err = await caught(recordEntraTenantProof(proofRun()));
    expect((err as Error).message).toMatch(/unexpected insert/);

    expect(state.events).toEqual(['system:open', 'isHoldingOrg', 'tx', 'execute', 'execute', 'select', 'system:close']);
    const [tenantLock, orgLock] = executed();
    expect(tenantLock!.sql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(tenantLock!.params).toEqual([`portal-entra-tenant:${TENANT.toLowerCase()}`]);
    expect(orgLock!.sql).toBe(`SELECT pg_advisory_xact_lock(hashtext('portal-entra-org:' || $1::uuid::text))`);
    expect(orgLock!.params).toEqual([ORG]);
  });
});

describe('proveEntraTenantFromM365Connection', () => {
  it('no identity-bound connection → 422 PORTAL_ENTRA_NO_VERIFIED_CONNECTION, no proof transaction', async () => {
    state.selectRows = [];
    const err = await caught(proveEntraTenantFromM365Connection(ORG, USER));
    expect(err).toBeInstanceOf(PortalEntraProofError);
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION', httpStatus: 422 });
    expect(dbModule.withDbTransaction).not.toHaveBeenCalled();
    expect(dbModule.db.execute).not.toHaveBeenCalled();
  });

  it('a holding org is refused as PROTECTED_ORG before the connection lookup', async () => {
    vi.mocked(isHoldingOrg).mockResolvedValueOnce(true);
    const err = await caught(proveEntraTenantFromM365Connection(ORG, USER));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_PROTECTED_ORG', httpStatus: 409 });
    expect(state.events).not.toContain('select');
  });

  it('refuses to run inside a held DB context', async () => {
    state.held = { scope: 'organization' };
    const err = await caught(proveEntraTenantFromM365Connection(ORG, USER));
    expect((err as Error).message).toMatch(/runOutsideDbContext/);
    expect(state.events).toEqual([]);
  });
});

describe('findProvenEntraTenantForOrg: DB context selection', () => {
  const provenAt = new Date('2027-01-01T00:00:00Z');

  it('with no context held, opens its own system context', async () => {
    state.selectRows = [{ tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', provenAt }];
    expect(await findProvenEntraTenantForOrg(ORG)).toEqual({ tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', provenAt });
    expect(state.events).toEqual(['system:open', 'select', 'system:close']);
  });

  it('with a context held, reads under it and never escalates', async () => {
    state.held = { scope: 'organization' };
    state.selectRows = [{ tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', provenAt }];
    expect(await findProvenEntraTenantForOrg(ORG)).toEqual({ tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', provenAt });
    expect(state.events).toEqual(['select']);
    expect(dbModule.withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('no proven row → null', async () => {
    state.selectRows = [];
    expect(await findProvenEntraTenantForOrg(ORG)).toBeNull();
  });

  it('a malformed org id is null without a query (a 22P02 would poison a held transaction)', async () => {
    state.held = { scope: 'partner' };
    expect(await findProvenEntraTenantForOrg('nope')).toBeNull();
    expect(state.events).toEqual([]);
  });
});

describe('findOrgByProvenEntraTenant: DB context rules', () => {
  it('refuses inside a held request (non-system) context', async () => {
    state.held = { scope: 'partner' };
    await expect(findOrgByProvenEntraTenant(TENANT)).rejects.toThrow(/request transaction|runOutsideDbContext/);
    expect(state.events).toEqual([]);
  });

  it('with no context held, opens a system context', async () => {
    state.selectRows = [{ orgId: ORG, partnerId: USER }];
    expect(await findOrgByProvenEntraTenant(TENANT)).toEqual({ orgId: ORG, partnerId: USER });
    expect(state.events).toEqual(['system:open', 'select', 'system:close']);
  });

  it('a malformed tid resolves no org, without a query', async () => {
    expect(await findOrgByProvenEntraTenant('9188040d')).toBeNull();
    expect(state.events).toEqual([]);
  });
});
