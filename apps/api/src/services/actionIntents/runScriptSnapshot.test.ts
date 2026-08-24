import { describe, expect, it, vi } from 'vitest';
import { canonicalizeScriptParameterDefinitions } from '@breeze/shared';
import type { Database } from '../../db';
import { resolveForOrg, type ResolvedVariable, type TenantVariableScope } from '../tenantVariableResolution';
import {
  buildRunScriptSnapshot,
  runScriptDigestMaterial,
  type RunScriptSnapshot,
} from './runScriptSnapshot';

/**
 * Harness copied from `effectDigest.test.ts` — same hand-rolled chainable
 * stub, same "each awaited chain shifts the next array off `queue`"
 * contract, and deliberately NO `vi.mock` of the db module (this suite, like
 * that one, proves the builder works against whatever `Database` it is
 * handed).
 *
 * One addition: `then`. The script lookup here ends in `.limit(1)` like every
 * resolver in that file, but the device -> org lookup is awaited on
 * `.where(...)` directly — `inArray` already bounds the row count, so a
 * `.limit()` there would be decoration added purely to satisfy a stub. Making
 * the chain itself thenable keeps the queue semantics identical.
 *
 * Queue order for a full build: [script rows, device rows].
 */
function makeFakeDb(queue: unknown[][]): {
  database: Database;
  select: ReturnType<typeof vi.fn>;
  wheres: unknown[];
} {
  const wheres: unknown[] = [];
  const take = async () => queue.shift() ?? [];
  const chain = {
    limit: vi.fn(take),
    orderBy: vi.fn(take),
    then: (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
      take().then(resolve, reject),
  };
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((condition: unknown) => {
        wheres.push(condition);
        return chain;
      }),
    })),
  }));
  return { database: { select } as unknown as Database, select, wheres };
}

/** A `scripts` row as the snapshot builder selects it. */
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

const variable = (overrides: Partial<ResolvedVariable> & { key: string }): ResolvedVariable => ({
  value: 'ordinary-value',
  isSecret: false,
  variableId: 'var-1',
  version: 1,
  ownerScope: 'organization',
  ...overrides,
});

/**
 * A `TenantVariableScope` carrier built by hand.
 *
 * `loadTenantVariableScope` is the only sanctioned constructor and it reads
 * the module-level `db`, which this suite cannot reach without mocking the db
 * module. So the builder takes a `loadScope` seam (same rationale as
 * `effectDigest.ts`'s injected `database`) and these tests hand back a carrier
 * carrying the three fields `InternalTenantVariableScope` documents.
 *
 * Only the DATA is faked: the production `resolveForOrg` / `unreadableForOrg`
 * accessors still run over this object, so their membership check and copy-out
 * semantics are exercised for real. If that internal shape were ever renamed,
 * those accessors would return empty and these tests go red — never silently
 * green.
 */
interface FakeOrgScope {
  orgId: string;
  present?: ResolvedVariable[];
  unreadable?: string[];
}
function fakeScope(orgs: FakeOrgScope[]): TenantVariableScope {
  return {
    orgIds: new Set(orgs.map((o) => o.orgId)),
    byOrg: new Map(orgs.map((o) => [o.orgId, new Map((o.present ?? []).map((v) => [v.key, v]))])),
    unreadableKeysByOrg: new Map(orgs.map((o) => [o.orgId, new Set(o.unreadable ?? [])])),
  } as unknown as TenantVariableScope;
}

interface BuildOptions {
  args?: Record<string, unknown>;
  /** `null` = the script lookup returns no row. */
  script?: Record<string, unknown> | null;
  devices?: Array<{ id: string; orgId: string }>;
  scope?: TenantVariableScope;
}

function build(options: BuildOptions = {}) {
  const script = options.script === undefined ? scriptRow() : options.script;
  const devices = options.devices ?? [deviceRow('device-1', 'org-1')];
  const args = options.args ?? {
    scriptId: 'script-1',
    deviceIds: devices.map((d) => d.id),
  };
  const scope =
    options.scope ?? fakeScope([...new Set(devices.map((d) => d.orgId))].map((orgId) => ({ orgId })));
  const loadScope = vi.fn(async () => scope);
  const fake = makeFakeDb([script === null ? [] : [script], devices]);
  return {
    ...fake,
    loadScope,
    result: buildRunScriptSnapshot(args, fake.database, { loadScope }),
  };
}

