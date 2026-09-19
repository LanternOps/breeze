import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// Scripted drizzle double. Each `db.select(...)` starts a new chain; the chain
// is thenable so `await db.select().from().innerJoin().where()` resolves, and
// `.limit()` resolves too (the org lookup). Results are served in call order.
const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  wheres: [] as unknown[],
  joins: [] as unknown[],
  selections: [] as unknown[],
}));

vi.mock('../db', () => {
  const makeChain = () => {
    const rows = state.results.shift() ?? [];
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = self;
    chain.innerJoin = (_table: unknown, cond: unknown) => {
      state.joins.push(cond);
      return chain;
    };
    chain.leftJoin = self;
    chain.orderBy = self;
    chain.where = (cond: unknown) => {
      state.wheres.push(cond);
      return chain;
    };
    chain.limit = async () => rows;
    chain.then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return chain;
  };
  return {
    db: {
      select: vi.fn((selection: unknown) => {
        state.selections.push(selection);
        return makeChain();
      }),
    },
  };
});

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { getOrgPurgeRemovedAfterDays } from './deviceLifecyclePolicy';
import { captureException } from './sentry';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

/**
 * The policy query's WHERE, compiled to real SQL text + bound params (the 2nd
 * select in the flow; the 1st is the organizations lookup). Compiled rather
 * than shape-inspected so an assertion cannot pass against a predicate that
 * merely mentions the right identifiers in the wrong place.
 */
function policyWhere(): { sql: string; params: unknown[] } {
  expect(state.wheres.length, 'the policy query never issued a WHERE').toBeGreaterThanOrEqual(2);
  return new PgDialect().sqlToQuery(state.wheres[1] as SQL);
}

function policyWhereText(): string {
  const { sql, params } = policyWhere();
  return `${sql} :: ${JSON.stringify(params)}`;
}

/** Every compiled JOIN ... ON predicate of the policy query, concatenated. */
function policyJoinText(): string {
  expect(state.joins.length, 'the policy query issued no joins').toBeGreaterThan(0);
  const dialect = new PgDialect();
  return state.joins
    .map((cond) => {
      const { sql, params } = dialect.sqlToQuery(cond as SQL);
      return `${sql} :: ${JSON.stringify(params)}`;
    })
    .join(' | ');
}

function scriptOrg(partnerId: string | null) {
  state.results.push([{ partnerId }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.results = [];
  state.wheres = [];
  state.joins = [];
  state.selections = [];
});

describe('getOrgPurgeRemovedAfterDays', () => {
  it('returns null when no policy anywhere in the org hierarchy carries the feature — FAIL CLOSED, never purge', async () => {
    scriptOrg(PARTNER);
    state.results.push([]);

    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBeNull();
  });

  it('reads the winning link\'s purgeRemovedAfterDays', async () => {
    scriptOrg(PARTNER);
    state.results.push([
      { level: 'partner', assignmentPriority: 100, inlineSettings: { purgeRemovedAfterDays: 7 } },
    ]);

    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBe(7);
  });

  it('lets the CLOSER (organization) assignment beat the partner-wide one, regardless of row order', async () => {
    scriptOrg(PARTNER);
    state.results.push([
      { level: 'partner', assignmentPriority: 0, inlineSettings: { purgeRemovedAfterDays: 7 } },
      { level: 'organization', assignmentPriority: 500, inlineSettings: { purgeRemovedAfterDays: 30 } },
    ]);

    // Level beats assignment priority: the partner row has the numerically
    // better priority and still loses. Same precedence as
    // resolveDeviceEventLogSettings / getOrgEventLogRetentionDays.
    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBe(30);
  });

  it('breaks a same-level tie on assignment priority ASC', async () => {
    scriptOrg(PARTNER);
    state.results.push([
      { level: 'organization', assignmentPriority: 50, inlineSettings: { purgeRemovedAfterDays: 90 } },
      { level: 'organization', assignmentPriority: 10, inlineSettings: { purgeRemovedAfterDays: 45 } },
    ]);

    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBe(45);
  });

  it('returns null when the winning link explicitly turns purging off, even though a losing link sets a window', async () => {
    scriptOrg(PARTNER);
    state.results.push([
      { level: 'partner', assignmentPriority: 0, inlineSettings: { purgeRemovedAfterDays: 7 } },
      { level: 'organization', assignmentPriority: 0, inlineSettings: { purgeRemovedAfterDays: null } },
    ]);

    // Closest-wins is the whole point of the hierarchy: an org that opts out
    // must not inherit its partner's purge window.
    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBeNull();
  });

  it('returns null when the winning link has no purge field at all', async () => {
    scriptOrg(PARTNER);
    state.results.push([{ level: 'organization', assignmentPriority: 0, inlineSettings: {} }]);

    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 30.5],
    ['a string', '30'],
    ['past the ceiling', 4000],
    ['not an object', 'nope'],
  ])('returns null for a corrupt stored value (%s) rather than deleting on it', async (_label, stored) => {
    scriptOrg(PARTNER);
    state.results.push([
      {
        level: 'organization',
        assignmentPriority: 0,
        inlineSettings: typeof stored === 'string' && stored === 'nope' ? stored : { purgeRemovedAfterDays: stored },
      },
    ]);

    // The validator bounds writes to 1..3650, so anything else here is a
    // hand-edited or corrupt row. It must NOT be honoured: this value drives
    // an irreversible delete, so an unreadable policy means "never purge".
    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBeNull();
  });

  it('filters to ACTIVE policies carrying the device_lifecycle feature only', async () => {
    scriptOrg(PARTNER);
    state.results.push([]);

    await getOrgPurgeRemovedAfterDays(ORG);

    // The feature filter lives on the feature-links JOIN (so a policy that
    // carries OTHER features never contributes a row at all), the status
    // filter on the WHERE.
    expect(policyJoinText()).toContain('device_lifecycle');
    expect(policyWhereText()).toContain('active');
  });

  it('admits the partner-wide (org_id NULL) policy as well as the org-owned one', async () => {
    scriptOrg(PARTNER);
    state.results.push([]);

    await getOrgPurgeRemovedAfterDays(ORG);

    const where = policyWhereText();
    // policyOwnershipCondition's partner arm — without it a partner-wide
    // policy (org_id NULL) matches nothing and the MSP's fleet-wide setting
    // silently resolves to "never purge" (#3963's exact failure shape).
    expect(where).toContain(PARTNER);
    expect(where).toContain(ORG);
    expect(where).toContain('IS NULL');
  });

  it('targets BOTH the org-level and the partner-level assignment rows', async () => {
    scriptOrg(PARTNER);
    state.results.push([]);

    await getOrgPurgeRemovedAfterDays(ORG);

    const where = policyWhereText();
    expect(where).toContain('organization');
    expect(where).toContain('partner');
  });

  it('does not fabricate a partner target when the org row is missing, and reports the broken invariant', async () => {
    state.results.push([]); // organizations lookup returns nothing
    state.results.push([]);

    await expect(getOrgPurgeRemovedAfterDays(ORG)).resolves.toBeNull();
    expect(captureException).toHaveBeenCalled();
  });
});
