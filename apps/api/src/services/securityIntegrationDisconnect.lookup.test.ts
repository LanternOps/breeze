/**
 * Connection cost of the "which integrations are still connected" lookup
 * (#12726). The coverage readers sit on hot portal routes, and a nested
 * system context takes a second pooled connection from a small nested
 * reserve, so:
 *   - a caller already in system scope reads in place: no extra context;
 *   - a request-scope caller takes at most one extra context per request,
 *     whatever number of readers it runs, and never asks twice about one id;
 *   - nothing is remembered across requests, and a disconnect in the same
 *     request forgets what was remembered;
 *   - a failed lookup rejects; it is never read as "everything is active".
 *
 * The real db module runs over a faked drizzle, so the transactions opened are
 * countable: every top-level `baseDb.transaction` is one pooled connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName, type SQL, type Table } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const { drizzleFactory, state } = vi.hoisted(() => {
  const state = {
    transactions: 0,
    lookups: [] as string[],
    lookupConditions: [] as unknown[],
    agentReads: [] as string[],
    agentIntegrations: new Map<string, string[]>(),
    active: new Map<string, string[]>(),
    failLookups: false,
  };
  const fakeExecutor = () => {
    const executor = {
      execute: () => Promise.resolve([]),
      select: () => {
        let table = '';
        const chain = {
          from: (t: unknown) => {
            table = (t as { [k: symbol]: string })[Symbol.for('drizzle:Name')] ?? '';
            return chain;
          },
          where: (condition: unknown) => {
            state.lookups.push(table);
            state.lookupConditions.push(condition);
            if (state.failLookups) return Promise.reject(new Error('integration lookup failed'));
            return Promise.resolve((state.active.get(table) ?? []).map((id) => ({ id })));
          },
        };
        return chain;
      },
      selectDistinct: () => {
        let table = '';
        const chain = {
          from: (t: unknown) => {
            table = (t as { [k: symbol]: string })[Symbol.for('drizzle:Name')] ?? '';
            return chain;
          },
          where: () => {
            state.agentReads.push(table);
            return Promise.resolve((state.agentIntegrations.get(table) ?? []).map((integrationId) => ({ integrationId })));
          },
        };
        return chain;
      },
      update: () => {
        const chain = {
          set: () => chain,
          where: () => chain,
          returning: () => Promise.resolve([{ id: 'row', partnerId: 'p', name: 'Vendor' }]),
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
        };
        return chain;
      },
      // Savepoints (withDbTransaction) run on the same connection.
      transaction: async (fn: (t: unknown) => Promise<unknown>): Promise<unknown> => fn(executor),
    };
    return executor;
  };
  const tx = fakeExecutor();
  const drizzleFactory = vi.fn(() => ({
    ...fakeExecutor(),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      state.transactions += 1;
      return fn(tx);
    },
  }));
  return { drizzleFactory, state };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));

const originalEnv = { ...process.env };

const S1_A = '11111111-1111-4111-8111-111111111111';
const S1_B = '22222222-2222-4222-8222-222222222222';
const HUNTRESS_A = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const PARTNER = '55555555-5555-4555-8555-555555555555';

const orgContext = {
  scope: 'organization' as const,
  orgId: ORG,
  accessibleOrgIds: [ORG],
  accessiblePartnerIds: [],
};

async function load() {
  const dbModule = await import('../db');
  const lookup = await import('./securityIntegrationDisconnect');
  const schema = await import('../db/schema');
  return { ...dbModule, ...lookup, schema };
}

/** Top-level transactions opened beyond the caller's own one. */
function extraContexts(): number {
  return state.transactions - 1;
}

/** The integration ids each lookup asked about, in order. */
function askedIds(): string[][] {
  const dialect = new PgDialect();
  return state.lookupConditions.map((condition) =>
    dialect.sqlToQuery(condition as SQL).params.filter((p): p is string => typeof p === 'string'),
  );
}