/** The `{ snapshot, scope }` pair, asserted to have resolved. */
async function builtOf(options: BuildOptions = {}): Promise<{ snapshot: RunScriptSnapshot; scope: TenantVariableScope }> {
  const outcome = await build(options).result;
  if (outcome.kind !== 'snapshot') throw new Error(`expected a snapshot, got ${outcome.kind}`);
  return { snapshot: outcome.snapshot, scope: outcome.scope };
}

async function snapshotOf(options: BuildOptions = {}): Promise<RunScriptSnapshot> {
  return (await builtOf(options)).snapshot;
}

const materialOf = async (options: BuildOptions = {}) => runScriptDigestMaterial(await snapshotOf(options));

/** Every column name mentioned anywhere in a Drizzle condition tree. */
function columnNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) columnNames(entry, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (typeof record.name === 'string' && typeof record.table === 'object') out.push(record.name);
  if (Array.isArray(record.queryChunks)) columnNames(record.queryChunks, out);
  return out;
}

describe('runScriptDigestMaterial', () => {
  // THE test. `effect_digest` is a widely-readable column; its INPUT must
  // never be reconstructible into a tenant variable's plaintext. A reference
  // pins identity (variableId + version + isSecret), never value.
  it('never puts a resolved variable VALUE in the material', async () => {
    const plaintext = 'sup3r-secret-plaintext-do-not-pin';
    const { snapshot, scope } = await builtOf({
      script: scriptRow({ content: 'echo {{var.api_token}}' }),
      scope: fakeScope([
        {
          orgId: 'org-1',
          present: [variable({ key: 'api_token', value: plaintext, variableId: 'var-9', version: 7, isSecret: true })],
        },
      ]),
    });

    const material = runScriptDigestMaterial(snapshot);
    expect(material).not.toContain(plaintext);
    // The SIBLING scope DOES hold that plaintext — so the assertion above is
    // about what the material selects, not about a value that was never in
    // reach. The scope is deliberately not a field of the snapshot: the
    // snapshot is pure digest material, so `JSON.stringify(snapshot)` anywhere
    // is structurally incapable of leaking a value.
    expect(resolveForOrg(scope, 'org-1').get('api_token')?.value).toBe(plaintext);
    expect(JSON.stringify(snapshot)).not.toContain(plaintext);
    // ...and the reference itself carries identity only.
    expect(snapshot.variableReferences).toEqual([
      {
        orgId: 'org-1',
        key: 'api_token',
        state: 'present',
        variableId: 'var-9',
        version: 7,
        isSecret: true,
        ownerScope: 'organization',
      },
    ]);
    expect(material).toContain('var-9');
  });

  it('pins the five script fields, the canonical parameter definitions and the sorted references', async () => {
    const definitions = [
      { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
    ];
    const snapshot = await snapshotOf({
      script: scriptRow({ content: 'echo {{var.region}}', parameters: definitions }),
      scope: fakeScope([
        {
          orgId: 'org-1',
          present: [
            variable({ key: 'api_token', variableId: 'var-a', version: 3, isSecret: true }),
            variable({ key: 'region', variableId: 'var-b', version: 1, ownerScope: 'partner' }),
          ],
        },
      ]),
    });

    expect(JSON.parse(runScriptDigestMaterial(snapshot))).toEqual({
      v: 2,
      script: {
        orgId: 'org-1',
        language: 'bash',
        content: 'echo {{var.region}}',
        timeoutSeconds: 300,
        runAs: 'user',
      },
      parameterDefinitions: canonicalizeScriptParameterDefinitions(definitions),
      deviceOrgIds: ['org-1'],
      variableReferences: [
        {
          orgId: 'org-1',
          key: 'api_token',
          state: 'present',
          variableId: 'var-a',
          version: 3,
          isSecret: true,
          ownerScope: 'organization',
        },
        {
          orgId: 'org-1',
          key: 'region',
          state: 'present',
          variableId: 'var-b',
          version: 1,
          isSecret: false,
          ownerScope: 'partner',
        },
      ],
    });
  });

  it('is a v:2 envelope that can never collide with the v1 five-field material', async () => {
    const snapshot = await snapshotOf();
    const v1 = JSON.stringify({
      orgId: 'org-1',
      language: 'bash',
      content: '#!/bin/bash\necho hi',
      timeoutSeconds: 300,
      runAs: 'user',
    });
    expect(runScriptDigestMaterial(snapshot)).not.toBe(v1);
    expect(JSON.parse(runScriptDigestMaterial(snapshot)).v).toBe(2);
  });
});

describe('runScriptDigestMaterial determinism', () => {
  it('ignores device id order', async () => {
    const a = await materialOf({
      devices: [deviceRow('device-1', 'org-b'), deviceRow('device-2', 'org-a')],
    });
    const b = await materialOf({
      devices: [deviceRow('device-2', 'org-a'), deviceRow('device-1', 'org-b')],
    });
    expect(a).toBe(b);
  });

  it('ignores the order variables were inserted into the scope', async () => {
    const content = 'echo {{var.alpha}} {{var.beta}}';
    const alpha = variable({ key: 'alpha', variableId: 'var-alpha' });
    const beta = variable({ key: 'beta', variableId: 'var-beta' });
    const a = await materialOf({
      script: scriptRow({ content }),
      scope: fakeScope([{ orgId: 'org-1', present: [alpha, beta] }]),
    });
    const b = await materialOf({
      script: scriptRow({ content }),
      scope: fakeScope([{ orgId: 'org-1', present: [beta, alpha] }]),
    });
    expect(a).toBe(b);
  });

  it('ignores parameter-definition object key order', async () => {
    const a = await materialOf({
      script: scriptRow({ parameters: [{ name: 'level', type: 'string', source: 'runtime', required: true }] }),
    });
    const b = await materialOf({
      script: scriptRow({ parameters: [{ required: true, source: 'runtime', type: 'string', name: 'level' }] }),
    });
    expect(a).toBe(b);
  });

  // Sorting is by UTF-16 code point, never `localeCompare` — the digest must
  // be byte-reproducible regardless of the runtime's ICU data and locale.
  it('sorts keys and org ids by code point, not by locale', async () => {
    // Guard: this pair really does discriminate the two comparators.
    expect('a_b'.localeCompare('a1b')).toBeLessThan(0);
    expect('a_b' > 'a1b').toBe(true);
    expect('org_2'.localeCompare('org1')).toBeLessThan(0);
    expect('org_2' > 'org1').toBe(true);

    const snapshot = await snapshotOf({
      script: scriptRow({ content: 'echo {{var.a_b}} {{var.a1b}}' }),
      devices: [deviceRow('device-1', 'org_2'), deviceRow('device-2', 'org1')],
      scope: fakeScope([{ orgId: 'org_2' }, { orgId: 'org1' }]),
    });

    expect(snapshot.deviceOrgIds).toEqual(['org1', 'org_2']);
    expect(snapshot.variableReferences.map((r) => `${r.orgId}/${r.key}`)).toEqual([
      'org1/a1b',
      'org1/a_b',
      'org_2/a1b',
      'org_2/a_b',
    ]);
  });
});

describe('runScriptDigestMaterial drift sensitivity', () => {
  const content = 'echo {{var.api_token}}';
  const definitions = [
    { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_token' },
  ];
  const baseline = (overrides: Partial<ResolvedVariable> = {}) => ({
    script: scriptRow({ content, parameters: definitions }),
    scope: fakeScope([
      { orgId: 'org-1', present: [variable({ key: 'api_token', variableId: 'var-a', version: 3, ...overrides })] },
    ]),
  });

  it.each<[string, BuildOptions]>([
    ['the variable version is bumped', baseline({ version: 4 })],
    ['isSecret flips false -> true', baseline({ isSecret: true })],
    [
      'the variable id changes (an org override shadows a partner-wide row of the same key and value)',
      {
        script: scriptRow({ content, parameters: definitions }),
        scope: fakeScope([
          {
            orgId: 'org-1',
            present: [
              variable({ key: 'api_token', variableId: 'var-override', version: 3, ownerScope: 'organization' }),
            ],
          },
        ]),
      },
    ],
    [
      'a reference goes present -> absent',
      { script: scriptRow({ content, parameters: definitions }), scope: fakeScope([{ orgId: 'org-1' }]) },
    ],
    [
      'a reference goes present -> unreadable',
      {
        script: scriptRow({ content, parameters: definitions }),
        scope: fakeScope([{ orgId: 'org-1', unreadable: ['api_token'] }]),
      },
    ],
    [
      "a parameter definition's variableKey is rebound",
      {
        script: scriptRow({
          content,
          parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'other_token' }],
        }),
        scope: fakeScope([
          { orgId: 'org-1', present: [variable({ key: 'api_token', variableId: 'var-a', version: 3 })] },
        ]),
      },
    ],
    [
      'a parameter definition is added',
      {
        script: scriptRow({
          content,
          parameters: [...definitions, { name: 'level', type: 'string', source: 'runtime' }],
        }),
        scope: fakeScope([
          { orgId: 'org-1', present: [variable({ key: 'api_token', variableId: 'var-a', version: 3 })] },
        ]),
      },
    ],
    [
      'a parameter definition is removed',
      {
        script: scriptRow({ content, parameters: [] }),
        scope: fakeScope([
          { orgId: 'org-1', present: [variable({ key: 'api_token', variableId: 'var-a', version: 3 })] },
        ]),
      },
    ],
  ])('changes the material when %s', async (_case, drifted) => {
    expect(await materialOf(baseline())).not.toBe(await materialOf(drifted));
  });

  // The opposite direction is not symmetric-by-construction: a boolean can be
  // dropped from the material entirely when false and the true -> false case
  // would still look like a change while false -> true silently didn't.
  it('changes the material when isSecret flips true -> false', async () => {
    const secret = await materialOf(baseline({ isSecret: true }));
    const notSecret = await materialOf(baseline({ isSecret: false }));
    expect(secret).not.toBe(notSecret);
  });
});

