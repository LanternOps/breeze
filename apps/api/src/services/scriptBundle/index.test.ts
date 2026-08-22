import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_PARTNER_ID = 'abababab-abab-4bab-8bab-abababababab';
const SCRIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TAG_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

// ---------------------------------------------------------------------------
// db mock: queue-driven chains. Each db.select() consumes the next entry of
// selectQueue when awaited; inserts/updates are captured with their table.
// The REAL Drizzle schema is used (pure table definitions, no connection).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    selectQueue: [] as unknown[][],
    selectWheres: [] as unknown[],
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    updates: [] as Array<{ table: unknown; values: unknown }>
  };
  function chain(get: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'limit', 'orderBy', 'offset', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
    c.where = (cond: unknown) => {
      state.selectWheres.push(cond);
      return c;
    };
    (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(get).then(res, rej);
    return c;
  }
  return { state, chain };
});

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => h.chain(() => h.state.selectQueue.shift() ?? [])),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        h.state.inserts.push({ table, values });
        const rows = Array.isArray(values)
          ? (values as Record<string, unknown>[]).map((v, i) => ({ id: `generated-${h.state.inserts.length}-${i}`, ...v }))
          : [{ id: `generated-${h.state.inserts.length}`, ...(values as Record<string, unknown>) }];
        const p = Promise.resolve(rows) as Promise<unknown> & { returning?: unknown };
        p.returning = () => Promise.resolve(rows);
        return p;
      })
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        h.state.updates.push({ table, values });
        return { where: vi.fn(() => Promise.resolve()) };
      })
    }))
  },
  // tenantVariableResolution.ts (#3409 PR2, used by findSecretVariableReferences)
  // requires both wrappers around its query; pass-throughs here mirror
  // routes/scripts.test.ts and tenantVariableResolution.test.ts.
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => fn()
}));

import { scripts, scriptTags, scriptToTags, scriptVersions } from '../../db/schema';
import { exportBundle, importBundle, previewBundle, type BundleAuth } from './index';
import {
  scriptBundleSchema,
  MAX_BUNDLE_SCRIPTS,
  MAX_BUNDLE_CONTENT_LENGTH
} from './schema';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { MAX_SECRET_ENV_ENTRIES } from '../scriptSecretEnvelope';
import { MAX_SECRET_SCRIPT_PARAMETERS } from '@breeze/shared';

function makeAuth(overrides: Partial<BundleAuth> = {}): BundleAuth {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    partnerOrgAccess: undefined,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    user: { id: 'user-123', email: 'test@example.com' } as BundleAuth['user'],
    ...overrides
  } as BundleAuth;
}

function validBundle(entries: Array<Record<string, unknown>>) {
  return scriptBundleSchema.parse({ bundleVersion: 1, scripts: entries });
}

const baseEntry = {
  name: 'Clear print spooler',
  osTypes: ['windows'],
  language: 'powershell',
  content: 'Restart-Service Spooler'
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selectQueue = [];
  h.state.selectWheres = [];
  h.state.inserts = [];
  h.state.updates = [];
});

/**
 * Recursively walk a Drizzle SQL condition tree looking for a column named
 * `columnName` (used to prove a WHERE clause filters on it). Handles the
 * circular table<->column references with a seen-set.
 */
