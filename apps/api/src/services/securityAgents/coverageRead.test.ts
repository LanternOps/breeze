import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queue-driven Drizzle stand-in: each db.select() resolves to the next queued
// result, whatever chain the caller builds on it.
const queued: unknown[][] = [];
const selectMock = vi.fn(() => {
  const rows = queued.shift() ?? [];
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) c[m] = () => c;
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
  return c;
});
vi.mock('../../db', () => ({ db: { select: () => selectMock() } }));
vi.mock('../edrProviders/read', () => ({ edrOrgCondition: () => undefined }));

import { readSecurityAgentCoverage } from './coverageRead';

const SCOPE = { auth: {} as never, allowedDeviceIds: null } as never;
const Q = { limit: 50, offset: 0 };
const NOW = new Date('2026-10-30T00:00:00Z');
const S1_CATALOG = 'cat-s1';
const HUNTRESS_CATALOG = 'cat-huntress';

function row(over: Record<string, unknown>) {
  return {
    id: 'row-1', orgId: 'org-1', deviceId: 'dev-1', deviceName: 'PC-1', vendor: 'sentinelone',
    state: 'not_applicable', reasonCode: 'installer_missing', detail: null, policyId: 'policy-1',
    lastEvaluatedAt: NOW, stateChangedAt: NOW, ...over,
  };
}

const POLICY = {
  id: 'policy-1',
  rules: { software: [
    { name: 'Huntress Agent*', catalogId: HUNTRESS_CATALOG },
    { name: 'Sentinel Agent*', catalogId: S1_CATALOG },
  ], allowUnknown: true },
};
const CATALOGS = [
  { id: HUNTRESS_CATALOG, integrationProvider: 'huntress', builtinPackageKey: null },
  { id: S1_CATALOG, integrationProvider: 'sentinelone', builtinPackageKey: null },
];

/** grouped summary, total, page rows, then (only when needed) policies and catalogs. */
function prime(rows: unknown[], extra: unknown[][] = []) {
  queued.push([], [{ total: rows.length }], rows, ...extra);
}

beforeEach(() => {
  queued.length = 0;
  selectMock.mockClear();
});

describe('readSecurityAgentCoverage — installer_missing deep link (#9247)', () => {
  it("links an installer_missing row to the Versions tab of the vendor's package in that row's policy", async () => {
    prime([row({})], [[POLICY], CATALOGS]);
    const { rows } = await readSecurityAgentCoverage(SCOPE, Q);
    expect(rows[0]).toMatchObject({ reasonCode: 'installer_missing', setupPath: `/software#versions=${S1_CATALOG}` });
    // The internal policy id is not part of the row contract.
    expect(rows[0]).not.toHaveProperty('policyId');
  });

  it('rows with any other reason get no link and cost no extra query', async () => {
    prime([
      row({ id: 'r-covered', state: 'covered', reasonCode: null }),
      row({ id: 'r-unmapped', reasonCode: 'org_not_mapped' }),
    ]);
    const { rows } = await readSecurityAgentCoverage(SCOPE, Q);
    expect(rows.map((r) => r.setupPath)).toEqual([null, null]);
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  it("two policies (partner-wide + org) each link to their own policy's package", async () => {
    const otherPolicy = { id: 'policy-2', rules: { software: [{ name: 'Sentinel Agent*', catalogId: 'cat-s1-b' }] } };
    prime(
      [row({ id: 'r-1' }), row({ id: 'r-2', deviceId: 'dev-2', policyId: 'policy-2' })],
      [[POLICY, otherPolicy], [...CATALOGS, { id: 'cat-s1-b', integrationProvider: 'sentinelone', builtinPackageKey: null }]],
    );
    const { rows } = await readSecurityAgentCoverage(SCOPE, Q);
    expect(rows.map((r) => r.setupPath)).toEqual([`/software#versions=${S1_CATALOG}`, '/software#versions=cat-s1-b']);
  });

  it.each<[string, unknown]>([
    ['null rules', null],
    ['software not an array', { software: 'x' }],
    ['a rule without a catalogId', { software: [{ name: 'Sentinel Agent*' }] }],
  ])('malformed policy rules (%s) yield no link and do not throw', async (_name, rules) => {
    prime([row({})], [[{ id: 'policy-1', rules }]]);
    const { rows } = await readSecurityAgentCoverage(SCOPE, Q);
    expect(rows[0]?.setupPath).toBeNull();
  });

  it('falls back to no link when the policy (or its vendor rule) is not readable', async () => {
    prime([row({}), row({ id: 'r-2', policyId: null })], [[], []]);
    const { rows } = await readSecurityAgentCoverage(SCOPE, Q);
    expect(rows.map((r) => r.setupPath)).toEqual([null, null]);
  });
});
