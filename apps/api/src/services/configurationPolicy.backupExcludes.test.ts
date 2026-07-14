import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { addFeatureLink, updateFeatureLink } from './configurationPolicy';
import { db } from '../db';

/**
 * Backup exclusion globs, validated at the LAST chokepoint before persistence
 * (#2473).
 *
 * The HTTP routes already validate inlineSettings with backupInlineSettingsSchema.
 * The AI/MCP `manage_policy_feature_link` tool does NOT — it declares
 * inlineSettings as `z.record(z.string(), z.unknown())` and hands the blob
 * straight to addFeatureLink/updateFeatureLink. Both funnel through
 * decomposeInlineSettings, where the backstop lives.
 *
 * These tests drive that real path (not the zod schema in isolation), because
 * the schema being correct proves nothing about whether the AI path reaches it.
 */

/** tx.select().from().innerJoin().where().limit() → rows */
function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** Row decomposeInlineSettings reads to resolve the policy's ownership axis. */
const POLICY_ROW = { orgId: 'org-1', partnerId: null, featurePolicyId: null };

/** Row updateFeatureLink reads FIRST, to discover the link's featureType. */
const EXISTING_BACKUP_LINK = {
  id: 'link-1',
  configPolicyId: 'policy-1',
  featureType: 'backup',
  featurePolicyId: null,
  inlineSettings: {},
};

/**
 * @param selectResults rows returned by successive tx.select() calls, in order.
 *   addFeatureLink issues only decompose's ownership query. updateFeatureLink
 *   issues the existing-link query FIRST, then decompose's — if that sequence is
 *   not honored, `existing.featureType` is undefined, decompose's switch matches
 *   nothing, and the test passes vacuously without ever reaching the backstop.
 * @returns `captured` — values handed to the config_policy_backup_settings
 *   insert, i.e. what would actually hit the DB.
 */
function mockBackupTx(selectResults: unknown[][] = [[POLICY_ROW]]) {
  const captured: { values?: Record<string, unknown> } = {};
  let insertCall = 0;
  let selectCall = 0;

  const tx = {
    select: vi.fn(() => {
      const rows = selectResults[selectCall] ?? [POLICY_ROW];
      selectCall += 1;
      return selectChain(rows);
    }),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            Promise.resolve([{ id: 'link-1', configPolicyId: 'policy-1', featureType: 'backup' }]),
          ),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertCall += 1;
        if (insertCall === 1 && 'inlineSettings' in v) {
          // The feature-link row itself.
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(() =>
                Promise.resolve([
                  {
                    id: 'link-1',
                    configPolicyId: 'policy-1',
                    featureType: 'backup',
                    featurePolicyId: v.featurePolicyId ?? null,
                    inlineSettings: v.inlineSettings,
                  },
                ]),
              ),
            })),
          };
        }
        // The normalized config_policy_backup_settings row.
        captured.values = v;
        return Promise.resolve([]);
      }),
    })),
  };

  // Same tx-mock shape as configurationPolicy.test.ts; the real parameter is a
  // full Drizzle transaction, which is not worth reconstructing here.
  // eslint-disable-next-line
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return captured;
}

const VALID_SETTINGS = {
  backupMode: 'file',
  paths: ['/data'],
  targets: { paths: ['/data'], excludes: ['*.tmp', 'node_modules/**'] },
};