describe('activeIntegrationIdsByVendor connection cost (#12726)', () => {
  beforeEach(() => {
    vi.resetModules();
    state.transactions = 0;
    state.lookups = [];
    state.lookupConditions = [];
    state.agentReads = [];
    state.agentIntegrations = new Map([
      ['s1_agents', [S1_A]],
      ['huntress_agents', [HUNTRESS_A]],
    ]);
    state.failLookups = false;
    state.active = new Map([
      ['s1_integrations', [S1_A]],
      ['huntress_integrations', [HUNTRESS_A]],
    ]);
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('reads the integration tables by their real names (fixture control)', async () => {
    const { schema } = await load();
    const nameOf = (t: unknown) => (t as { [k: symbol]: string })[Symbol.for('drizzle:Name')];
    expect(nameOf(schema.s1Integrations)).toBe(getTableName(schema.s1Integrations as unknown as Table));
    expect(nameOf(schema.s1Integrations)).toBe('s1_integrations');
    expect(nameOf(schema.huntressIntegrations)).toBe('huntress_integrations');
  });

  it('a system-scope caller reads in place and opens no additional context', async () => {
    const { withSystemDbAccessContext, activeIntegrationIdsByVendor } = await load();
    const result = await withSystemDbAccessContext(() =>
      activeIntegrationIdsByVendor({ sentinelone: [S1_A, S1_B], huntress: [HUNTRESS_A] }),
    );
    expect(extraContexts()).toBe(0);
    expect(result.sentinelone).toEqual(new Set([S1_A]));
    expect(result.huntress).toEqual(new Set([HUNTRESS_A]));
  });

  it('a request-scope caller looks up once per request, across readers and overlapping calls', async () => {
    const { withDbAccessContext, activeIntegrationIdsByVendor, activeIntegrationIds } = await load();
    const answers = await withDbAccessContext(orgContext, async () => {
      // Two readers in a Promise.all, then a third reader later in the request.
      const [first, second] = await Promise.all([
        activeIntegrationIdsByVendor({ sentinelone: [S1_A, S1_B], huntress: [HUNTRESS_A] }),
        activeIntegrationIdsByVendor({ sentinelone: [S1_A], huntress: [HUNTRESS_A] }),
      ]);
      const third = await activeIntegrationIds('sentinelone', [S1_B, S1_A]);
      return { first, second, third };
    });
    expect(extraContexts()).toBe(1);
    expect(state.lookups).toEqual(['s1_integrations', 'huntress_integrations']);
    expect(askedIds()).toEqual([[S1_A, S1_B], [HUNTRESS_A]]);
    expect(answers.first.sentinelone).toEqual(new Set([S1_A]));
    expect(answers.second.sentinelone).toEqual(new Set([S1_A]));
    expect(answers.second.huntress).toEqual(new Set([HUNTRESS_A]));
    expect(answers.third).toEqual(new Set([S1_A]));
  });

  it('a later call asks only about the ids not answered yet', async () => {
    const { withDbAccessContext, activeIntegrationIds } = await load();
    const later = await withDbAccessContext(orgContext, async () => {
      await activeIntegrationIds('sentinelone', [S1_A]);
      await activeIntegrationIds('sentinelone', [S1_A]);
      return activeIntegrationIds('sentinelone', [S1_A, S1_B]);
    });
    // One lookup for S1_A, one for S1_B only; never S1_A twice.
    expect(askedIds()).toEqual([[S1_A], [S1_B]]);
    expect(later).toEqual(new Set([S1_A]));
  });

  it('remembers nothing across requests: a disconnect between two requests is seen', async () => {
    const { withDbAccessContext, activeIntegrationIds } = await load();
    const before = await withDbAccessContext(orgContext, () => activeIntegrationIds('sentinelone', [S1_A]));
    state.active.set('s1_integrations', []);
    const after = await withDbAccessContext(orgContext, () => activeIntegrationIds('sentinelone', [S1_A]));
    expect(before).toEqual(new Set([S1_A]));
    expect(after).toEqual(new Set());
    expect(state.lookups).toEqual(['s1_integrations', 's1_integrations']);
  });

  it('a disconnect in the same request forgets what the request remembered', async () => {
    const { withDbAccessContext, activeIntegrationIds, disconnectS1Integration } = await load();
    const after = await withDbAccessContext(orgContext, async () => {
      await activeIntegrationIds('sentinelone', [S1_A]);
      await disconnectS1Integration({ scope: 'system', partnerOrgAccess: null }, PARTNER);
      state.active.set('s1_integrations', []);
      return activeIntegrationIds('sentinelone', [S1_A]);
    });
    expect(after).toEqual(new Set());
  });

  it('a failed lookup rejects every waiting reader, and a later call in the request retries', async () => {
    const { withDbAccessContext, activeIntegrationIdsByVendor, activeIntegrationIds } = await load();
    const outcome = await withDbAccessContext(orgContext, async () => {
      state.failLookups = true;
      const failed = await Promise.allSettled([
        activeIntegrationIdsByVendor({ sentinelone: [S1_A] }),
        activeIntegrationIds('sentinelone', [S1_A]),
      ]);
      state.failLookups = false;
      const retried = await activeIntegrationIds('sentinelone', [S1_A]);
      return { failed, retried };
    });
    expect(outcome.failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(outcome.retried).toEqual(new Set([S1_A]));
  });

  it('a reader that names one vendor reads only that vendor', async () => {
    const { withDbAccessContext, activeAgentIntegrationIdsForOrg } = await load();
    const result = await withDbAccessContext(orgContext, () => activeAgentIntegrationIdsForOrg(ORG, ['sentinelone']));
    expect(state.agentReads).toEqual(['s1_agents']);
    expect(state.lookups).toEqual(['s1_integrations']);
    expect(result).toEqual({ sentinelone: [S1_A] });
  });

  it('by default an org reader reads both vendors in one lookup', async () => {
    const { withDbAccessContext, activeAgentIntegrationIdsForOrg } = await load();
    const result = await withDbAccessContext(orgContext, () => activeAgentIntegrationIdsForOrg(ORG));
    expect(state.agentReads).toEqual(['s1_agents', 'huntress_agents']);
    expect(extraContexts()).toBe(1);
    expect(result).toEqual({ sentinelone: [S1_A], huntress: [HUNTRESS_A] });
  });

  it('no ids: no lookup and no context', async () => {
    const { withDbAccessContext, activeIntegrationIdsByVendor } = await load();
    const result = await withDbAccessContext(orgContext, () =>
      activeIntegrationIdsByVendor({ sentinelone: [], huntress: [] }),
    );
    expect(extraContexts()).toBe(0);
    expect(state.lookups).toEqual([]);
    expect(result.sentinelone.size + result.huntress.size).toBe(0);
  });
});
