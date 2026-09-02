import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import type { ResolvedVariable, TenantVariableScope } from '../tenantVariableResolution';
import {
  computeEffectDigestForRelease,
  computeEffectDigestOutcome,
  effectDigestResolverKey,
  hasPinnedDigest,
} from './effectDigest';

/**
 * The ONE seam this suite needs (#3409 PR4c-1).
 *
 * `run_script`'s resolver now builds the verified snapshot
 * (`runScriptSnapshot.ts`), and that builder loads the tenant-variable scope
 * through `loadTenantVariableScope` — the single function in this file's
 * import graph that needs real DB machinery. Its default path reads the
 * module-level `db` singleton, and its `opts.database` path (the one the
 * digest takes, Task 3b) asserts an already-open system-scoped context, which
 * a unit test has none of. Everything else in `tenantVariableResolution`
 * (notably `resolveForOrg` / `unreadableForOrg`, which the builder actually
 * uses to shape the pinned references) is left REAL by the `importOriginal`
 * spread, so this stays a seam over the loader rather than a mock of the
 * resolution logic under test.
 *
 * The rest of the module's no-`vi.mock` stance is unchanged: every resolver
 * still runs against whatever fake `Database` the test hands it.
 */
const { loadScope } = vi.hoisted(() => ({ loadScope: vi.fn() }));
vi.mock('../tenantVariableResolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tenantVariableResolution')>()),
  loadTenantVariableScope: loadScope,
}));

/**
 * The flattened `string | null` digest, through the LIVE release entry point.
 *
 * The module has exactly two entry points — `computeEffectDigestOutcome`
 * (creation) and `computeEffectDigestForRelease` (both release paths) — and
 * every resolver assertion below only cares about the digest half. Flattening
 * once here keeps the resolver cases readable while still driving a function
 * production actually calls; the `context` half is asserted separately, in the
 * two release suites that consume it.
 */
async function digestFor(
  toolName: string,
  args: Record<string, unknown>,
  database: Database,
): Promise<string | null> {
  return (await computeEffectDigestForRelease(toolName, args, database)).digest;
}

/**
 * Generic fake `Database`: every `.select(...).from(...).where(...)` chain
 * resolves to the next array shifted off `queue`, whether the resolver calls
 * `.limit(1)` (single-row lookups), `.orderBy(...)` (the quote-lines fetch,
 * which has no limit) or awaits the chain directly (run_script's device -> org
 * lookup, whose `inArray` already bounds the row count so a `.limit()` there
 * would exist only to satisfy a stub). Resolvers that issue N sequential
 * queries (manage_quotes:send: quote then lines; void_payment: payment then
 * invoice; run_script: script then devices) consume the queue in call order —
 * tests supply rows in that same order.
 */
function makeFakeDb(queue: unknown[][]): { database: Database; select: ReturnType<typeof vi.fn> } {
  const take = async () => queue.shift() ?? [];
  const chain = {
    limit: vi.fn(take),
    orderBy: vi.fn(take),
    then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
      take().then(resolve, reject),
  };
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => chain),
    })),
  }));
  return { database: { select } as unknown as Database, select };
}

/** A full `scripts` row as the run_script snapshot builder selects it. */
const scriptRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'script-1',
  orgId: 'org-1',
  language: 'bash',
  content: '#!/bin/bash\necho hi',
  timeoutSeconds: 300,
  runAs: 'user',
  parameters: null,
  ...overrides,
});

const deviceRow = (id: string, orgId: string) => ({ id, orgId });

/**
 * run_script's two-query queue, in the order the builder issues them:
 * the script lookup, then the device -> org lookup.
 */
function runScriptDb(
  script: Record<string, unknown> | null,
  devices: Array<{ id: string; orgId: string }> = [deviceRow('device-1', 'org-1')],
) {
  return makeFakeDb([script === null ? [] : [script], devices]);
}

const RUN_SCRIPT_ARGS = { scriptId: 'script-1', deviceIds: ['device-1'] };

const variable = (overrides: Partial<ResolvedVariable> & { key: string }): ResolvedVariable => ({
  value: 'ordinary-value',
  isSecret: false,
  variableId: 'var-1',
  version: 1,
  ownerScope: 'organization',
  ...overrides,
});