describe('backup exclusion globs — AI/MCP backstop (#2473)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a malformed glob on the AI create path (bypasses the HTTP zod schema)', async () => {
    mockBackupTx();
    // Valid in bash/minimatch; the agent's path.Match dialect rejects it, so it
    // would be silently dropped and exclude nothing.
    await expect(
      addFeatureLink('policy-1', 'backup', null, {
        ...VALID_SETTINGS,
        targets: { paths: ['/data'], excludes: ['[a-z0-9_-].log'] },
      }),
    ).rejects.toThrow(/exclusion pattern/i);
  });

  it('rejects a malformed glob on the AI update path too', async () => {
    // Sequence matters: existing-link row first, THEN decompose's ownership row.
    mockBackupTx([[EXISTING_BACKUP_LINK], [POLICY_ROW]]);
    await expect(
      updateFeatureLink('link-1', {
        inlineSettings: {
          ...VALID_SETTINGS,
          targets: { paths: ['/data'], excludes: ['logs/[a-'] },
        },
      }),
    ).rejects.toThrow(/exclusion pattern/i);
  });

  it('accepts a valid glob on the AI update path (proves the reject above is not vacuous)', async () => {
    const captured = mockBackupTx([[EXISTING_BACKUP_LINK], [POLICY_ROW]]);
    await expect(
      updateFeatureLink('link-1', { inlineSettings: VALID_SETTINGS }),
    ).resolves.toBeDefined();
    expect((captured.values?.targets as Record<string, unknown>)?.excludes).toEqual([
      '*.tmp',
      'node_modules/**',
    ]);
  });

  it('persists the stripped list, not the raw one', async () => {
    const captured = mockBackupTx();
    await addFeatureLink('policy-1', 'backup', null, {
      ...VALID_SETTINGS,
      targets: { paths: ['/data'], excludes: ['*.tmp', '', '   ', 'node_modules/**'] },
    });
    // Blank lines are dropped on the way to the DB — not persisted, not rejected.
    expect((captured.values?.targets as Record<string, unknown>)?.excludes).toEqual([
      '*.tmp',
      'node_modules/**',
    ]);
  });

  it('rejects a non-array excludes (a plausible LLM mistake) instead of writing a string into JSONB', async () => {
    mockBackupTx();
    await expect(
      addFeatureLink('policy-1', 'backup', null, {
        ...VALID_SETTINGS,
        targets: { paths: ['/data'], excludes: '*.tmp' },
      }),
    ).rejects.toThrow(/exclusion pattern/i);
  });

  it('accepts a valid glob and writes it through', async () => {
    const captured = mockBackupTx();
    await addFeatureLink('policy-1', 'backup', null, VALID_SETTINGS);
    expect((captured.values?.targets as Record<string, unknown>)?.excludes).toEqual([
      '*.tmp',
      'node_modules/**',
    ]);
  });

  it('does NOT reject a profile-linked link whose targets are legitimately empty', async () => {
    // Guards the deliberate scoping of the backstop. "What to protect" lives on
    // the linked backup profile, so targets is empty by design. If someone
    // "simplifies" the backstop to re-parse the whole blob with
    // backupInlineSettingsSchema, fileTargetsSchema's paths.min(1) would fire and
    // break EVERY profile-linked policy save.
    const captured = mockBackupTx();
    await expect(
      addFeatureLink('policy-1', 'backup', null, {
        schedule: { frequency: 'daily', time: '03:00' },
        retention: { retentionDays: 30 },
      }),
    ).resolves.toBeDefined();
    expect(captured.values?.targets).toEqual({});
  });

  it('materializes a profile-linked backup even when inline settings are omitted', async () => {
    const profileId = '00000000-0000-4000-8000-0000000000a1';
    const captured = mockBackupTx([
      [{ ...POLICY_ROW, featurePolicyId: profileId }],
      [{ id: profileId }],
    ]);

    await expect(addFeatureLink('policy-1', 'backup', profileId)).resolves.toBeDefined();
    expect(captured.values).toMatchObject({ backupProfileId: profileId });
  });

  it('rebuilds normalized backup settings when only featurePolicyId changes', async () => {
    const profileId = '00000000-0000-4000-8000-0000000000b2';
    const captured = mockBackupTx([
      [{ ...EXISTING_BACKUP_LINK, inlineSettings: VALID_SETTINGS }],
      [{ ...POLICY_ROW, featurePolicyId: profileId }],
      [{ id: profileId }],
    ]);

    await expect(updateFeatureLink('link-1', { featurePolicyId: profileId })).resolves.toBeDefined();
    expect(captured.values?.backupProfileId).toBe(profileId);
    expect(captured.values?.paths).toEqual(VALID_SETTINGS.paths);
  });
});
