import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The engine's DB-touching phases are proven by the Task-7 integration
// gauntlet against real Postgres. This file covers the pure logic
// (`validateMergePair`, warning shaping, drain-wait env parsing) plus the
// chain walk, which is driven through a mocked `db.execute` queue in the
// same style as `tenantCascade.test.ts`.
const mockState = vi.hoisted(() => ({
  /** queued execute() responses (FIFO). */
  executeResponses: [] as Array<unknown>,
  /** captured SQL text fragments for verification. */
  executedSql: [] as string[],
  /** captured bound params, one array per execute() call. */
  executedParams: [] as unknown[][],
  /** ordered record of context escalations, for the scope-escalation test. */
  escalations: [] as string[],
  /** what getCurrentDbAccessContext() reports. */
  ambientContext: undefined as { scope: string } | undefined,
  /** when set, any execute() whose SQL text matches is REJECTED (never a global regex — .test is stateful). */
  failExecuteMatching: null as RegExp | null,
  /** id returned by the mocked `db.insert(...).values(...).returning(...)`. */
  insertedId: 'merge-event-1',
}));

function sqlToText(q: unknown): string {
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object') {
          if ('value' in c && Array.isArray((c as { value: unknown[] }).value)) {
            return (c as { value: string[] }).value.join('');
          }
          if ('queryChunks' in c) return sqlToText(c);
        }
        return '';
      })
      .join(' ');
  }
  return String(q);
}

function sqlToParams(q: unknown): unknown[] {
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const out: unknown[] = [];
    for (const c of (q as { queryChunks: unknown[] }).queryChunks) {
      if (c && typeof c === 'object') {
        // Nested sql`` fragment (e.g. the `${v}::uuid` cast helper) — recurse.
        if ('queryChunks' in c) out.push(...sqlToParams(c));
        // A drizzle Param wrapper; StringChunk's `value` is a string[], skip it.
        else if ('value' in c && !Array.isArray((c as { value: unknown }).value)) {
          out.push((c as { value: unknown }).value);
        }
      } else {
        // Bare interpolated value — drizzle keeps primitives inline, not boxed.
        out.push(c);
      }
    }
    return out;
  }
  return [];
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(<T,>(fn: () => Promise<T>) => {
    mockState.escalations.push('runOutsideDbContext');
    return fn();
  }),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    mockState.escalations.push('withSystemDbAccessContext');
    return fn();
  }),
  getCurrentDbAccessContext: vi.fn(() => mockState.ambientContext),
  db: {
    execute: vi.fn((q: unknown) => {
      const text = sqlToText(q);
      mockState.executedSql.push(text);
      mockState.executedParams.push(sqlToParams(q));
      if (mockState.failExecuteMatching?.test(text)) {
        return Promise.reject(new Error('stamp write exploded'));
      }
      const next = mockState.executeResponses.shift();
      return Promise.resolve(next === undefined ? [] : next);
    }),
    // Only `org_merge_events` is written through the query builder; everything
    // else in this module goes through `execute`.
    insert: vi.fn(() => ({
      values: () => ({ returning: () => Promise.resolve([{ id: mockState.insertedId }]) }),
    })),
  },
}));

vi.mock('./auditService', () => ({
  createAuditLog: vi.fn(async () => {}),
}));

import {
  validateMergePair,
  resolveMergedOrgIds,
  assertPairStillMergeable,
  buildMergeWarnings,
  getFenceDrainMs,
  runPolicy,
  stampTerminalShell,
  MERGE_CHAIN_DEPTH_CAP,
  INTEGRATION_CONNECTION_TABLES,
  type OrgMergeCandidate,
} from './orgMerge';
import * as orgMergeModule from './orgMerge';
import { createAuditLog } from './auditService';

const org = (over: Partial<Record<string, unknown>>) => ({
  id: 'a',
  partnerId: 'p1',
  name: 'Acme',
  type: 'customer',
  status: 'active',
  deletedAt: null,
  ...over,
}) as unknown as OrgMergeCandidate;

