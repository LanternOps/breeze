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
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    updates: [] as Array<{ table: unknown; values: unknown }>
  };
  function chain(get: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'offset', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
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
  }
}));

import { scripts, scriptTags, scriptToTags, scriptVersions } from '../../db/schema';
import { exportBundle, importBundle, previewBundle, type BundleAuth } from './index';
import {
  scriptBundleSchema,
  MAX_BUNDLE_SCRIPTS,
  MAX_BUNDLE_CONTENT_LENGTH
} from './schema';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';

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
  h.state.inserts = [];
  h.state.updates = [];
});

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
    // Raw (attacker-supplied) JSON claims isSystem + a foreign tenant.
    const bundle = validBundle([
      { ...baseEntry, isSystem: true, orgId: OTHER_ORG_ID, partnerId: OTHER_PARTNER_ID }
    ]);
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

  it('rename mode suffixes until a free name is found', async () => {
    const bundle = validBundle([baseEntry]);
    h.state.selectQueue.push(
      [{ id: SCRIPT_ID, name: baseEntry.name, version: 1, content: 'old' }], // conflict
      [{ id: 'other', name: `${baseEntry.name} (2)` }], // (2) taken
      [] // (3) free
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
      [], // findExistingByName → none
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