describe('buildRunScriptSnapshot variable references', () => {
  // #3409 PR4c-2: the declared-delivery arm is a reference like any other.
  // The snapshot pins the secret's IDENTITY so a rotation between approval and
  // release is detected, and the digest material must never carry its value.
  it('pins a tenantSecret-bound parameter by identity and keeps its value out of the material', async () => {
    const plaintext = 'hunter2-super-secret-value';
    const built = await builtOf({
      script: scriptRow({
        content: 'echo "$BREEZE_VAR_TOKEN"',
        parameters: [{ name: 'token', type: 'string', source: 'tenantSecret', variableKey: 'api_token' }],
      }),
      scope: fakeScope([
        {
          orgId: 'org-1',
          present: [variable({ key: 'api_token', value: plaintext, variableId: 'var-s', version: 4, isSecret: true })],
        },
      ]),
    });
    expect(built.snapshot.variableReferences).toEqual([
      {
        orgId: 'org-1',
        key: 'api_token',
        state: 'present',
        variableId: 'var-s',
        version: 4,
        isSecret: true,
        ownerScope: 'organization',
      },
    ]);
    expect(runScriptDigestMaterial(built.snapshot)).not.toContain(plaintext);
    expect(JSON.stringify(built.snapshot)).not.toContain(plaintext);
  });

  it('references the union of content tokens and parameter variableKeys', async () => {
    const snapshot = await snapshotOf({
      script: scriptRow({
        content: 'echo {{var.from_content}}',
        parameters: [{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 'from_param' }],
      }),
      scope: fakeScope([{ orgId: 'org-1' }]),
    });
    expect(snapshot.variableReferences.map((r) => r.key)).toEqual(['from_content', 'from_param']);
  });

  // Task 3b (#3409 PR4c-1): the non-empty (`needsScope: true`) path is the
  // one that matters in production — this is the call that would otherwise
  // acquire a second pooled connection. Assert the SAME `database` the
  // builder was handed is the one forwarded to `loadScope`, not merely that
  // some database-shaped value was.
  it('forwards its own database argument to loadScope on the needs-scope path', async () => {
    const built = build({
      script: scriptRow({ content: 'echo {{var.k}}' }),
      scope: fakeScope([{ orgId: 'org-1', present: [variable({ key: 'k' })] }]),
    });
    await built.result;
    expect(built.loadScope).toHaveBeenCalledWith(['org-1'], built.database);
  });

  it('produces no references and loads no variable scope for a script with neither', async () => {
    const built = build({ script: scriptRow({ content: 'echo hi', parameters: [] }) });
    const outcome = await built.result;
    expect(outcome.kind).toBe('snapshot');
    expect(outcome.kind === 'snapshot' && outcome.snapshot.variableReferences).toEqual([]);
    // Task 3b (#3409 PR4c-1): `loadScope` now also receives the caller's
    // `database` (so it can reuse the already-held connection instead of
    // escaping to a second one) — asserted here rather than just "was
    // called", so a regression that drops the second argument goes red.
    expect(built.loadScope).toHaveBeenCalledWith([], built.database);
  });

  it('emits one reference per (org, key) — the same key resolving differently in two orgs', async () => {
    const snapshot = await snapshotOf({
      script: scriptRow({ content: 'echo {{var.api_token}}' }),
      devices: [deviceRow('device-1', 'org-a'), deviceRow('device-2', 'org-b')],
      scope: fakeScope([
        { orgId: 'org-a', present: [variable({ key: 'api_token', variableId: 'var-a', version: 1 })] },
        {
          orgId: 'org-b',
          present: [variable({ key: 'api_token', variableId: 'var-b', version: 5, ownerScope: 'partner' })],
        },
      ]),
    });

    expect(snapshot.variableReferences).toEqual([
      { orgId: 'org-a', key: 'api_token', state: 'present', variableId: 'var-a', version: 1, isSecret: false, ownerScope: 'organization' },
      { orgId: 'org-b', key: 'api_token', state: 'present', variableId: 'var-b', version: 5, isSecret: false, ownerScope: 'partner' },
    ]);
  });

  it('marks an absent key absent and an undecryptable key unreadable, per org', async () => {
    const snapshot = await snapshotOf({
      script: scriptRow({ content: 'echo {{var.api_token}}' }),
      devices: [deviceRow('device-1', 'org-a'), deviceRow('device-2', 'org-b')],
      scope: fakeScope([{ orgId: 'org-a' }, { orgId: 'org-b', unreadable: ['api_token'] }]),
    });
    expect(snapshot.variableReferences).toEqual([
      { orgId: 'org-a', key: 'api_token', state: 'absent' },
      { orgId: 'org-b', key: 'api_token', state: 'unreadable' },
    ]);
  });
});