describe('validateMergePair', () => {
  it('accepts same-partner active pair', () =>
    expect(validateMergePair(org({ id: 'l' }), org({ id: 's' }))).toBeNull());

  it('rejects cross-partner', () =>
    expect(validateMergePair(org({ id: 'l', partnerId: 'p2' }), org({ id: 's' }))).toMatch(/partner/i));

  it('rejects self-merge', () =>
    expect(validateMergePair(org({ id: 'x' }), org({ id: 'x' }))).toMatch(/itself/i));

  it('rejects quick_support loser', () =>
    expect(validateMergePair(org({ id: 'l', type: 'quick_support' }), org({ id: 's' }))).toMatch(/quick.support/i));

  it('rejects quick_support survivor', () =>
    expect(validateMergePair(org({ id: 'l' }), org({ id: 's', type: 'quick_support' }))).toMatch(/quick.support/i));

  it('rejects archived/merging loser', () => {
    for (const status of ['archived', 'merging', 'purging', 'churned', 'offboarding']) {
      expect(validateMergePair(org({ id: 'l', status }), org({ id: 's' })), status).not.toBeNull();
    }
  });

  it('rejects non-usable survivor', () =>
    expect(validateMergePair(org({ id: 'l' }), org({ id: 's', status: 'suspended' }))).not.toBeNull());

  it('accepts suspended loser (merging away a suspended duplicate is legal)', () =>
    expect(validateMergePair(org({ id: 'l', status: 'suspended' }), org({ id: 's' }))).toBeNull());

  it('accepts trial on both sides', () =>
    expect(validateMergePair(org({ id: 'l', status: 'trial' }), org({ id: 's', status: 'trial' }))).toBeNull());

  it('rejects a soft-deleted loser', () =>
    expect(validateMergePair(org({ id: 'l', deletedAt: new Date() }), org({ id: 's' }))).toMatch(/delet/i));

  it('rejects a soft-deleted survivor', () =>
    expect(validateMergePair(org({ id: 'l' }), org({ id: 's', deletedAt: new Date() }))).toMatch(/delet/i));

  it('accepts internal orgs (only quick_support is special)', () =>
    expect(validateMergePair(org({ id: 'l', type: 'internal' }), org({ id: 's', type: 'internal' }))).toBeNull());
});

describe('resolveMergedOrgIds', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.executedParams = [];
    mockState.escalations = [];
    mockState.ambientContext = { scope: 'system' };
  });

  it('returns just the org when it was never a merge loser', async () => {
    mockState.executeResponses = [[]];
    await expect(resolveMergedOrgIds('a', 'p1')).resolves.toEqual(['a']);
  });

  it('follows a single hop', async () => {
    mockState.executeResponses = [[{ survivor_org_id: 'b' }], []];
    await expect(resolveMergedOrgIds('a', 'p1')).resolves.toEqual(['a', 'b']);
  });

  it('follows a two-hop chain a -> b -> c', async () => {
    mockState.executeResponses = [[{ survivor_org_id: 'b' }], [{ survivor_org_id: 'c' }], []];
    await expect(resolveMergedOrgIds('a', 'p1')).resolves.toEqual(['a', 'b', 'c']);
  });

  it('binds the partner id into every hop (token partner is the trust anchor)', async () => {
    mockState.executeResponses = [[{ survivor_org_id: 'b' }], []];
    await resolveMergedOrgIds('a', 'p1');
    for (const params of mockState.executedParams) {
      expect(params).toContain('p1');
    }
  });

  it('stops at the depth cap on a pathological chain', async () => {
    // Always report another survivor; the cap is the only thing that stops it.
    mockState.executeResponses = Array.from({ length: 50 }, (_, i) => [
      { survivor_org_id: `hop-${i + 1}` },
    ]);
    const chain = await resolveMergedOrgIds('a', 'p1');
    expect(chain).toHaveLength(MERGE_CHAIN_DEPTH_CAP + 1);
    expect(chain[0]).toBe('a');
  });

  it('breaks a cycle instead of looping', async () => {
    mockState.executeResponses = [
      [{ survivor_org_id: 'b' }],
      [{ survivor_org_id: 'a' }],
    ];
    await expect(resolveMergedOrgIds('a', 'p1')).resolves.toEqual(['a', 'b']);
  });

  // org_merge_events is partner-axis: `system OR breeze_has_partner_access`.
  // An org-scoped context never passes that policy, so without the escalation
  // every hop reads zero rows and the chain silently degrades to [orgId] —
  // which looks exactly like "never merged" to Task 6's public quote route.
  it('escapes a narrower ambient context before reading the partner-axis table', async () => {
    mockState.ambientContext = { scope: 'organization' };
    mockState.executeResponses = [[{ survivor_org_id: 'b' }], []];
    await expect(resolveMergedOrgIds('a', 'p1')).resolves.toEqual(['a', 'b']);
    expect(mockState.escalations).toEqual(['runOutsideDbContext', 'withSystemDbAccessContext']);
  });

  it('reuses an already-system context without acquiring a second connection', async () => {
    mockState.ambientContext = { scope: 'system' };
    mockState.executeResponses = [[]];
    await resolveMergedOrgIds('a', 'p1');
    expect(mockState.escalations).toEqual(['withSystemDbAccessContext']);
  });

  it('opens a system context when there is no ambient context at all', async () => {
    mockState.ambientContext = undefined;
    mockState.executeResponses = [[]];
    await resolveMergedOrgIds('a', 'p1');
    expect(mockState.escalations).toEqual(['withSystemDbAccessContext']);
  });
});