function conditionMentionsColumn(cond: unknown, columnName: string, seen = new Set<object>()): boolean {
  if (!cond || typeof cond !== 'object') return false;
  const obj = cond as Record<string, unknown>;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (obj.name === columnName && 'table' in obj) return true;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      if (value.some((v) => conditionMentionsColumn(v, columnName, seen))) return true;
    } else if (value && typeof value === 'object' && !('columns' in (value as object) && seen.has(value as object))) {
      if (conditionMentionsColumn(value, columnName, seen)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Schema (intake hardening — Task 4)
// ---------------------------------------------------------------------------
describe('scriptBundleSchema', () => {
  it('rejects an unknown bundleVersion instead of best-effort parsing', () => {
    const result = scriptBundleSchema.safeParse({ bundleVersion: 2, scripts: [baseEntry] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('Unsupported bundleVersion');
  });

  it('strips isSystem, id, orgId, partnerId and createdBy from entries', () => {
    const parsed = scriptBundleSchema.parse({
      bundleVersion: 1,
      scripts: [
        {
          ...baseEntry,
          isSystem: true,
          id: SCRIPT_ID,
          orgId: OTHER_ORG_ID,
          partnerId: OTHER_PARTNER_ID,
          createdBy: 'attacker'
        }
      ]
    });
    const entry = parsed.scripts[0] as Record<string, unknown>;
    expect(entry).not.toHaveProperty('isSystem');
    expect(entry).not.toHaveProperty('id');
    expect(entry).not.toHaveProperty('orgId');
    expect(entry).not.toHaveProperty('partnerId');
    expect(entry).not.toHaveProperty('createdBy');
  });

  it('applies defaults: timeoutSeconds 300, runAs system', () => {
    const parsed = scriptBundleSchema.parse({ bundleVersion: 1, scripts: [baseEntry] });
    expect(parsed.scripts[0]!.timeoutSeconds).toBe(300);
    expect(parsed.scripts[0]!.runAs).toBe('system');
  });

  it('rejects oversized parameters at intake', () => {
    const result = scriptBundleSchema.safeParse({
      bundleVersion: 1,
      scripts: [{ ...baseEntry, parameters: { blob: 'x'.repeat(65 * 1024) } }]
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('parameters too large');
  });

  it('rejects deeply nested parameters at intake', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 12; i++) nested = { inner: nested };
    const result = scriptBundleSchema.safeParse({
      bundleVersion: 1,
      scripts: [{ ...baseEntry, parameters: nested }]
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('nested too deeply');
  });

  it('rejects an exitCodeSeverityMapping that maps every exit code to null', () => {
    const result = scriptBundleSchema.safeParse({
      bundleVersion: 1,
      scripts: [{ ...baseEntry, exitCodeSeverityMapping: { '0': null, '1': null } }]
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('never alert');
  });

  it('accepts a mapping with at least one real severity', () => {
    const result = scriptBundleSchema.safeParse({
      bundleVersion: 1,
      scripts: [{ ...baseEntry, exitCodeSeverityMapping: { '0': null, '1': 'high' } }]
    });
    expect(result.success).toBe(true);
  });

  it('enforces content and bundle-size caps', () => {
    expect(
      scriptBundleSchema.safeParse({
        bundleVersion: 1,
        scripts: [{ ...baseEntry, content: 'x'.repeat(MAX_BUNDLE_CONTENT_LENGTH + 1) }]
      }).success
    ).toBe(false);
    expect(
      scriptBundleSchema.safeParse({
        bundleVersion: 1,
        scripts: Array.from({ length: MAX_BUNDLE_SCRIPTS + 1 }, () => ({ ...baseEntry }))
      }).success
    ).toBe(false);
    expect(scriptBundleSchema.safeParse({ bundleVersion: 1, scripts: [] }).success).toBe(false);
  });

  it('enforces the same timeout bounds as createScriptSchema', () => {
    expect(
      scriptBundleSchema.safeParse({
        bundleVersion: 1,
        scripts: [{ ...baseEntry, timeoutSeconds: 99999 }]
      }).success
    ).toBe(false);
    expect(
      scriptBundleSchema.safeParse({ bundleVersion: 1, scripts: [{ ...baseEntry, osTypes: [] }] })
        .success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importBundle
// ---------------------------------------------------------------------------
describe('importBundle', () => {
  it('never writes isSystem: true — even when the caller is system scope and the raw bundle asked for it', async () => {
    // RAW (attacker-supplied) envelope, not pre-parsed: the service's own
    // per-entry validation must strip isSystem + foreign tenancy.
    const bundle = {
      bundleVersion: 1 as const,
      scripts: [{ ...baseEntry, isSystem: true, orgId: OTHER_ORG_ID, partnerId: OTHER_PARTNER_ID }]
    };
    const auth = makeAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null });

    h.state.selectQueue.push([]); // findExistingByName → none
    const result = await importBundle(auth, bundle, {
      mode: 'skip',
      availability: 'org',
      orgId: ORG_ID
    });

    expect('error' in result).toBe(false);
    const scriptInsert = h.state.inserts.find((i) => i.table === scripts);
    expect(scriptInsert).toBeDefined();
    const values = scriptInsert!.values as Record<string, unknown>;
    expect(values.isSystem).toBe(false);
    expect(values.orgId).toBe(ORG_ID); // caller-resolved, not the bundle's foreign org
    expect(values.partnerId).toBeNull(); // system scope carries no partner
    expect(values.createdBy).toBe('user-123');
  });

  it('lands scripts in the caller scope, ignoring tenancy in the bundle (org caller)', async () => {
    const bundle = validBundle([{ ...baseEntry, orgId: OTHER_ORG_ID }]);
    h.state.selectQueue.push([]); // no name conflict
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });

    expect('error' in result).toBe(false);
    const values = h.state.inserts.find((i) => i.table === scripts)!.values as Record<string, unknown>;
    expect(values.orgId).toBe(ORG_ID);
    expect(values.partnerId).toBe(PARTNER_ID);
    if ('imported' in result) expect(result.imported).toBe(1);
  });

  it("denies availability 'partner' for a partner caller without the partner-wide capability (service chokepoint)", async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'selected',
      accessibleOrgIds: [ORG_ID]
    });
    const result = await importBundle(auth, validBundle([baseEntry]), {
      mode: 'skip',
      availability: 'partner'
    });
    expect(result).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("creates partner-wide rows (org_id NULL, partner_id set) for a full-partner admin importing with availability 'partner'", async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID]
    });
    h.state.selectQueue.push([]); // no conflict among partner-wide rows
    const result = await importBundle(auth, validBundle([baseEntry]), {
      mode: 'skip',
      availability: 'partner'
    });
    expect('error' in result).toBe(false);
    const values = h.state.inserts.find((i) => i.table === scripts)!.values as Record<string, unknown>;
    expect(values.orgId).toBeNull();
    expect(values.partnerId).toBe(PARTNER_ID);
    expect(values.isSystem).toBe(false);
  });

  it('skip mode leaves the existing script untouched', async () => {
    const bundle = validBundle([baseEntry]);
    h.state.selectQueue.push([
      { id: SCRIPT_ID, name: baseEntry.name, version: 3, content: 'old', orgId: ORG_ID }
    ]);
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('skipped' in result) {
      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);
    }
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('rename mode suffixes until a free name is found (one candidate query per entry)', async () => {
    const bundle = validBundle([baseEntry]);
    h.state.selectQueue.push(
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 1, content: 'old' }], // conflict
      [{ name: `${baseEntry.name} (2)` }] // single candidates query: (2) taken, (3) free
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'rename', availability: 'org' });
    expect('error' in result).toBe(false);
    const values = h.state.inserts.find((i) => i.table === scripts)!.values as Record<string, unknown>;
    expect(values.name).toBe(`${baseEntry.name} (3)`);
    if ('renamed' in result) {
      expect(result.renamed).toBe(1);
      expect(result.scripts[0]!.finalName).toBe(`${baseEntry.name} (3)`);
    }
  });

  it('new-version mode appends the previous content to scriptVersions and bumps the version', async () => {
    const bundle = validBundle([{ ...baseEntry, content: 'new content' }]);
    h.state.selectQueue.push([
      {
        id: SCRIPT_ID,
        name: baseEntry.name,
        version: 4,
        content: 'old content',
        description: 'd',
        category: null,
        parameters: null,
        exitCodeSeverityMapping: null
      }
    ]);
    const result = await importBundle(makeAuth(), bundle, {
      mode: 'new-version',
      availability: 'org'
    });
    expect('error' in result).toBe(false);

    const versionInsert = h.state.inserts.find((i) => i.table === scriptVersions);
    expect(versionInsert).toBeDefined();
    const snapshot = versionInsert!.values as Record<string, unknown>;
    expect(snapshot.scriptId).toBe(SCRIPT_ID);
    expect(snapshot.version).toBe(4);
    expect(snapshot.content).toBe('old content');

    const update = h.state.updates.find((u) => u.table === scripts);
    expect(update).toBeDefined();
    const set = update!.values as Record<string, unknown>;
    expect(set.content).toBe('new content');
    expect(set.version).toBe(5);
    if ('versioned' in result) expect(result.versioned).toBe(1);
  });

  it('records per-entry failures and continues with the rest', async () => {
    const bundle = validBundle([baseEntry, { ...baseEntry, name: 'Second script' }]);
    h.state.selectQueue = [[], []]; // both entries: no name conflict
    // Poison the FIRST insert (entry 1's script row); entry 2 proceeds normally.
    const { db } = await import('../../db');
    (db.insert as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(new Error('boom'))) }))
    }));
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe('boom');
      expect(result.imported).toBe(1);
    }
  });

  it('resolves tags by name in the target scope: reuses existing, creates missing, links both', async () => {
    const bundle = validBundle([{ ...baseEntry, tags: ['printing', 'windows'] }]);
    h.state.selectQueue.push(
      [], // findConflictByName → no org-owned match
      [], // findConflictByName → no partner-wide match (#3450)
      [{ id: TAG_ID, name: 'printing' }] // ensureTagIds → 'printing' exists, 'windows' missing
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);

    const tagInsert = h.state.inserts.find((i) => i.table === scriptTags);
    expect(tagInsert).toBeDefined();
    const createdTags = tagInsert!.values as Array<Record<string, unknown>>;
    expect(createdTags).toHaveLength(1);
    expect(createdTags[0]!.name).toBe('windows');
    expect(createdTags[0]!.orgId).toBe(ORG_ID);

    const linkInsert = h.state.inserts.find((i) => i.table === scriptToTags);
    expect(linkInsert).toBeDefined();
    expect((linkInsert!.values as unknown[]).length).toBe(2);
  });

  it('rejects a system-scope import with no orgId instead of creating tenantless orphan rows', async () => {
    const auth = makeAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null });
    const result = await importBundle(auth, validBundle([baseEntry]), {
      mode: 'skip',
      availability: 'org'
    });
    expect(result).toMatchObject({ status: 400 });
    expect(h.state.inserts).toHaveLength(0);
  });

  it('new-version mode with byte-identical content is a no-op skip (no version padding)', async () => {
    const bundle = validBundle([baseEntry]);
    h.state.selectQueue.push([
      { id: SCRIPT_ID, name: baseEntry.name, version: 4, content: baseEntry.content }
    ]);
    const result = await importBundle(makeAuth(), bundle, {
      mode: 'new-version',
      availability: 'org'
    });
    expect('error' in result).toBe(false);
    if ('skipped' in result) {
      expect(result.skipped).toBe(1);
      expect(result.versioned).toBe(0);
    }
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // #3450: partner-wide collisions on an org-target import.
  // -------------------------------------------------------------------------
  it('skip mode skips a partner-wide name match instead of creating a duplicate (#3450)', async () => {
    h.state.selectQueue.push(
      [], // no org-owned row
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 1, content: 'something else' }]
    );
    const result = await importBundle(makeAuth(), validBundle([baseEntry]), {
      mode: 'skip',
      availability: 'org'
    });
    expect('error' in result).toBe(false);
    if ('skipped' in result) {
      expect(result.skipped).toBe(1);
      expect(result.imported).toBe(0);
      expect(result.scripts[0]).toMatchObject({ action: 'skipped', scriptId: SCRIPT_ID });
    }
    // The whole point: no new scripts row.
    expect(h.state.inserts.filter((i) => i.table === scripts)).toHaveLength(0);
  });

  it('new-version mode refuses to version a read-only partner-wide row, and does not duplicate it', async () => {
    h.state.selectQueue.push(
      [],
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 4, content: 'DIFFERENT content' }]
    );
    const result = await importBundle(makeAuth(), validBundle([baseEntry]), {
      mode: 'new-version',
      availability: 'org'
    });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.name).toBe(baseEntry.name);
      expect(result.errors[0]!.error).toContain('partner-wide');
      expect(result.errors[0]!.error).toContain('read-only');
      expect(result.imported).toBe(0);
      expect(result.versioned).toBe(0);
    }
    // Neither a duplicate org row nor any mutation of the partner-wide row.
    expect(h.state.inserts.filter((i) => i.table === scripts)).toHaveLength(0);
    expect(h.state.inserts.filter((i) => i.table === scriptVersions)).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('isolates the partner-wide new-version refusal to its own entry — the rest of the bundle still imports', async () => {
    const bundle = validBundle([baseEntry, { ...baseEntry, name: 'Unrelated script' }]);
    h.state.selectQueue.push(
      [], // entry 1: no org-owned match
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 4, content: 'DIFFERENT content' }],
      [], // entry 2: no org-owned match
      [] // entry 2: no partner-wide match either → imports normally
    );
    const result = await importBundle(makeAuth(), bundle, {
      mode: 'new-version',
      availability: 'org'
    });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.index).toBe(0);
      // The refusal must `continue`, not abort the loop.
      expect(result.imported).toBe(1);
      expect(result.scripts).toHaveLength(1);
      expect(result.scripts[0]).toMatchObject({ index: 1, name: 'Unrelated script', action: 'imported' });
    }
    const scriptInserts = h.state.inserts.filter((i) => i.table === scripts);
    expect(scriptInserts).toHaveLength(1);
    expect((scriptInserts[0]!.values as Record<string, unknown>).name).toBe('Unrelated script');
  });

  it('new-version mode treats an identical-content partner-wide match as a no-op skip', async () => {
    h.state.selectQueue.push(
      [],
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 4, content: baseEntry.content }]
    );
    const result = await importBundle(makeAuth(), validBundle([baseEntry]), {
      mode: 'new-version',
      availability: 'org'
    });
    if ('skipped' in result) {
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    }
    expect(h.state.inserts.filter((i) => i.table === scripts)).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('rename mode picks a name free of BOTH the org and partner-wide namespaces', async () => {
    h.state.selectQueue.push(
      [], // no org-owned row
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 1, content: 'x' }], // partner-wide match
      [{ name: `${baseEntry.name} (2)` }] // findFreeName: "(2)" already taken
    );
    const result = await importBundle(makeAuth(), validBundle([baseEntry]), {
      mode: 'rename',
      availability: 'org'
    });
    expect('error' in result).toBe(false);
    if ('renamed' in result) {
      expect(result.renamed).toBe(1);
      expect(result.scripts[0]).toMatchObject({ action: 'renamed', finalName: `${baseEntry.name} (3)` });
    }

    // The free-name query must span both namespaces. For an ORG target,
    // scopeCondition alone never mentions partner_id — so its presence here
    // proves the partner-wide branch was OR'd in rather than the assertion
    // passing on the org condition by accident.
    const freeNameWhere = h.state.selectWheres[2];
    expect(conditionMentionsColumn(freeNameWhere, 'partner_id')).toBe(true);
    expect(conditionMentionsColumn(freeNameWhere, 'org_id')).toBe(true);
  });

  it('conflict lookups exclude system-library rows, so a bundle can never update an is_system script', async () => {
    h.state.selectQueue.push([]);
    await importBundle(makeAuth(), validBundle([baseEntry]), { mode: 'new-version', availability: 'org' });
    // The first SELECT is findConflictByName; its WHERE must filter on
    // is_system (= false) so a system script sharing the name is never
    // matched — and therefore never rewritten by new-version mode.
    expect(h.state.selectWheres.length).toBeGreaterThan(0);
    expect(conditionMentionsColumn(h.state.selectWheres[0], 'is_system')).toBe(true);
    expect(conditionMentionsColumn(h.state.selectWheres[0], 'deleted_at')).toBe(true);
  });

  it('records invalid entries per-entry and imports the valid ones', async () => {
    const envelope = {
      bundleVersion: 1 as const,
      scripts: [
        { ...baseEntry, timeoutSeconds: 99999 }, // fails createScriptSchema parity bounds
        { ...baseEntry, name: 'Valid script' }
      ]
    };
    h.state.selectQueue.push([]); // valid entry: no conflict
    const result = await importBundle(makeAuth(), envelope, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toContain('timeoutSeconds');
      expect(result.imported).toBe(1);
    }
  });

  // ---------------------------------------------------------------------
  // Save-time {{var.<secret>}} rejection (#3409 PR2)
  // ---------------------------------------------------------------------
  it('rejects a bundle entry whose content references a secret variable, per-entry rather than failing the whole bundle', async () => {
    const bundle = validBundle([
      { ...baseEntry, content: 'echo {{var.s1_token}}' },
      { ...baseEntry, name: 'Second script' } // no var.* tokens — unaffected
    ]);
    h.state.selectQueue.push(
      // entry 1: loadTenantVariableScope([ORG_ID]) — org-owned secret row
      [{ id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID }],
      // entry 1 short-circuits before findExistingByName; entry 2 proceeds normally
      [] // entry 2: findExistingByName → none
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe(
        'Script content references secret variable(s): {{var.s1_token}}. Secret variables cannot be substituted into script content.'
      );
      expect(result.imported).toBe(1);
    }
    expect(h.state.inserts.filter((i) => i.table === scripts)).toHaveLength(1);
  });

  it('accepts a bundle entry referencing an UNKNOWN variable key — warn-only, not a block', async () => {
    const bundle = validBundle([{ ...baseEntry, content: 'echo {{var.not_yet_created}}' }]);
    h.state.selectQueue.push(
      [], // loadTenantVariableScope([ORG_ID]) — no tenant_variables rows at all
      [] // findExistingByName → none
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('imported' in result) expect(result.imported).toBe(1);
    if ('errors' in result) expect(result.errors).toHaveLength(0);
  });

  it("rejects a partner-wide import entry referencing the partner's own secret variable (no single org to resolve against)", async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID]
    });
    const bundle = validBundle([{ ...baseEntry, content: 'echo {{var.p_secret}}' }]);
    // The partner-wide branch queries tenant_variables directly (org_id IS
    // NULL AND partner_id = caller's partner) — no resolver snapshot, since
    // there is no single org to attribute a partner-wide row to.
    h.state.selectQueue.push([{ key: 'p_secret', isSecret: true }]);
    const result = await importBundle(auth, bundle, { mode: 'skip', availability: 'partner' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toContain('p_secret');
    }
    expect(h.state.inserts).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Save-time parameter-binding secret mismatch (#3409 PR4c-2, Task 6)
  // ---------------------------------------------------------------------
  const secretRow = { id: 'tv-1', key: 's1_token', value: 'shh', isSecret: true, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID };
  const plainRow = { id: 'tv-2', key: 'repo_url', value: 'https://dl.example', isSecret: false, version: 1, ownerOrgId: ORG_ID, forOrgId: ORG_ID };

  it('rejects a bundle entry whose tenantVariable parameter binds a SECRET variable, per-entry', async () => {
    const bundle = validBundle([
      { ...baseEntry, parameters: [{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 's1_token' }] },
      { ...baseEntry, name: 'Second script' }
    ]);
    h.state.selectQueue.push(
      [secretRow], // entry 1: content has no tokens → only the parameter lookup (loadTenantVariableScope)
      [] // entry 2: findExistingByName → none
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.index).toBe(0);
      expect(result.errors[0]!.error).toBe(
        'Parameter "p" binds secret variable "s1_token" with source "From a variable"; use a secret parameter instead'
      );
      expect(result.imported).toBe(1);
    }
    expect(h.state.inserts.filter((i) => i.table === scripts)).toHaveLength(1);
  });

  it('rejects a bundle entry whose tenantSecret parameter binds a NON-secret variable, per-entry', async () => {
    const bundle = validBundle([
      { ...baseEntry, parameters: [{ name: 'p', type: 'string', source: 'tenantSecret', variableKey: 'repo_url' }] }
    ]);
    h.state.selectQueue.push([plainRow]);
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe('Parameter "p" is a secret parameter but variable "repo_url" is not a secret');
      expect(result.imported).toBe(0);
    }
    expect(h.state.inserts).toHaveLength(0);
  });

  it('imports a bundle entry whose bindings target UNKNOWN keys or match their targets', async () => {
    const bundle = validBundle([
      {
        ...baseEntry,
        parameters: [
          { name: 'p', type: 'string', source: 'tenantVariable', variableKey: 'repo_url' },
          { name: 'q', type: 'string', source: 'tenantSecret', variableKey: 's1_token' },
          { name: 'r', type: 'string', source: 'tenantSecret', variableKey: 'not_yet_created' }
        ]
      }
    ]);
    h.state.selectQueue.push(
      [secretRow, plainRow], // loadTenantVariableScope([ORG_ID])
      [] // findExistingByName → none
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) expect(result.errors).toHaveLength(0);
    if ('imported' in result) expect(result.imported).toBe(1);
  });

  it('still rejects on CONTENT secrets first, with the content message, when both content and parameters offend', async () => {
    const bundle = validBundle([
      {
        ...baseEntry,
        content: 'echo {{var.s1_token}}',
        parameters: [{ name: 'p', type: 'string', source: 'tenantVariable', variableKey: 's1_token' }]
      }
    ]);
    h.state.selectQueue.push([secretRow]); // content lookup short-circuits before the parameter lookup
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe(
        'Script content references secret variable(s): {{var.s1_token}}. Secret variables cannot be substituted into script content.'
      );
    }
    expect(h.state.inserts).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Ownership TIER of the secret vs. the SCRIPT (#3409 PR4c-2 review).
  //
  // A script may resolve a secret at or below its own ownership tier, never
  // above: a partner-wide script (org_id NULL) may bind a partner-owned OR an
  // org-owned secret; an ORG-scoped script may bind only an org-owned one.
  // The rule is NOT a caller capability — a full-partner admin saving an
  // org-scoped script is still denied, because that script is afterwards
  // editable and runnable by the customer org's own admins.
  //
  // Dispatch is the authority (services/sourcedParameters.ts, `tenantSecret`
  // arm); these cases pin the save-time FAST FAIL.
  // ---------------------------------------------------------------------
  // A partner-wide tenant_variables row: org_id IS NULL, hence ownerScope
  // 'partner' once resolveForOrg attributes it to the target org.
  const partnerSecretRow = {
    id: 'tv-3',
    key: 'psa_api_token',
    value: 'shh',
    isSecret: true,
    version: 1,
    ownerOrgId: null,
    forOrgId: ORG_ID
  };

  const TIER_DENIED =
    'Parameter "psa" binds partner-wide secret variable "psa_api_token"; an organization-scoped script cannot use one — make the script partner-wide, or use an organization-owned secret.';

  const psaSecretParam = { name: 'psa', type: 'string', source: 'tenantSecret', variableKey: 'psa_api_token' };

  it('rejects an ORG-scoped import binding a PARTNER-WIDE secret', async () => {
    const bundle = validBundle([{ ...baseEntry, parameters: [psaSecretParam] }]);
    h.state.selectQueue.push([partnerSecretRow]);
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe(TIER_DENIED);
    }
    expect(h.state.inserts).toHaveLength(0);
  });

  // The rule is the SCRIPT's tier, not the caller's capability: a full-partner
  // admin importing into ONE org is writing an org-scoped script, which that
  // org's admins can then edit and run.
  it('rejects an ORG-scoped import binding a PARTNER-WIDE secret even for a full-partner admin', async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID]
    });
    const bundle = validBundle([{ ...baseEntry, parameters: [psaSecretParam] }]);
    h.state.selectQueue.push([partnerSecretRow]);
    const result = await importBundle(auth, bundle, { mode: 'skip', availability: 'org', orgId: ORG_ID });
    expect('error' in result).toBe(false);
    if ('errors' in result) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.error).toBe(TIER_DENIED);
    }
    expect(h.state.inserts).toHaveLength(0);
  });

  it("ALLOWS a PARTNER-WIDE import binding the partner's own secret", async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID]
    });
    const bundle = validBundle([{ ...baseEntry, parameters: [psaSecretParam] }]);
    h.state.selectQueue.push(
      // Partner-wide branch: tenant_variables read directly (org_id IS NULL).
      [{ key: 'psa_api_token', isSecret: true }],
      [] // findConflictByName -> none
    );
    const result = await importBundle(auth, bundle, { mode: 'skip', availability: 'partner' });
    expect('error' in result).toBe(false);
    if ('errors' in result) expect(result.errors).toHaveLength(0);
    if ('imported' in result) expect(result.imported).toBe(1);
    const values = h.state.inserts.find((i) => i.table === scripts)!.values as Record<string, unknown>;
    expect(values.orgId).toBeNull();
  });

  // The PRIMARY use case: one partner-wide script, each target org's OWN value
  // resolved per device at dispatch. Save time sees no partner-wide row for the
  // key, so it is "unknown" here — and must not be rejected on that basis.
  it('ALLOWS a PARTNER-WIDE import binding a key that only exists as an ORG-owned secret', async () => {
    const auth = makeAuth({
      scope: 'partner',
      orgId: null,
      partnerOrgAccess: 'all',
      accessibleOrgIds: [ORG_ID]
    });
    const bundle = validBundle([
      { ...baseEntry, parameters: [{ name: 'q', type: 'string', source: 'tenantSecret', variableKey: 's1_token' }] }
    ]);
    h.state.selectQueue.push(
      [], // no partner-wide row named s1_token
      [] // findConflictByName -> none
    );
    const result = await importBundle(auth, bundle, { mode: 'skip', availability: 'partner' });
    expect('error' in result).toBe(false);
    if ('errors' in result) expect(result.errors).toHaveLength(0);
    if ('imported' in result) expect(result.imported).toBe(1);
  });

  it('leaves an ORG-owned secret binding unaffected for the same org-scope caller', async () => {
    const bundle = validBundle([
      { ...baseEntry, parameters: [{ name: 'q', type: 'string', source: 'tenantSecret', variableKey: 's1_token' }] }
    ]);
    h.state.selectQueue.push(
      [secretRow], // ownerOrgId === ORG_ID -> ownerScope 'organization'
      [] // findConflictByName -> none
    );
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    expect('error' in result).toBe(false);
    if ('errors' in result) expect(result.errors).toHaveLength(0);
    if ('imported' in result) expect(result.imported).toBe(1);
  });

  // A tenantVariable (non-secret source) binding to a partner-wide SECRET is
  // still the pre-existing secretBoundAsPlain rejection, not the new one —
  // the new kind must not swallow the older, more specific message.
  it('still reports secretBoundAsPlain for a tenantVariable bound to a partner-wide secret', async () => {
    const bundle = validBundle([
      { ...baseEntry, parameters: [{ name: 'psa', type: 'string', source: 'tenantVariable', variableKey: 'psa_api_token' }] }
    ]);
    h.state.selectQueue.push([partnerSecretRow]);
    const result = await importBundle(makeAuth(), bundle, { mode: 'skip', availability: 'org' });
    if ('errors' in result) {
      expect(result.errors[0]!.error).toBe(
        'Parameter "psa" binds secret variable "psa_api_token" with source "From a variable"; use a secret parameter instead'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Secret-parameter cap parity (#3409 PR4c-2, finding 3).
//
// `packages/shared` may not import from `apps/api`, so the save-time cap is a
// restatement of the envelope's own bound. This assertion is the ONLY thing
// stopping the two from drifting — if the envelope limit moves, the save-time
// schema must move with it or scripts save that can never dispatch.
// ---------------------------------------------------------------------------
describe('secret-parameter cap parity', () => {
  it('pins MAX_SECRET_SCRIPT_PARAMETERS to the envelope authority MAX_SECRET_ENV_ENTRIES', () => {
    expect(MAX_SECRET_SCRIPT_PARAMETERS).toBe(MAX_SECRET_ENV_ENTRIES);
  });
});

// ---------------------------------------------------------------------------
// previewBundle
// ---------------------------------------------------------------------------
describe('previewBundle', () => {
  it('annotates entries new / name-conflict without writing', async () => {
    const bundle = validBundle([baseEntry, { ...baseEntry, name: 'Second script' }]);
    h.state.selectQueue.push(
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 2 }],
      []
    );
    const result = await previewBundle(makeAuth(), bundle, { availability: 'org' });
    expect('error' in result).toBe(false);
    if ('entries' in result) {
      expect(result.entries[0]).toMatchObject({
        status: 'name-conflict',
        existingScriptId: SCRIPT_ID,
        existingVersion: 2
      });
      expect(result.entries[1]).toMatchObject({ status: 'new' });
    }
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('propagates the partner-wide capability denial', async () => {
    const auth = makeAuth({ scope: 'partner', orgId: null, partnerOrgAccess: 'selected' });
    const result = await previewBundle(auth, validBundle([baseEntry]), { availability: 'partner' });
    expect(result).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 });
  });

  // -------------------------------------------------------------------------
  // #3450: an org-target import collides with the caller's PARTNER-WIDE rows
  // too. They are not writable here, but they render in the same library list,
  // so annotating them 'new' is what produced visible same-name duplicates.
  // -------------------------------------------------------------------------
  it('flags a partner-wide name match as a conflict, not "new" (#3450)', async () => {
    h.state.selectQueue.push(
      [], // no org-owned row with this name
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 3 }] // ...but a partner-wide one exists
    );
    const result = await previewBundle(makeAuth(), validBundle([baseEntry]), { availability: 'org' });
    expect('error' in result).toBe(false);
    if ('entries' in result) {
      expect(result.entries[0]).toMatchObject({
        status: 'name-conflict',
        conflictKind: 'partner-wide',
        existingScriptId: SCRIPT_ID,
        existingVersion: 3
      });
    }
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it('prefers the org-owned match over a partner-wide one and never queries for the latter', async () => {
    h.state.selectQueue.push([{ id: SCRIPT_ID, name: baseEntry.name, version: 2 }]);
    const result = await previewBundle(makeAuth(), validBundle([baseEntry]), { availability: 'org' });
    if ('entries' in result) {
      expect(result.entries[0]).toMatchObject({
        status: 'name-conflict',
        conflictKind: 'target-scope',
        existingScriptId: SCRIPT_ID
      });
    }
    // Only the owned lookup ran — the partner-wide lookup short-circuits, so a
    // writable row is never shadowed by a read-only one.
    expect(h.state.selectWheres).toHaveLength(1);
  });

  it('omits conflictKind entirely when the entry is new', async () => {
    h.state.selectQueue.push([], []);
    const result = await previewBundle(makeAuth(), validBundle([baseEntry]), { availability: 'org' });
    if ('entries' in result) {
      expect(result.entries[0]!.status).toBe('new');
      expect(result.entries[0]).not.toHaveProperty('conflictKind');
    }
  });

  it('does NOT run a partner-wide lookup when the target IS partner-wide (already in scope)', async () => {
    const auth = makeAuth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
    h.state.selectQueue.push([]);
    const result = await previewBundle(auth, validBundle([baseEntry]), { availability: 'partner' });
    expect('entries' in result).toBe(true);
    // scopeCondition already targets (org_id IS NULL, partner_id = P); a second
    // identical query would be pure waste.
    expect(h.state.selectWheres).toHaveLength(1);
  });

  it('does NOT run a partner-wide lookup for a system-scope import (no partner context)', async () => {
    const auth = makeAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null });
    h.state.selectQueue.push([]);
    const result = await previewBundle(auth, validBundle([baseEntry]), {
      availability: 'org',
      orgId: ORG_ID
    });
    expect('entries' in result).toBe(true);
    expect(h.state.selectWheres).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// exportBundle
// ---------------------------------------------------------------------------
describe('exportBundle', () => {
  it('emits no tenancy identifiers and no isSystem flag, and skips unreadable scripts', async () => {
    h.state.selectQueue.push(
      [
        {
          id: SCRIPT_ID,
          orgId: ORG_ID,
          partnerId: PARTNER_ID,
          name: 'Mine',
          description: 'desc',
          category: 'Maintenance',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'Write-Host hi',
          parameters: { foo: 'bar' },
          timeoutSeconds: 120,
          runAs: 'system',
          isSystem: false,
          version: 2,
          exitCodeSeverityMapping: { '1': 'high' },
          deletedAt: null
        },
        {
          id: 'not-readable',
          orgId: OTHER_ORG_ID,
          partnerId: OTHER_PARTNER_ID,
          name: 'Theirs',
          osTypes: ['linux'],
          language: 'bash',
          content: 'echo hi',
          timeoutSeconds: 300,
          runAs: 'system',
          isSystem: false,
          version: 1,
          deletedAt: null
        }
      ],
      [{ scriptId: SCRIPT_ID, name: 'printing' }] // tag join
    );

    const bundle = await exportBundle(makeAuth(), [SCRIPT_ID, 'not-readable'] as string[]);
    expect(bundle.bundleVersion).toBe(1);
    expect(bundle.scripts).toHaveLength(1);
    const entry = bundle.scripts[0] as Record<string, unknown>;
    expect(entry.name).toBe('Mine');
    expect(entry.tags).toEqual(['printing']);
    expect(entry).not.toHaveProperty('id');
    expect(entry).not.toHaveProperty('orgId');
    expect(entry).not.toHaveProperty('partnerId');
    expect(entry).not.toHaveProperty('isSystem');
    expect(entry).not.toHaveProperty('createdBy');
  });

  it('round-trips: an exported bundle validates against the bundle schema', async () => {
    h.state.selectQueue.push(
      [
        {
          id: SCRIPT_ID,
          orgId: ORG_ID,
          partnerId: PARTNER_ID,
          name: 'Mine',
          description: null,
          category: null,
          osTypes: ['windows'],
          language: 'powershell',
          content: 'Write-Host hi',
          parameters: null,
          timeoutSeconds: 300,
          runAs: 'system',
          isSystem: true, // even a system script exports clean
          version: 1,
          exitCodeSeverityMapping: null,
          deletedAt: null
        }
      ],
      []
    );
    const bundle = await exportBundle(makeAuth(), [SCRIPT_ID]);
    const parsed = scriptBundleSchema.safeParse(bundle);
    expect(parsed.success).toBe(true);
  });
});