describe('buildRunScriptSnapshot resolution outcomes', () => {
  it('returns missing_arg when scriptId is absent or not a string', async () => {
    const absent = build({ args: { deviceIds: ['device-1'] } });
    expect((await absent.result).kind).toBe('missing_arg');
    expect(absent.select).not.toHaveBeenCalled();

    const wrongType = build({ args: { scriptId: 42, deviceIds: ['device-1'] } });
    expect((await wrongType.result).kind).toBe('missing_arg');
    expect(wrongType.select).not.toHaveBeenCalled();
  });

  // JUDGEMENT CALL (brief Step 1): `deviceIds` is `required` in run_script's
  // tool schema (aiToolsScripts.ts), so a call without it is a malformed
  // argument, not a resolvable target — same class as a missing scriptId.
  it.each([
    ['absent', {}],
    ['an empty array', { deviceIds: [] }],
    ['not an array', { deviceIds: 'device-1' }],
    ['an array with a non-string element', { deviceIds: ['device-1', 7] }],
  ])('returns missing_arg when deviceIds is %s', async (_case, deviceArgs) => {
    const built = build({ args: { scriptId: 'script-1', ...deviceArgs } });
    expect((await built.result).kind).toBe('missing_arg');
    expect(built.select).not.toHaveBeenCalled();
  });

  it('returns target_absent for a script that does not exist, filtering soft-deleted rows', async () => {
    const built = build({ script: null });
    expect((await built.result).kind).toBe('target_absent');
    // Non-vacuous: the lookup really does constrain on scripts.deleted_at.
    expect(columnNames(built.wheres[0])).toEqual(expect.arrayContaining(['id', 'deleted_at']));
  });

  // Fail closed: silently dropping an unresolvable device would shrink the
  // reference set (fewer orgs => fewer pinned references) and let the digest
  // match while the approved fan-out no longer does.
  it('returns target_absent when a device id does not resolve to an org', async () => {
    const built = build({
      args: { scriptId: 'script-1', deviceIds: ['device-1', 'ghost'] },
      devices: [deviceRow('device-1', 'org-1')],
    });
    expect((await built.result).kind).toBe('target_absent');
  });

  it('deduplicates repeated device ids rather than calling them unresolvable', async () => {
    const built = build({
      args: { scriptId: 'script-1', deviceIds: ['device-1', 'device-1'] },
      devices: [deviceRow('device-1', 'org-1')],
    });
    const outcome = await built.result;
    expect(outcome.kind).toBe('snapshot');
    expect(outcome.kind === 'snapshot' && outcome.snapshot.deviceOrgIds).toEqual(['org-1']);
  });
});