describe('buildMergeWarnings', () => {
  const empty = {
    duplicatePortalEmails: [],
    duplicateExternalLinkSystems: [],
    connectionDrops: [],
    notes: [],
  };

  it('is empty when nothing needs operator review', () => {
    expect(buildMergeWarnings(empty)).toEqual([]);
  });

  it('reports duplicate portal_users emails under the survivor', () => {
    const warnings = buildMergeWarnings({
      ...empty,
      duplicatePortalEmails: [{ email: 'ap@acme.com', count: 2 }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/portal_users/);
    expect(warnings[0]).toMatch(/ap@acme\.com/);
    expect(warnings[0]).toMatch(/2/);
  });

  it('reports duplicate organization_external_links systems', () => {
    const warnings = buildMergeWarnings({
      ...empty,
      duplicateExternalLinkSystems: [{ system: 'quickbooks', count: 2 }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/organization_external_links/);
    expect(warnings[0]).toMatch(/quickbooks/);
  });

  it('reports discarded third-party connections explicitly', () => {
    const warnings = buildMergeWarnings({
      ...empty,
      connectionDrops: [
        { table: 'm365_connections', dropped: 1 },
        { table: 'google_workspace_connections', dropped: 2 },
      ],
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toMatch(/m365_connections/);
    expect(warnings.join('\n')).toMatch(/google_workspace_connections/);
    for (const w of warnings) expect(w).toMatch(/re-?authorize|reconnect/i);
  });

  it('omits connection tables that dropped nothing', () => {
    expect(
      buildMergeWarnings({ ...empty, connectionDrops: [{ table: 'm365_connections', dropped: 0 }] })
    ).toEqual([]);
  });

  it('passes executor notes through verbatim', () => {
    expect(buildMergeWarnings({ ...empty, notes: ['demoted 1 contact'] })).toEqual(['demoted 1 contact']);
  });

  it('carries revocation and role-conflict notes through as warnings', () => {
    const notes = [
      "api_keys: revoked 2 API key belonging to the merged-away org",
      "organization_users role conflict for a@b.test: role 'Org Admin' from the merged-away org was discarded, survivor role 'Org Viewer' kept",
    ];
    expect(buildMergeWarnings({ ...empty, notes })).toEqual(notes);
  });

  it('covers every third-party connection table the registry drops from', () => {
    expect([...INTEGRATION_CONNECTION_TABLES].sort()).toEqual([
      'client_ai_tenant_mappings',
      'delegant_m365_connections',
      'google_workspace_connections',
      'm365_connections',
    ]);
  });
});

describe('assertPairStillMergeable (in-transaction TOCTOU re-check)', () => {
  const L = 'loser-id';
  const S = 'survivor-id';
  const loser = org({ id: L, status: 'active' });
  const survivor = org({ id: S, status: 'active' });
  const row = (over: Record<string, unknown>) => ({
    id: L,
    partner_id: 'p1',
    name: 'Acme',
    type: 'customer',
    status: 'merging',
    deleted_at: null,
    ...over,
  });

  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.executedParams = [];
  });

  it('locks both rows FOR UPDATE and passes when nothing changed', async () => {
    mockState.executeResponses = [[row({}), row({ id: S, status: 'active' })]];
    await expect(assertPairStillMergeable(loser, survivor)).resolves.toBeUndefined();
    expect(mockState.executedSql.join(' ')).toMatch(/FOR UPDATE/);
  });

  it('rejects when the survivor was suspended during the drain', async () => {
    mockState.executeResponses = [[row({}), row({ id: S, status: 'suspended' })]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/active or trial/i);
  });

  it('rejects when the survivor was soft-deleted during the drain', async () => {
    mockState.executeResponses = [[row({}), row({ id: S, status: 'active', deleted_at: new Date() })]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/delet/i);
  });

  it('rejects when the loser is no longer fenced (a sweeper unfenced it)', async () => {
    mockState.executeResponses = [[row({ status: 'active' }), row({ id: S, status: 'active' })]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/no longer fenced/i);
  });

  it('rejects when the loser was already stamped deleted by a concurrent merge', async () => {
    mockState.executeResponses = [[row({ deleted_at: new Date() }), row({ id: S, status: 'active' })]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/no longer fenced/i);
  });

  it('rejects when the survivor moved to another partner', async () => {
    mockState.executeResponses = [[row({ partner_id: 'p2' }), row({ id: S, status: 'active' })]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/same partner/i);
  });

  it('rejects when an org disappeared entirely', async () => {
    mockState.executeResponses = [[row({})]];
    await expect(assertPairStillMergeable(loser, survivor)).rejects.toThrow(/disappeared/i);
  });
});

describe('getFenceDrainMs', () => {
  const original = process.env.ORG_MERGE_FENCE_DRAIN_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = original;
  });

  it('defaults to 30s', () => {
    delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    expect(getFenceDrainMs()).toBe(30_000);
  });

  it('honors 0 (tests skip the drain entirely)', () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    expect(getFenceDrainMs()).toBe(0);
  });

  it('honors an explicit override', () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '250';
    expect(getFenceDrainMs()).toBe(250);
  });

  it('falls back to the default on garbage or negatives', () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = 'soon';
    expect(getFenceDrainMs()).toBe(30_000);
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '-1';
    expect(getFenceDrainMs()).toBe(30_000);
  });

  /**
   * The #2819/#2823 trap, and the reason this reader goes through `envInt`.
   * Compose threads every variable in explicitly as `VAR: ${VAR:-}`, so an
   * UNSET variable arrives at the container SET to an empty string. `??` never
   * fires on `''`, so the obvious `Number(process.env.X ?? 30_000)` yields 0 —
   * here, a zero-length drain that lets in-flight writers keep writing under
   * the loser straight through Phase B. Distinct from the '0' case above, which
   * is a deliberate override the integration suite depends on.
   */
  it('treats an EMPTY variable as absent, not as 0', () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '';
    expect(getFenceDrainMs()).toBe(30_000);
  });
});