/**
 * A hand-built `TenantVariableScope` carrier — duplicated from
 * `runScriptSnapshot.test.ts` rather than shared, since it is six lines and
 * both suites are the only readers. `loadTenantVariableScope` is the sole
 * sanctioned constructor and it reads the module-level `db`, hence the seam
 * above; only the DATA is faked, the production accessors still run over it.
 */
function fakeScope(orgs: Array<{ orgId: string; present?: ResolvedVariable[]; unreadable?: string[] }>): TenantVariableScope {
  return {
    orgIds: new Set(orgs.map((o) => o.orgId)),
    byOrg: new Map(orgs.map((o) => [o.orgId, new Map((o.present ?? []).map((v) => [v.key, v]))])),
    unreadableKeysByOrg: new Map(orgs.map((o) => [o.orgId, new Set(o.unreadable ?? [])])),
  } as unknown as TenantVariableScope;
}

beforeEach(() => {
  loadScope.mockReset();
  loadScope.mockResolvedValue(fakeScope([]));
});

describe('computeEffectDigestOutcome', () => {
  describe('unpinnable tools → not_applicable', () => {
    it('returns not_applicable for a tool with no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('list_scripts', { orgId: 'org-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });

    it('returns not_applicable for a multiplexer tool whose action has no resolver entry', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'decline', quoteId: 'q-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  // The distinction the old `string | null` return conflated: "no resolver"
  // (expected) vs "a resolver existed and produced nothing" (a silently
  // unpinned intent). All three still store NULL; only these two are auditable.
  describe('unresolved outcomes are distinguishable from not_applicable', () => {
    it('reports missing_arg when the id argument is absent', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('run_script', { deviceIds: ['device-1'] }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });

    it('reports missing_arg when the id argument is present but not a string', async () => {
      const { database } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('run_script', { scriptId: 42 }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    });

    it('reports target_absent when the referenced row does not exist (deleted/typoed id)', async () => {
      const { database } = runScriptDb(null);
      const outcome = await computeEffectDigestOutcome(
        'run_script',
        { ...RUN_SCRIPT_ARGS, scriptId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    // `deviceIds` is `required` in run_script's tool schema (aiToolsScripts.ts),
    // so a call without it is MALFORMED, not a target that vanished — the same
    // bucket a missing scriptId lands in.
    it('reports missing_arg when deviceIds is absent, even with a valid scriptId', async () => {
      const { database, select } = runScriptDb(scriptRow());
      const outcome = await computeEffectDigestOutcome('run_script', { scriptId: 'script-1' }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });

    // Fail closed on a device that no longer resolves: silently dropping it
    // would shrink the pinned org set, and with it the reference set, letting
    // a digest match while the approved fan-out no longer exists.
    it('reports target_absent when a targeted device no longer resolves to an org', async () => {
      const { database } = runScriptDb(scriptRow(), [deviceRow('device-1', 'org-1')]);
      const outcome = await computeEffectDigestOutcome(
        'run_script',
        { scriptId: 'script-1', deviceIds: ['device-1', 'ghost-device'] },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('run_script', () => {
    it('produces the same digest for an unchanged script row', async () => {
      const d1 = await computeEffectDigestOutcome('run_script', RUN_SCRIPT_ARGS, runScriptDb(scriptRow()).database);
      const d2 = await computeEffectDigestOutcome('run_script', RUN_SCRIPT_ARGS, runScriptDb(scriptRow()).database);
      expect(d1.kind).toBe('pinned');
      expect(d1).toEqual({ kind: 'pinned', digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(d1).toEqual(d2);
    });

    // The CREATION path projects `verified` back off: it has no dispatch to
    // feed and no business holding decrypted tenant plaintext one property
    // access away. `toEqual` above cannot see the difference (extra keys on
    // the received object are compared, but `verified` sits on the RESOLVER's
    // result, not the outcome) — so pin the returned key set explicitly. A
    // future change that lets the resolver's `verified` leak into the outcome
    // fails here.
    it('never returns the resolved material on the creation path', async () => {
      loadScope.mockResolvedValueOnce(fakeScope([{ orgId: 'org-1' }]));
      const outcome = await computeEffectDigestOutcome(
        'run_script',
        RUN_SCRIPT_ARGS,
        runScriptDb(scriptRow()).database,
      );
      expect(Object.keys(outcome).sort()).toEqual(['digest', 'kind']);
    });

    // FIX 4: `content` alone left run_as / language / timeout_seconds free to
    // change between approval and release with a byte-identical digest —
    // flipping run_as from `user` to `system` is a privilege escalation the
    // approver never saw.
    it.each([
      ['content', { content: 'echo TAMPERED' }],
      ['runAs', { runAs: 'system' }],
      ['language', { language: 'powershell' }],
      ['timeoutSeconds', { timeoutSeconds: 9000 }],
      ['orgId', { orgId: 'org-2' }],
    ])('changes the digest when %s changes', async (_field, mutation) => {
      const before = await digestFor('run_script', RUN_SCRIPT_ARGS, runScriptDb(scriptRow()).database);
      const after = await digestFor(
        'run_script',
        RUN_SCRIPT_ARGS,
        runScriptDb(scriptRow(mutation)).database,
      );
      expect(before).not.toBeNull();
      expect(before).not.toBe(after);
    });

    /**
     * #3409 PR4c-1 — the digest is now built from the VERIFIED SNAPSHOT
     * (runScriptSnapshot.ts), so it pins the parameter definitions and a
     * reference to every tenant variable the run will consult, not just the
     * five script fields above.
     *
     * The TOCTOU these close: an approved run can be rebound to a different
     * variable (parameter `variableKey` edited), or have the variable it
     * resolves rotated / shadowed by an org override / reclassified secret /
     * deleted — all with a byte-identical script body, and all previously
     * invisible to the digest.
     *
     * These go end to end through computeEffectDigestOutcome deliberately:
     * runScriptSnapshot.test.ts already proves the MATERIAL is drift-sensitive,
     * but that says nothing about whether the resolver is wired to it.
     */
    describe('tenant-variable and parameter-definition pinning', () => {
      const content = 'echo {{var.api_token}}';
      const definitions = [
        { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
      ];
      const baselineScope = (overrides: Partial<ResolvedVariable> = {}) =>
        fakeScope([
          {
            orgId: 'org-1',
            present: [variable({ key: 'api_token', variableId: 'var-a', version: 3, ...overrides })],
          },
        ]);

      // Task 3b (#3409 PR4c-1): `digestOf` records the exact `database` it
      // handed the digest entry point, so the pinning test below can assert
      // `loadScope` (== `loadTenantVariableScope`) was called with THAT SAME
      // connection reused — not a second, freshly-escaped one.
      let lastDatabase: Database;

      /** One pinning pass: the scope the loader returns + the script row on disk. */
      async function digestOf(
        scope: TenantVariableScope,
        script: Record<string, unknown> = scriptRow({ content, parameters: definitions }),
        devices: Array<{ id: string; orgId: string }> = [deviceRow('device-1', 'org-1')],
      ): Promise<string | null> {
        loadScope.mockResolvedValueOnce(scope);
        lastDatabase = runScriptDb(script, devices).database;
        return digestFor(
          'run_script',
          { scriptId: 'script-1', deviceIds: devices.map((d) => d.id) },
          lastDatabase,
        );
      }

      it('pins a digest at all for a variable-referencing script, and it is stable', async () => {
        const before = await digestOf(baselineScope());
        // Task 3b: the digest path reuses the ambient connection rather than
        // acquiring a second pooled one — `loadTenantVariableScope` is called
        // with `{ database }` (the SAME database this call was handed),
        // never bare `orgIds` alone.
        expect(loadScope).toHaveBeenCalledWith(['org-1'], { database: lastDatabase });
        const after = await digestOf(baselineScope());
        expect(before).toMatch(/^[0-9a-f]{64}$/);
        expect(before).toBe(after);
      });

      it.each<[string, () => Promise<string | null>]>([
        ['the variable version is rotated', () => digestOf(baselineScope({ version: 4 }))],
        ['isSecret is flipped false -> true', () => digestOf(baselineScope({ isSecret: true }))],
        [
          'an org override shadows a partner-wide row (same key and value, different variableId)',
          () => digestOf(baselineScope({ variableId: 'var-override' })),
        ],
        ['the variable is deleted (present -> absent)', () => digestOf(fakeScope([{ orgId: 'org-1' }]))],
        [
          'the variable can no longer be decrypted (present -> unreadable)',
          () => digestOf(fakeScope([{ orgId: 'org-1', unreadable: ['api_token'] }])),
        ],
        [
          "a parameter's variableKey is rebound to a different variable",
          () =>
            digestOf(
              baselineScope(),
              scriptRow({
                content,
                parameters: [
                  { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'other_token' },
                ],
              }),
            ),
        ],
        [
          'a parameter definition is added',
          () =>
            digestOf(
              baselineScope(),
              scriptRow({
                content,
                parameters: [...definitions, { name: 'level', type: 'string', source: 'runtime' }],
              }),
            ),
        ],
        [
          'a parameter definition is removed',
          () => digestOf(baselineScope(), scriptRow({ content, parameters: [] })),
        ],
        [
          'the targeted device moved to another org (the variable resolves elsewhere)',
          () =>
            digestOf(
              fakeScope([
                { orgId: 'org-2', present: [variable({ key: 'api_token', variableId: 'var-a', version: 3 })] },
              ]),
              scriptRow({ content, parameters: definitions }),
              [deviceRow('device-1', 'org-2')],
            ),
        ],
      ])('changes the digest when %s', async (_case, drifted) => {
        const baseline = await digestOf(baselineScope());
        expect(baseline).not.toBeNull();
        expect(baseline).not.toBe(await drifted());
      });

      // A digest pinned BEFORE this change hashed a bare five-field object.
      // The v:2 envelope guarantees the recomputed value can never coincide
      // with it, so a pre-PR4c intent fails closed (`content_changed`) at
      // release instead of silently comparing equal against a narrower pin.
      it('can never collide with a v1 (five-field) digest pinned before PR4c', async () => {
        const v1 = createHash('sha256')
          .update(
            JSON.stringify({
              orgId: 'org-1',
              language: 'bash',
              content: '#!/bin/bash\necho hi',
              timeoutSeconds: 300,
              runAs: 'user',
            }),
          )
          .digest('hex');
        const v2 = await digestFor('run_script', RUN_SCRIPT_ARGS, runScriptDb(scriptRow()).database);
        expect(v2).toMatch(/^[0-9a-f]{64}$/);
        expect(v2).not.toBe(v1);
      });

      // The overwhelming majority of scripts reference nothing, and must not
      // pay for a variable query at intent creation.
      it('loads no variable scope for a script that references none', async () => {
        const database = runScriptDb(scriptRow()).database;
        const digest = await digestFor('run_script', RUN_SCRIPT_ARGS, database);
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(loadScope).toHaveBeenCalledWith([], { database });
      });
    });
  });

  describe('manage_quotes:send', () => {
    const updatedAt = new Date('2026-08-01T00:00:00Z');

    it('hashes quote updated_at + line-item snapshot; a line edit changes the digest', async () => {
      const args = { action: 'send', quoteId: 'quote-1' };
      const before = makeFakeDb([
        [{ updatedAt }],
        [{ id: 'line-1', quantity: '1', unitPrice: '10.00', lineTotal: '10.00', sortOrder: 0 }],
      ]);
      const after = makeFakeDb([
        [{ updatedAt }], // header untouched
        [{ id: 'line-1', quantity: '2', unitPrice: '10.00', lineTotal: '20.00', sortOrder: 0 }], // qty changed
      ]);
      const digestBefore = await digestFor('manage_quotes', args, before.database);
      const digestAfter = await digestFor('manage_quotes', args, after.database);
      expect(digestBefore).not.toBeNull();
      expect(digestBefore).not.toBe(digestAfter);
    });

    it('reports target_absent when the quote does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'send', quoteId: 'ghost' }, database);
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    it('does not resolve for a different action on the same tool (e.g. update)', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome('manage_quotes', { action: 'update', quoteId: 'quote-1' }, database);
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('manage_invoices', () => {
    // `void` is classified four_eyes alongside issue/record_payment/
    // void_payment (aiGuardrails.ts) but shipped with NO resolver — the gap
    // effectDigestCoverage.contract.test.ts now makes impossible to repeat.
    it.each(['issue', 'void', 'record_payment'])('%s hashes the invoice updated_at', async (action) => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await digestFor('manage_invoices', { action, invoiceId: 'inv-1' }, database);
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('void detects a revision change between approval and release', async () => {
      const args = { action: 'void', invoiceId: 'inv-1' };
      const before = await digestFor(
        'manage_invoices',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]).database,
      );
      const after = await digestFor(
        'manage_invoices',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z') }]]).database,
      );
      expect(before).not.toBe(after);
    });

    it('void_payment resolves the owning invoice through the paymentId, then hashes its updated_at', async () => {
      const { database, select } = makeFakeDb([
        [{ invoiceId: 'inv-1' }], // invoice_payments lookup by paymentId
        [{ updatedAt: new Date('2026-08-01T00:00:00Z') }], // invoices lookup by invoiceId
      ]);
      const result = await digestFor(
        'manage_invoices',
        { action: 'void_payment', paymentId: 'pay-1' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(select).toHaveBeenCalledTimes(2);
    });

    it('void_payment reports target_absent when the payment does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome(
        'manage_invoices',
        { action: 'void_payment', paymentId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    it('returns not_applicable for a non-approval-gated action (e.g. update_header)', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome(
        'manage_invoices',
        { action: 'update_header', invoiceId: 'inv-1', patch: {} },
        database,
      );
      expect(outcome).toEqual({ kind: 'not_applicable' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('manage_contracts', () => {
    it('activate hashes the contract updated_at', async () => {
      const { database } = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const result = await digestFor(
        'manage_contracts',
        { action: 'activate', contractId: 'contract-1' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('cancel hashes the contract updated_at, differing when the contract revised', async () => {
      const before = makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z') }]]);
      const after = makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z') }]]);
      const args = { action: 'cancel', contractId: 'contract-1' };
      const digestBefore = await digestFor('manage_contracts', args, before.database);
      const digestAfter = await digestFor('manage_contracts', args, after.database);
      expect(digestBefore).not.toBe(digestAfter);
    });
  });

  describe('manage_organizations:update_org', () => {
    it('hashes the current org status', async () => {
      const { database } = makeFakeDb([[{ status: 'active' }]]);
      const result = await digestFor(
        'manage_organizations',
        { action: 'update_org', orgId: 'org-1', status: 'suspended' },
        database,
      );
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('differs when the org was suspended between creation and release', async () => {
      const active = makeFakeDb([[{ status: 'active' }]]);
      const suspended = makeFakeDb([[{ status: 'suspended' }]]);
      const args = { action: 'update_org', orgId: 'org-1' };
      const digestActive = await digestFor('manage_organizations', args, active.database);
      const digestSuspended = await digestFor('manage_organizations', args, suspended.database);
      expect(digestActive).not.toBe(digestSuspended);
    });

    it('reports target_absent when the org does not exist', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome(
        'manage_organizations',
        { action: 'update_org', orgId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('manage_policy_feature_link:update', () => {
    const linkRow = (overrides: Record<string, unknown> = {}) => ({
      featureType: 'maintenance',
      featurePolicyId: null,
      inlineSettings: { recurrence: 'weekly', durationHours: 2 },
      ...overrides,
    });
    const args = {
      action: 'update', configPolicyId: 'p1', featureLinkId: 'link-1',
      featureType: 'maintenance', inlineSettings: { durationHours: 8 },
    };

    it('pins the link content, so a re-write to the SAME values does not trip it', async () => {
      const before = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow()]]).database,
      );
      const unchanged = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow()]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).toBe(unchanged);
    });

    it('differs when the link settings were edited inside the approval window', async () => {
      const before = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow()]]).database,
      );
      const widened = await digestFor(
        'manage_policy_feature_link',
        args,
        makeFakeDb([[linkRow({ inlineSettings: { recurrence: 'weekly', durationHours: 168 } })]]).database,
      );
      expect(before).not.toBe(widened);
    });

    it('differs when the link was retargeted to a different featureType', async () => {
      const asMaintenance = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow()]]).database,
      );
      const asMonitoring = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow({ featureType: 'monitoring' })]]).database,
      );
      expect(asMaintenance).not.toBe(asMonitoring);
    });

    it('differs when the linked feature policy was swapped', async () => {
      const unlinked = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow()]]).database,
      );
      const linked = await digestFor(
        'manage_policy_feature_link', args, makeFakeDb([[linkRow({ featurePolicyId: 'fp-9' })]]).database,
      );
      expect(unlinked).not.toBe(linked);
    });

    it('reports missing_arg without a featureLinkId, without querying', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome(
        'manage_policy_feature_link',
        { action: 'update', configPolicyId: 'p1', featureType: 'maintenance' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });

    it('reports target_absent when the link no longer exists', async () => {
      const { database } = makeFakeDb([[]]);
      const outcome = await computeEffectDigestOutcome(
        'manage_policy_feature_link',
        { ...args, featureLinkId: 'ghost' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });

    it('add is NOT pinned — it creates the row, so there is nothing to hash', () => {
      expect(effectDigestResolverKey('manage_policy_feature_link', 'add')).toBeNull();
      expect(effectDigestResolverKey('manage_policy_feature_link', 'update'))
        .toBe('manage_policy_feature_link:update');
    });
  });

  describe('manage_tickets:move_org', () => {
    it('pins the ticket org + status, not updated_at (comment churn must not trip it)', async () => {
      const args = { action: 'move_org', ticketId: 'ticket-1', targetOrgId: 'org-2' };
      const before = await digestFor(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-1', status: 'open' }]]).database,
      );
      const sameAfterAComment = await digestFor(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-1', status: 'open' }]]).database,
      );
      const afterSomeoneElseMovedIt = await digestFor(
        'manage_tickets',
        args,
        makeFakeDb([[{ orgId: 'org-9', status: 'open' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).toBe(sameAfterAComment);
      expect(before).not.toBe(afterSomeoneElseMovedIt);
    });

    it('reports missing_arg without a ticketId', async () => {
      const { database, select } = makeFakeDb([]);
      const outcome = await computeEffectDigestOutcome(
        'manage_tickets',
        { action: 'move_org', targetOrgId: 'org-2' },
        database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('execute_dr_plan', () => {
    it('pins the plan revision — a plan edited between approval and release changes the digest', async () => {
      const args = { planId: 'plan-1', executionType: 'failover' };
      const before = await digestFor(
        'execute_dr_plan',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-01T00:00:00Z'), status: 'active' }]]).database,
      );
      const after = await digestFor(
        'execute_dr_plan',
        args,
        makeFakeDb([[{ updatedAt: new Date('2026-08-02T00:00:00Z'), status: 'active' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).not.toBe(after);
    });

    it('reports target_absent for a deleted plan', async () => {
      const outcome = await computeEffectDigestOutcome(
        'execute_dr_plan',
        { planId: 'ghost', executionType: 'rehearsal' },
        makeFakeDb([[]]).database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'target_absent' });
    });
  });

  describe('delete_tenant', () => {
    // The arg really is snake_case here (aiToolsOrgs.ts) — the resolver map
    // keys on the tool's actual spelling, not a normalized one.
    it('pins the partner name + status via the snake_case tenant_id arg', async () => {
      const args = { tenant_id: 'partner-1', confirmation_phrase: 'delete Acme permanently' };
      const before = await digestFor(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme', status: 'active' }]]).database,
      );
      const afterRename = await digestFor(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme Holdings', status: 'active' }]]).database,
      );
      const afterChurn = await digestFor(
        'delete_tenant',
        args,
        makeFakeDb([[{ name: 'Acme', status: 'churned' }]]).database,
      );
      expect(before).toMatch(/^[0-9a-f]{64}$/);
      expect(before).not.toBe(afterRename);
      expect(before).not.toBe(afterChurn);
    });

    it('reports missing_arg when tenant_id is absent (e.g. a camelCase typo)', async () => {
      const outcome = await computeEffectDigestOutcome(
        'delete_tenant',
        { tenantId: 'partner-1' },
        makeFakeDb([]).database,
      );
      expect(outcome).toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    });
  });
});

describe('computeEffectDigestForRelease (the shape both release paths consume)', () => {
  it('flattens BOTH unpinnable outcomes to null, which is what the stored column can express', async () => {
    expect(await digestFor('list_scripts', {}, makeFakeDb([]).database)).toBeNull();
    expect(await digestFor('run_script', {}, makeFakeDb([]).database)).toBeNull();
    // A genuine target_absent (not another missing_arg): well-formed args, no
    // script row. Both reasons still flatten to the same stored NULL.
    expect(
      await digestFor('run_script', { ...RUN_SCRIPT_ARGS, scriptId: 'ghost' }, runScriptDb(null).database),
    ).toBeNull();
  });

  it('returns the digest itself on pinned', async () => {
    const result = await digestFor('run_script', RUN_SCRIPT_ARGS, runScriptDb(scriptRow()).database);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  // The half the flattening `digestFor` above throws away: a release path also
  // gets the material it can EXECUTE from, so the handler need not re-read
  // what the digest just proved unchanged.
  it('carries the verified run_script material alongside the digest', async () => {
    const script = scriptRow();
    const scope = fakeScope([{ orgId: 'org-1' }]);
    loadScope.mockResolvedValueOnce(scope);
    const result = await computeEffectDigestForRelease(
      'run_script',
      RUN_SCRIPT_ARGS,
      runScriptDb(script).database,
    );
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    // The SAME observation the digest was computed over — same row object,
    // same scope object, not a re-read.
    expect(result.context?.verifiedRunScript?.scriptRow).toBe(script);
    expect(result.context?.verifiedRunScript?.scope).toBe(scope);
    expect(result.context?.verifiedRunScript?.snapshot.script.id).toBe('script-1');
  });

  it('omits the context for a resolver that produced nothing reusable', async () => {
    const pinnedButUnreusable = await computeEffectDigestForRelease(
      'manage_organizations',
      { action: 'update_org', orgId: 'org-1' },
      makeFakeDb([[{ status: 'active' }]]).database,
    );
    expect(pinnedButUnreusable.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedButUnreusable.context).toBeUndefined();

    // Unpinnable surfaces carry no context either.
    const notApplicable = await computeEffectDigestForRelease('list_scripts', {}, makeFakeDb([]).database);
    expect(notApplicable).toEqual({ digest: null });
  });
});

describe('effectDigestResolverKey', () => {
  it('prefers the tool:action key over the whole-tool key', () => {
    expect(effectDigestResolverKey('manage_invoices', 'void')).toBe('manage_invoices:void');
  });

  it('falls back to the whole-tool key when the action has no pair entry', () => {
    expect(effectDigestResolverKey('run_script', undefined)).toBe('run_script');
    expect(effectDigestResolverKey('run_script', 'anything')).toBe('run_script');
  });

  it('returns null for an unpinnable surface', () => {
    expect(effectDigestResolverKey('google_suspend_user')).toBeNull();
    expect(effectDigestResolverKey('manage_invoices', 'update_header')).toBeNull();
  });
});

describe('hasPinnedDigest', () => {
  // The two release call sites used to disagree on `undefined`:
  // intentReleaseWorker tested `!== null` (fails CLOSED with a spurious
  // content_changed), aiAgentSdk tested truthiness (fails OPEN, skipping the
  // check). One predicate, one answer.
  it.each([
    [{ effectDigest: 'a'.repeat(64) }, true],
    [{ effectDigest: 'x' }, true],
    [{ effectDigest: null }, false],
    [{ effectDigest: undefined }, false],
    [{}, false],
    [{ effectDigest: '' }, false],
  ])('%j → %s', (intent, expected) => {
    expect(hasPinnedDigest(intent as { effectDigest?: string | null })).toBe(expected);
  });
});