/**
 * The `resolve`/`move` split is a correctness fix, not a refactor: 97 of the
 * merge's tables have their `org_id` rewritten by a parent's ON UPDATE CASCADE
 * (Postgres builds that action trigger NON-deferrable, so `SET CONSTRAINTS ALL
 * DEFERRED` does not hold it back), which pre-empts their own dedupe DELETE and
 * drags colliding rows into the survivor. The end-to-end proof is the Task-7
 * integration gauntlet; these cases pin the split itself in the fast unit job,
 * where a one-line regression would otherwise only surface hours later.
 */
describe('runPolicy phases', () => {
  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.executedParams = [];
  });

  const L = '11111111-1111-1111-1111-111111111111';
  const S = '22222222-2222-2222-2222-222222222222';

  it('repoint-dedupe: resolve issues ONLY the DELETE, move ONLY the repoint', async () => {
    const policy = { kind: 'repoint-dedupe', key: ['ip_address'] } as const;

    mockState.executeResponses = [{ count: 3 }];
    const resolved = await runPolicy('discovered_assets', policy, L, S, 'resolve');
    expect(resolved).toEqual({ moved: 0, dropped: 3, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
    expect(mockState.executedSql[0]).toMatch(/DELETE FROM/);
    expect(mockState.executedSql[0]).not.toMatch(/UPDATE/);

    mockState.executedSql = [];
    mockState.executeResponses = [{ count: 7 }];
    const moved = await runPolicy('discovered_assets', policy, L, S, 'move');
    expect(moved).toEqual({ moved: 7, dropped: 0, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
    expect(mockState.executedSql[0]).toMatch(/UPDATE/);
    expect(mockState.executedSql[0]).not.toMatch(/DELETE FROM/);
  });

  it('keep-survivor: same split', async () => {
    const policy = { kind: 'keep-survivor' } as const;

    mockState.executeResponses = [{ count: 1 }];
    expect(await runPolicy('portal_branding', policy, L, S, 'resolve'))
      .toEqual({ moved: 0, dropped: 1, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
    expect(mockState.executedSql[0]).toMatch(/DELETE FROM/);

    mockState.executedSql = [];
    mockState.executeResponses = [{ count: 1 }];
    expect(await runPolicy('portal_branding', policy, L, S, 'move'))
      .toEqual({ moved: 1, dropped: 0, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
    expect(mockState.executedSql[0]).toMatch(/UPDATE/);
  });

  it('repoint issues nothing in the resolve pass', async () => {
    expect(await runPolicy('quotes', { kind: 'repoint' }, L, S, 'resolve'))
      .toEqual({ moved: 0, dropped: 0, notes: [] });
    expect(mockState.executedSql).toEqual([]);

    mockState.executeResponses = [{ count: 2 }];
    expect(await runPolicy('quotes', { kind: 'repoint' }, L, S, 'move'))
      .toEqual({ moved: 2, dropped: 0, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
  });

  it('custom executors run whole, in the move pass only, unless they declare a resolve half', async () => {
    // `contacts` has a real executor and NO resolve half; resolve must not
    // invoke it (which would demote AND repoint before the walk had started).
    const policy = { kind: 'custom', note: 'contacts' } as const;
    expect(await runPolicy('contacts', policy, L, S, 'resolve'))
      .toEqual({ moved: 0, dropped: 0, notes: [] });
    expect(mockState.executedSql).toEqual([]);

    mockState.executeResponses = [{ count: 0 }, { count: 4 }];
    const moved = await runPolicy('contacts', policy, L, S, 'move');
    expect(moved.moved).toBe(4);
    expect(mockState.executedSql).toHaveLength(2);
  });

  /**
   * `discovered_assets` is the one custom table that MUST also act in the
   * resolve pass: it rides `sites`' non-deferrable ON UPDATE CASCADE, so its
   * duplicate-IP rows are dragged into the survivor org the instant the walk
   * repoints `sites` — hundreds of tables before its own `move` half would run.
   * Resolving from `move` would therefore always be too late and every such
   * merge would die on 23505.
   */
  it('a custom table with a resolve half runs it in the resolve pass, and only repoints in move', async () => {
    const policy = { kind: 'custom', note: 'discovered_assets' } as const;

    // 5 child re-homes + 1 DELETE, all in the RESOLVE pass.
    mockState.executeResponses = [
      { count: 0 }, { count: 2 }, { count: 0 }, { count: 0 }, { count: 0 }, { count: 1 },
    ];
    const resolved = await runPolicy('discovered_assets', policy, L, S, 'resolve');
    expect(resolved.dropped).toBe(1);
    expect(resolved.moved).toBe(0);
    expect(mockState.executedSql).toHaveLength(6);
    // The children are re-homed BEFORE the delete — the other order is the
    // 23503 this whole executor exists to prevent.
    expect(mockState.executedSql.slice(0, 5).every((s) => /UPDATE/.test(s) && !/DELETE/.test(s))).toBe(true);
    expect(mockState.executedSql[5]).toMatch(/DELETE FROM/);
    expect(resolved.notes.join('\n')).toMatch(/dropped 1 duplicate discovered asset/);
    expect(resolved.notes.join('\n')).toMatch(/snmp_devices: 2/);

    // The MOVE half is a plain repoint and nothing else.
    mockState.executedSql = [];
    mockState.executeResponses = [{ count: 3 }];
    const movedAssets = await runPolicy('discovered_assets', policy, L, S, 'move');
    expect(movedAssets).toEqual({ moved: 3, dropped: 0, notes: [] });
    expect(mockState.executedSql).toHaveLength(1);
    expect(mockState.executedSql[0]).toMatch(/UPDATE/);
    expect(mockState.executedSql[0]).not.toMatch(/DELETE FROM/);
  });

  it('no-op policy kinds stay no-ops in both passes', async () => {
    for (const kind of ['loser-shell', 'leave-for-erasure', 'derived', 'follows-parent'] as const) {
      for (const phase of ['resolve', 'move'] as const) {
        const policy = (kind === 'loser-shell' ? { kind } : { kind, note: 'n' }) as never;
        expect(await runPolicy('audit_logs', policy, L, S, phase), `${kind}/${phase}`)
          .toEqual({ moved: 0, dropped: 0, notes: [] });
      }
    }
    expect(mockState.executedSql).toEqual([]);
  });

  it('an unregistered custom table throws rather than silently stranding rows', async () => {
    await expect(
      runPolicy('not_a_custom_table', { kind: 'custom', note: 'x' }, L, S, 'move'),
    ).rejects.toThrow(/no executor/i);
  });
});

/**
 * `stampTerminalShell` runs AFTER Phase B has committed, in a transaction of
 * its own (see the function's own comment for why the schema forces that).
 * Two properties are load-bearing and neither is visible in the integration
 * gauntlet, which only exercises the happy path:
 *
 *   - it must NEVER throw, and must sit OUTSIDE `executeOrgMerge`'s try/catch.
 *     Throwing from here would make the job — and the operator — treat a
 *     durable, fully committed merge as a failure, and if the call were inside
 *     the try it would also trigger `unfenceLoser` on an already-emptied org.
 *   - its failure must leave a durable record, because the org is then in a
 *     state only the offboarding sweeper's case 3 can finish.
 */
describe('stampTerminalShell', () => {
  const LOSER = '33333333-3333-3333-3333-333333333333';
  const SURVIVOR = '44444444-4444-4444-4444-444444444444';
  const PARTNER = '55555555-5555-5555-5555-555555555555';
  const loser = org({ id: LOSER, partnerId: PARTNER, name: 'Loser Co' });
  const survivor = org({ id: SURVIVOR, partnerId: PARTNER, name: 'Survivor Co' });
  const input = {
    loserOrgId: LOSER,
    survivorOrgId: SURVIVOR,
    partnerId: PARTNER,
    performedBy: '66666666-6666-6666-6666-666666666666',
    performedByEmail: 'admin@example.test',
  };
  /** The stamp is the only statement in this module that writes deleted_at = now(). */
  const STAMP_SQL = /deleted_at = now\(\)/;

  beforeEach(() => {
    mockState.executeResponses = [];
    mockState.executedSql = [];
    mockState.executedParams = [];
    mockState.failExecuteMatching = null;
    vi.mocked(createAuditLog).mockClear();
  });

  afterEach(() => {
    mockState.failExecuteMatching = null;
    vi.restoreAllMocks();
  });

  it('retries a failing stamp, then records it rather than throwing', async () => {
    mockState.failExecuteMatching = STAMP_SQL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(stampTerminalShell(input, loser)).resolves.toBeUndefined();

    // Three attempts, not one: the statement is an idempotent single-row
    // UPDATE, so a transient connection failure must not cost the stamp.
    expect(mockState.executedSql.filter((s) => STAMP_SQL.test(s))).toHaveLength(3);
    expect(error).toHaveBeenCalled();
    // A hard failure is not the "already stamped" case — no rowcount warning.
    expect(warn).not.toHaveBeenCalled();

    expect(createAuditLog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAuditLog).mock.calls[0]![0]).toMatchObject({
      // Org-less on purpose: an audit scoped to the loser dies with it in Phase C.
      orgId: null,
      action: 'org.merge.shell_stamp_failed',
      result: 'failure',
      resourceType: 'organization',
      resourceId: LOSER,
      actorId: input.performedBy,
      actorEmail: input.performedByEmail,
      details: expect.objectContaining({
        loserOrgId: LOSER,
        loserOrgName: 'Loser Co',
        survivorOrgId: SURVIVOR,
        attempts: 3,
        error: 'stamp write exploded',
      }),
    });

    warn.mockRestore();
    error.mockRestore();
  });

  it('warns (but does not retry or audit) when the stamp matched no row', async () => {
    mockState.executeResponses = [{ count: 0 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await stampTerminalShell(input, loser);

    expect(mockState.executedSql.filter((s) => STAMP_SQL.test(s))).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('matched no row'));
    // Zero rows means someone else already stamped it — not a failure.
    expect(createAuditLog).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('is silent on a clean stamp', async () => {
    mockState.executeResponses = [{ count: 1 }];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await stampTerminalShell(input, loser);

    expect(mockState.executedSql.filter((s) => STAMP_SQL.test(s))).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(createAuditLog).not.toHaveBeenCalled();

    warn.mockRestore();
    error.mockRestore();
  });

  // The placement assertion. Phase B is stubbed out through the module
  // namespace (the same `self.` surface the engine uses), the stamp is left
  // REAL, and its write is made to fail: `executeOrgMerge` must still resolve
  // with the merge result, and must NOT unfence — the merge committed.
  it('a failing stamp still resolves executeOrgMerge and never unfences', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(orgMergeModule, 'loadAndValidate').mockResolvedValue({ loser, survivor });
    vi.spyOn(orgMergeModule, 'fenceLoser').mockResolvedValue(undefined);
    vi.spyOn(orgMergeModule, 'assertPairStillMergeable').mockResolvedValue(undefined);
    vi.spyOn(orgMergeModule, 'runPolicy').mockResolvedValue({ moved: 0, dropped: 0, notes: [] });
    vi.spyOn(orgMergeModule, 'runPostPassFixups').mockResolvedValue({ moved: 0, dropped: 0 });
    vi.spyOn(orgMergeModule, 'collectDuplicates').mockResolvedValue({
      duplicatePortalEmails: [],
      duplicateExternalLinkSystems: [],
    });
    const unfence = vi.spyOn(orgMergeModule, 'unfenceLoser').mockResolvedValue(undefined);
    mockState.failExecuteMatching = STAMP_SQL;

    const result = await orgMergeModule.executeOrgMerge(input);

    expect(result.mergeEventId).toBe('merge-event-1');
    expect(result.tables).toEqual({});
    expect(result.warnings).toEqual([]);
    // The whole point: a committed merge is never rolled back or unfenced
    // because its bookkeeping write failed afterwards.
    expect(unfence).not.toHaveBeenCalled();
    expect(vi.mocked(createAuditLog).mock.calls.map((c) => c[0]!.action))
      .toEqual(['org.merge.shell_stamp_failed']);

    error.mockRestore();
  }, 20_000);
});

describe('blocks-merge refusal', () => {
  it('refuses before fencing and audits org.merge.failed', async () => {
    vi.spyOn(orgMergeModule, 'loadAndValidate').mockResolvedValue({
      loser: { id: 'a', partnerId: 'p', name: 'Loser', type: 'standard', status: 'active', deletedAt: null },
      survivor: { id: 'b', partnerId: 'p', name: 'Survivor', type: 'standard', status: 'active', deletedAt: null },
    } as never);
    const fence = vi.spyOn(orgMergeModule, 'fenceLoser').mockResolvedValue(undefined as never);
    vi.spyOn(orgMergeModule, 'collectMergeBlockers').mockResolvedValue([{ table: 'pam_actuations', loserRows: 3 }]);
    const audit = vi.spyOn(orgMergeModule, 'writeMergeAudit').mockResolvedValue(undefined as never);

    await expect(
      orgMergeModule.executeOrgMerge({ loserOrgId: 'a', survivorOrgId: 'b', partnerId: 'p', performedBy: 'u' }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED' });

    expect(fence).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'org.merge.failed' }));
  });

  it('builds the operator refusal text with per-table counts', () => {
    const msg = orgMergeModule.buildMergeBlockedMessage([
      { table: 'pam_actuation_results', loserRows: 2 },
      { table: 'pam_actuations', loserRows: 1 },
    ]);
    expect(msg).toContain('2 pam_actuation_results row(s), 1 pam_actuations row(s)');
    expect(msg).toContain('Audit-admin retention is not a merge mechanism');
  });

  // previewOrgMerge itself walks the ~260-table registry through
  // `db.execute`; replaying that in a mocked FIFO queue just to prove a
  // one-line ternary is disproportionate. `computeMergeVerdict` is the
  // extracted pure seam that ternary now lives in — tested directly here.
  it('verdict precedence: blocked wins over too-large when both conditions hold', () => {
    const verdict = orgMergeModule.computeMergeVerdict(
      [{ table: 'pam_actuations', loserRows: 1 }],
      Number.MAX_SAFE_INTEGER, // far beyond ORG_MERGE_MAX_ROWS under any config
    );
    expect(verdict).toBe('blocked');
  });
});
