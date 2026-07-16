/**
 * Real-driver cross-tenant forge tests for config_policy_onedrive_settings (Task 3).
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually
 * enforced.  If `.env.test` is missing the symlink that pins this to the
 * breeze_app role, the positive control in case (b) would still insert (no
 * RLS block on own-org rows), but a BYPASSRLS admin connection would allow
 * the cross-org insert in case (c) — which is why we include a non-vacuity
 * guard (case 0) and a positive control (case b) in addition to the forge
 * case (case c).
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS — see "why no memoization" below):
 *   partnerA → orgA → configPolicyA → featureLinkA
 *   partnerB → orgB → configPolicyB → featureLinkB
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, which
 * cascades through the configuration_policies and config_policy_feature_links
 * FKs and wipes all fixture rows. A module-level fixture cache would hand
 * later tests rows that no longer exist, making the RLS assertions vacuous
 * (a forged insert can surface an incidental FK 23503 instead of 42501).
 * Each it() re-seeds fresh — matching every sibling *-rls.integration.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configPolicyOnedriveSettings,
  configPolicyOnedriveLibraries,
  onedriveDeviceState,
  configurationPolicies,
  configPolicyFeatureLinks,
  devices,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL_APP = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const ONEDRIVE_SERIALIZATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-01-c-serialize-onedrive-policy-references.sql',
);
const FEATURE_REFERENCE_GATE_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-01-d-harden-feature-reference-serialization.sql',
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForRaceSignal<T>(
  signal: Promise<T>,
  worker: Promise<unknown>,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} did not report progress within 5 seconds`));
    }, 5_000);
  });
  const workerStopped = worker.then<never>(
    () => {
      throw new Error(`${label} completed before reporting progress`);
    },
    (error: unknown) => {
      throw new Error(`${label} failed before reporting progress`, { cause: error });
    },
  );

  try {
    return await Promise.race([signal, workerStopped, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(
    clients.map((client) => client.end({ timeout: 1 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to close OneDrive race database client(s)');
  }
}

async function waitForExpectedRowOrFkLock(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [waiting] = await getTestDb().execute<{
      lockType: string;
      mode: string;
      hasBlocker: boolean;
    }>(sql`
      SELECT lock.locktype AS "lockType",
        lock.mode,
        cardinality(pg_catalog.pg_blocking_pids(lock.pid)) > 0 AS "hasBlocker"
      FROM pg_catalog.pg_locks lock
      WHERE lock.pid = ${backendPid}
        AND NOT lock.granted
      ORDER BY lock.locktype, lock.mode
      LIMIT 1
    `);
    if (waiting) {
      expect(waiting).toEqual({
        lockType: 'transactionid',
        mode: 'ShareLock',
        hasBlocker: true,
      });
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`OneDrive reference backend ${backendPid} never waited on a row/FK lock`);
}

async function waitForExpectedCAdvisoryLock(
  backendPid: number,
  sharedIdentities: string[],
): Promise<void> {
  const [expected] = await getTestDb().execute<{ identity: string; objectId: string }>(sql`
    SELECT identity,
      pg_catalog.hashtext(identity)::oid::text AS "objectId"
    FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(sharedIdentities)}::jsonb) identity
    ORDER BY pg_catalog.hashtext(identity)
    LIMIT 1
  `);
  if (!expected) throw new Error('missing expected OneDrive advisory identity');

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [waiting] = await getTestDb().execute<{
      classId: string;
      objectId: string;
      objectSubId: number;
    }>(sql`
      SELECT lock.classid::text AS "classId",
        lock.objid::text AS "objectId",
        lock.objsubid AS "objectSubId"
      FROM pg_catalog.pg_locks lock
      WHERE lock.pid = ${backendPid}
        AND lock.locktype = 'advisory'
        AND lock.mode = 'ExclusiveLock'
        AND NOT lock.granted
      LIMIT 1
    `);
    if (waiting) {
      expect(waiting, `waiter must block on C identity ${expected.identity}`).toEqual({
        classId: '1000302',
        objectId: expected.objectId,
        objectSubId: 2,
      });
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`OneDrive reference backend ${backendPid} never waited on a C advisory lock`);
}

async function dropOneDriveFeatureReferenceGates(): Promise<void> {
  await getTestDb().execute(sql.raw(`
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert
      ON public.config_policy_onedrive_settings;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update
      ON public.config_policy_onedrive_settings;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete
      ON public.config_policy_onedrive_settings;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_insert
      ON public.config_policy_onedrive_libraries;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update
      ON public.config_policy_onedrive_libraries;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete
      ON public.config_policy_onedrive_libraries;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update
      ON public.config_policy_feature_links;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete
      ON public.config_policy_feature_links;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_update
      ON public.configuration_policies;
    DROP TRIGGER IF EXISTS aaa_feature_reference_gate_delete
      ON public.configuration_policies;
  `));
}

async function restoreFeatureReferenceGates(): Promise<void> {
  const migration = readFileSync(FEATURE_REFERENCE_GATE_MIGRATION_FILE, 'utf8');
  await getTestDb().execute(sql.raw(migration));
}

interface CapturedDatabaseError {
  sqlState: string | undefined;
  constraint: string | undefined;
}

async function captureDatabaseError(
  work: () => Promise<unknown>,
): Promise<CapturedDatabaseError | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as {
      code?: string;
      constraint_name?: string;
      constraint?: string;
      cause?: { code?: string; constraint_name?: string; constraint?: string };
    };
    const databaseError = wrapped.cause ?? wrapped;
    return {
      sqlState: databaseError.code,
      constraint: databaseError.constraint_name ?? databaseError.constraint,
    };
  }
}

interface Fixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  featureLinkA: { id: string };
  featureLinkB: { id: string };
  configPolicyA: { id: string };
  /** breeze_app context scoped to org A (mirrors authMiddleware org scope). */
  orgAContext: DbAccessContext;
}

// Re-seeds fresh on every call. Intentionally NOT memoized: setup.ts's
// beforeEach cleanupDatabase() TRUNCATEs partners/organizations CASCADE before
// each test, so any cached rows would already be deleted by the time an
// assertion runs — which would silently make every cross-tenant case vacuous.
async function seedFixture(): Promise<Fixture> {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  // Keep unrelated policy owners in separate transactions so export-clock
  // advisory locks follow the production single-owner ordering.
  const { configPolicyA, featureLinkA } = await withSystemDbAccessContext(async () => {
    const [configPolicyA] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgA.id, name: 'OD Policy A' })
      .returning({ id: configurationPolicies.id });
    if (!configPolicyA) throw new Error('failed to seed config policy A');

    const [featureLinkA] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: configPolicyA.id, featureType: 'onedrive_helper' })
      .returning({ id: configPolicyFeatureLinks.id });
    if (!featureLinkA) throw new Error('failed to seed feature link A');
    return { configPolicyA, featureLinkA };
  });

  const { featureLinkB } = await withSystemDbAccessContext(async () => {
    const [configPolicyB] = await db
      .insert(configurationPolicies)
      .values({ orgId: orgB.id, name: 'OD Policy B' })
      .returning({ id: configurationPolicies.id });
    if (!configPolicyB) throw new Error('failed to seed config policy B');

    const [featureLinkB] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: configPolicyB.id, featureType: 'onedrive_helper' })
      .returning({ id: configPolicyFeatureLinks.id });
    if (!featureLinkB) throw new Error('failed to seed feature link B');
    return { featureLinkB };
  });

  const orgAContext: DbAccessContext = {
    scope: 'organization',
    orgId: orgA.id,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partnerA.id],
    userId: null,
  };

  return {
    partnerA: { id: partnerA.id },
    orgA: { id: orgA.id },
    partnerB: { id: partnerB.id },
    orgB: { id: orgB.id },
    featureLinkA: { id: featureLinkA.id },
    featureLinkB: { id: featureLinkB.id },
    configPolicyA: { id: configPolicyA.id },
    orgAContext,
  };
}

describe('config_policy_onedrive_settings RLS isolation (breeze_app)', () => {
  // (0) Non-vacuity guard: code-under-test runs as the unprivileged breeze_app
  // role with rolbypassrls=f. If this is ever a BYPASSRLS connection, every
  // assertion below would pass even with broken policies.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.orgAContext, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // (a) Positive control: under org A's context, an org-A settings row for
  // org A's own feature link succeeds. This proves the policy is not
  // deny-everything, which would make the forge case pass for the wrong reason.
  runDb('positive control: org A context can insert its own onedrive settings row', async () => {
    const fx = await seedFixture();

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(configPolicyOnedriveSettings)
        .values({
          featureLinkId: fx.featureLinkA.id,
          orgId: fx.orgA.id,
        })
        .returning({ id: configPolicyOnedriveSettings.id, orgId: configPolicyOnedriveSettings.orgId })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org SELECT hidden: a settings row seeded for org B is invisible
  // to an org A caller. The system-scope probe first confirms the row really
  // exists so the 0-row read under org A is meaningfully "RLS hid it" rather
  // than "it was never seeded" — guarding against a vacuous hidden-row test.
  runDb('hides org B settings from org A SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    // Seed org B's settings row under system scope (RLS-bypassing seed).
    const seededId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({
          featureLinkId: fx.featureLinkB.id,
          orgId: fx.orgB.id,
        })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    // Probe: under system scope the row really exists.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, seededId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under org A breeze_app context the same id returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, seededId))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (c) Cross-org INSERT denied: under an org A context, inserting a settings
  // row carrying org B's feature link + org_id is rejected by the INSERT WITH
  // CHECK policy. Both featureLinkB and orgB are real seeded rows (FKs
  // resolve), so the failure MUST be the RLS 42501, not a 23503 FK violation.
  // Drizzle wraps the driver error: cause.code carries the Postgres SQLSTATE.
  runDb('blocks a forged cross-org config_policy_onedrive_settings INSERT for another org (42501)', async () => {
    const fx = await seedFixture();

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(configPolicyOnedriveSettings).values({
          featureLinkId: fx.featureLinkB.id, // org B's real feature link (FK resolves)
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (d) Cross-org UPDATE re-home denied: org A owns a settings row and tries
  // to reassign its org_id to org B. Two independent layers both reject this —
  // the RLS UPDATE WITH CHECK (42501) and the feature-link reference-ownership
  // composite FK (23503, 2026-07-27-b) — and which surfaces first is an
  // implementation detail. Either way the cross-org re-home cannot commit.
  // (The forged-INSERT test above stays a pure 42501 RLS proof: there the FK
  // side is deliberately consistent.)
  runDb('blocks org A re-homing its own settings row to org B', async () => {
    const fx = await seedFixture();

    const settingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkA.id, orgId: fx.orgA.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db
          .update(configPolicyOnedriveSettings)
          .set({ orgId: fx.orgB.id })
          .where(eq(configPolicyOnedriveSettings.id, settingsId))
      )
    ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(?:42501|23503)$/) } });
  });

  runDb('blocks same-org settings from referencing another org feature link', async () => {
    const fx = await seedFixture();

    await expect(withDbAccessContext(fx.orgAContext, () =>
      db.insert(configPolicyOnedriveSettings).values({
        featureLinkId: fx.featureLinkB.id,
        orgId: fx.orgA.id,
      })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('reverse-validates OneDrive link and policy owner changes', async () => {
    const fx = await seedFixture();
    await withSystemDbAccessContext(() => db.insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }));

    await expect(withSystemDbAccessContext(() => db.update(configPolicyFeatureLinks)
      .set({ featureType: 'patch' })
      .where(eq(configPolicyFeatureLinks.id, fx.featureLinkA.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withSystemDbAccessContext(() => db.update(configurationPolicies)
      .set({ orgId: fx.orgB.id })
      .where(eq(configurationPolicies.id, fx.configPolicyA.id))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (e) Cross-org DELETE hidden (USING): org A cannot delete org B's settings
  // row — 0 rows affected, and a system probe confirms it survives.
  runDb('org A DELETE of org B settings affects 0 rows and leaves it intact', async () => {
    const fx = await seedFixture();

    const orgBSettingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    const deleted = await withDbAccessContext(fx.orgAContext, () =>
      db
        .delete(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, orgBSettingsId))
        .returning({ id: configPolicyOnedriveSettings.id })
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withSystemDbAccessContext(() =>
      db
        .select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, orgBSettingsId))
    );
    expect(survivors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// config_policy_onedrive_libraries RLS isolation (Task 4)
// ---------------------------------------------------------------------------
// Fixture re-use: seedFixture() is defined above and seeds both orgs, both
// feature links, and an org-A-scoped breeze_app context. Library tests need
// a settings row for the FK reference (settings_id), so each test seeds one
// under system scope before the RLS assertion.
// ---------------------------------------------------------------------------
describe('config_policy_onedrive_libraries RLS isolation (breeze_app)', () => {
  // (a) Positive control: org A can insert a library row for its own settings.
  runDb('positive control: org A context can insert its own library mapping', async () => {
    const fx = await seedFixture();

    // Seed org A's settings row under system scope (FK prerequisite).
    const settingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkA.id, orgId: fx.orgA.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    // Under org A's breeze_app context, inserting a library row for org A succeeds.
    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(configPolicyOnedriveLibraries)
        .values({
          settingsId,
          orgId: fx.orgA.id,
          libraryId: 'lib-a1',
          displayName: 'Org A Documents',
          targetingMode: 'everyone',
        })
        .returning({
          id: configPolicyOnedriveLibraries.id,
          orgId: configPolicyOnedriveLibraries.orgId,
        })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.id, inserted!.id))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org INSERT denied: org A context cannot insert a library row
  // carrying org B's org_id. The settings_id used is from org B's seeded
  // settings row so the FK resolves — the rejection MUST be RLS (42501),
  // not a FK violation (23503).
  runDb('blocks a forged cross-org config_policy_onedrive_libraries INSERT (42501)', async () => {
    const fx = await seedFixture();

    // Seed org B's settings row under system scope so the FK resolves.
    const orgBSettingsId = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      return row!.id;
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(configPolicyOnedriveLibraries).values({
          settingsId: orgBSettingsId, // org B's real settings row (FK resolves)
          orgId: fx.orgB.id,          // foreign org — RLS WITH CHECK must reject
          libraryId: 'lib-x',
          displayName: 'Finance',
          targetingMode: 'everyone',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (c) Cross-org UPDATE re-home denied: org A owns a library row and tries
  // to reassign its org_id to org B. Denied by RLS UPDATE WITH CHECK (42501)
  // or the settings reference-ownership composite FK (23503) — see the
  // settings re-home test above for why either code proves the block.
  runDb('blocks org A re-homing its own library row to org B', async () => {
    const fx = await seedFixture();

    const libraryId = await withSystemDbAccessContext(async () => {
      const [settings] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkA.id, orgId: fx.orgA.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      const [lib] = await db
        .insert(configPolicyOnedriveLibraries)
        .values({
          settingsId: settings!.id,
          orgId: fx.orgA.id,
          libraryId: 'lib-a-own',
          displayName: 'Own',
          targetingMode: 'everyone',
        })
        .returning({ id: configPolicyOnedriveLibraries.id });
      return lib!.id;
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db
          .update(configPolicyOnedriveLibraries)
          .set({ orgId: fx.orgB.id })
          .where(eq(configPolicyOnedriveLibraries.id, libraryId))
      )
    ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(?:42501|23503)$/) } });
  });

  runDb('blocks same-org library from referencing another org settings row', async () => {
    const fx = await seedFixture();
    const orgBSettingsId = await withSystemDbAccessContext(async () => {
      const [settings] = await db.insert(configPolicyOnedriveSettings).values({
        featureLinkId: fx.featureLinkB.id,
        orgId: fx.orgB.id,
      }).returning({ id: configPolicyOnedriveSettings.id });
      return settings!.id;
    });

    await expect(withDbAccessContext(fx.orgAContext, () =>
      db.insert(configPolicyOnedriveLibraries).values({
        settingsId: orgBSettingsId,
        orgId: fx.orgA.id,
        libraryId: 'lib-owner-forge',
        displayName: 'Owner forge',
        targetingMode: 'everyone',
      })))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('reverse-validates library ownership when settings move to another valid policy', async () => {
    const fx = await seedFixture();
    const settingsId = await withSystemDbAccessContext(async () => {
      const [settings] = await db.insert(configPolicyOnedriveSettings).values({
        featureLinkId: fx.featureLinkA.id,
        orgId: fx.orgA.id,
      }).returning({ id: configPolicyOnedriveSettings.id });
      await db.insert(configPolicyOnedriveLibraries).values({
        settingsId: settings!.id,
        orgId: fx.orgA.id,
        libraryId: 'lib-reverse-owner',
        displayName: 'Reverse owner',
        targetingMode: 'everyone',
      });
      return settings!.id;
    });

    await expect(withSystemDbAccessContext(() => db.update(configPolicyOnedriveSettings)
      .set({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id })
      .where(eq(configPolicyOnedriveSettings.id, settingsId))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (d) Cross-org DELETE hidden (USING): org A cannot delete org B's library row
  // — 0 rows affected, and a system probe confirms it survives.
  runDb('org A DELETE of org B library affects 0 rows and leaves it intact', async () => {
    const fx = await seedFixture();

    const orgBLibraryId = await withSystemDbAccessContext(async () => {
      const [settings] = await db
        .insert(configPolicyOnedriveSettings)
        .values({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id })
        .returning({ id: configPolicyOnedriveSettings.id });
      const [lib] = await db
        .insert(configPolicyOnedriveLibraries)
        .values({
          settingsId: settings!.id,
          orgId: fx.orgB.id,
          libraryId: 'lib-b-own',
          displayName: 'Org B',
          targetingMode: 'everyone',
        })
        .returning({ id: configPolicyOnedriveLibraries.id });
      return lib!.id;
    });

    const deleted = await withDbAccessContext(fx.orgAContext, () =>
      db
        .delete(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.id, orgBLibraryId))
        .returning({ id: configPolicyOnedriveLibraries.id })
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withSystemDbAccessContext(() =>
      db
        .select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.id, orgBLibraryId))
    );
    expect(survivors).toHaveLength(1);
  });
});

describe('OneDrive normalized-reference serialization', () => {
  beforeEach(async () => {
    await dropOneDriveFeatureReferenceGates();
  });

  afterEach(async () => {
    await restoreFeatureReferenceGates();
  });

  runDb('rejects a policy owner move that waited behind a concurrent settings insert', async () => {
    const fx = await seedFixture();
    const settingsId = randomUUID();
    const inserted = deferred<void>();
    const releaseInsert = deferred<void>();
    const moverEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const mover = postgres(DATABASE_URL_APP, {
      max: 1,
      connect_timeout: 5,
      connection: { application_name: `onedrive-policy-mover-${randomUUID()}` },
      onnotice: () => {},
    });
    let holderWork: Promise<void> | undefined;
    let moverWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      const [role] = await holder<{ who: string; bypass: boolean }[]>`
        SELECT current_user AS who, rolbypassrls AS bypass
        FROM pg_catalog.pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual({ who: 'breeze_app', bypass: false });

      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          INSERT INTO public.config_policy_onedrive_settings (id, feature_link_id, org_id)
          VALUES (${settingsId}, ${fx.featureLinkA.id}, ${fx.orgA.id})
        `;
        inserted.resolve();
        await releaseInsert.promise;
      });
      await waitForRaceSignal(inserted.promise, holderWork, 'settings-insert holder');

      moverWork = captureDatabaseError(() => mover.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive policy mover backend');
        moverEntered.resolve(backend.pid);
        await tx`
          UPDATE public.configuration_policies
          SET org_id = ${fx.orgB.id}, updated_at = now()
          WHERE id = ${fx.configPolicyA.id}
        `;
      }));
      const moverPid = await waitForRaceSignal(
        moverEntered.promise,
        moverWork,
        'policy mover',
      );
      await waitForExpectedCAdvisoryLock(moverPid, [
        `feature-link:${fx.featureLinkA.id}`,
        `policy:${fx.configPolicyA.id}`,
      ]);
      releaseInsert.resolve();
      await holderWork;

      expect(await moverWork).toMatchObject({ sqlState: '23503' });
      const [policy] = await getTestDb().select({ orgId: configurationPolicies.orgId })
        .from(configurationPolicies)
        .where(eq(configurationPolicies.id, fx.configPolicyA.id));
      expect(policy?.orgId).toBe(fx.orgA.id);
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([holderWork, moverWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, mover);
    }
  }, 20_000);

  runDb('makes a settings insert wait for and reject a committed policy owner move', async () => {
    const fx = await seedFixture();
    const moved = deferred<void>();
    const releaseMove = deferred<void>();
    const inserterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const inserter = postgres(DATABASE_URL_APP, {
      max: 1,
      connect_timeout: 5,
      connection: { application_name: `onedrive-settings-inserter-${randomUUID()}` },
      onnotice: () => {},
    });
    let holderWork: Promise<void> | undefined;
    let inserterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          UPDATE public.configuration_policies
          SET org_id = ${fx.orgB.id}, updated_at = now()
          WHERE id = ${fx.configPolicyA.id}
        `;
        moved.resolve();
        await releaseMove.promise;
      });
      await waitForRaceSignal(moved.promise, holderWork, 'policy-move holder');

      inserterWork = captureDatabaseError(() => inserter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive settings inserter backend');
        inserterEntered.resolve(backend.pid);
        await tx`
          INSERT INTO public.config_policy_onedrive_settings (feature_link_id, org_id)
          VALUES (${fx.featureLinkA.id}, ${fx.orgA.id})
        `;
      }));
      const inserterPid = await waitForRaceSignal(
        inserterEntered.promise,
        inserterWork,
        'settings inserter',
      );
      await waitForExpectedCAdvisoryLock(inserterPid, [
        `feature-link:${fx.featureLinkA.id}`,
        `policy:${fx.configPolicyA.id}`,
      ]);
      releaseMove.resolve();
      await holderWork;

      expect(await inserterWork).toMatchObject({ sqlState: '23503' });
      const rows = await getTestDb().select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, fx.featureLinkA.id));
      expect(rows).toHaveLength(0);
    } finally {
      releaseMove.resolve();
      await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, inserter);
    }
  }, 20_000);

  runDb('serializes a feature-link delete after a concurrent settings insert', async () => {
    const fx = await seedFixture();
    const inserted = deferred<void>();
    const releaseInsert = deferred<void>();
    const deleterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const deleter = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let deleterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          INSERT INTO public.config_policy_onedrive_settings (feature_link_id, org_id)
          VALUES (${fx.featureLinkA.id}, ${fx.orgA.id})
        `;
        inserted.resolve();
        await releaseInsert.promise;
      });
      await waitForRaceSignal(inserted.promise, holderWork, 'settings-insert holder');

      deleterWork = captureDatabaseError(() => deleter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive feature-link deleter backend');
        deleterEntered.resolve(backend.pid);
        await tx`
          DELETE FROM public.config_policy_feature_links
          WHERE id = ${fx.featureLinkA.id}
        `;
      }));
      const deleterPid = await waitForRaceSignal(
        deleterEntered.promise,
        deleterWork,
        'feature-link deleter',
      );
      await waitForExpectedRowOrFkLock(deleterPid);
      releaseInsert.resolve();
      await holderWork;

      expect(await deleterWork).toBeUndefined();
      expect(await getTestDb().select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, fx.featureLinkA.id)))
        .toHaveLength(0);
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([holderWork, deleterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, deleter);
    }
  }, 20_000);

  runDb('makes a settings insert reject after a concurrent feature-link delete commits', async () => {
    const fx = await seedFixture();
    const deleted = deferred<void>();
    const releaseDelete = deferred<void>();
    const inserterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const inserter = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let inserterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          DELETE FROM public.config_policy_feature_links
          WHERE id = ${fx.featureLinkA.id}
        `;
        deleted.resolve();
        await releaseDelete.promise;
      });
      await waitForRaceSignal(deleted.promise, holderWork, 'feature-link-delete holder');

      inserterWork = captureDatabaseError(() => inserter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing post-delete OneDrive settings inserter backend');
        inserterEntered.resolve(backend.pid);
        await tx`
          INSERT INTO public.config_policy_onedrive_settings (feature_link_id, org_id)
          VALUES (${fx.featureLinkA.id}, ${fx.orgA.id})
        `;
      }));
      const inserterPid = await waitForRaceSignal(
        inserterEntered.promise,
        inserterWork,
        'settings inserter after feature-link delete',
      );
      await waitForExpectedRowOrFkLock(inserterPid);
      releaseDelete.resolve();
      await holderWork;

      expect(await inserterWork).toEqual({
        sqlState: '23503',
        constraint: 'config_policy_onedrive_settings_feature_link_id_fkey',
      });
      expect(await getTestDb().select({ id: configPolicyFeatureLinks.id })
        .from(configPolicyFeatureLinks)
        .where(eq(configPolicyFeatureLinks.id, fx.featureLinkA.id))).toHaveLength(0);
      expect(await getTestDb().select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.featureLinkId, fx.featureLinkA.id)))
        .toHaveLength(0);
    } finally {
      releaseDelete.resolve();
      await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, inserter);
    }
  }, 20_000);

  runDb('rejects a settings owner move that waited behind a concurrent library insert', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing OneDrive settings race row');
    const inserted = deferred<void>();
    const releaseInsert = deferred<void>();
    const moverEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const mover = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let moverWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          INSERT INTO public.config_policy_onedrive_libraries
            (settings_id, org_id, library_id, display_name, targeting_mode)
          VALUES (${settings.id}, ${fx.orgA.id}, 'race-library-a', 'Race A', 'everyone')
        `;
        inserted.resolve();
        await releaseInsert.promise;
      });
      await waitForRaceSignal(inserted.promise, holderWork, 'library-insert holder');
      moverWork = captureDatabaseError(() => mover.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive settings mover backend');
        moverEntered.resolve(backend.pid);
        await tx`
          UPDATE public.config_policy_onedrive_settings
          SET feature_link_id = ${fx.featureLinkB.id}, org_id = ${fx.orgB.id}, updated_at = now()
          WHERE id = ${settings.id}
        `;
      }));
      const moverPid = await waitForRaceSignal(
        moverEntered.promise,
        moverWork,
        'settings owner mover',
      );
      await waitForExpectedRowOrFkLock(moverPid);
      releaseInsert.resolve();
      await holderWork;
      expect(await moverWork).toMatchObject({ sqlState: '23503' });
      const [persisted] = await getTestDb().select({ orgId: configPolicyOnedriveSettings.orgId })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, settings.id));
      expect(persisted?.orgId).toBe(fx.orgA.id);
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([holderWork, moverWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, mover);
    }
  }, 20_000);

  runDb('makes a library insert wait for and reject a committed settings owner move', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing opposite OneDrive settings race row');
    const moved = deferred<void>();
    const releaseMove = deferred<void>();
    const inserterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const inserter = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let inserterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          UPDATE public.config_policy_onedrive_settings
          SET feature_link_id = ${fx.featureLinkB.id}, org_id = ${fx.orgB.id}, updated_at = now()
          WHERE id = ${settings.id}
        `;
        moved.resolve();
        await releaseMove.promise;
      });
      await waitForRaceSignal(moved.promise, holderWork, 'settings-owner-move holder');
      inserterWork = captureDatabaseError(() => inserter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive library inserter backend');
        inserterEntered.resolve(backend.pid);
        await tx`
          INSERT INTO public.config_policy_onedrive_libraries
            (settings_id, org_id, library_id, display_name, targeting_mode)
          VALUES (${settings.id}, ${fx.orgA.id}, 'race-library-b', 'Race B', 'everyone')
        `;
      }));
      const inserterPid = await waitForRaceSignal(
        inserterEntered.promise,
        inserterWork,
        'library inserter after settings owner move',
      );
      await waitForExpectedRowOrFkLock(inserterPid);
      releaseMove.resolve();
      await holderWork;
      expect(await inserterWork).toEqual({
        sqlState: '23503',
        constraint: 'config_policy_onedrive_libraries_owner_match',
      });
      const [persisted] = await getTestDb().select({
        featureLinkId: configPolicyOnedriveSettings.featureLinkId,
        orgId: configPolicyOnedriveSettings.orgId,
      }).from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, settings.id));
      expect(persisted).toEqual({ featureLinkId: fx.featureLinkB.id, orgId: fx.orgB.id });
      expect(await getTestDb().select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.settingsId, settings.id))).toHaveLength(0);
    } finally {
      releaseMove.resolve();
      await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, inserter);
    }
  }, 20_000);

  runDb('serializes a settings delete after a concurrent library insert', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing settings row for library/delete race');
    const inserted = deferred<void>();
    const releaseInsert = deferred<void>();
    const deleterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const deleter = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let deleterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          INSERT INTO public.config_policy_onedrive_libraries
            (settings_id, org_id, library_id, display_name, targeting_mode)
          VALUES (${settings.id}, ${fx.orgA.id}, 'delete-race-a', 'Delete Race A', 'everyone')
        `;
        inserted.resolve();
        await releaseInsert.promise;
      });
      await waitForRaceSignal(inserted.promise, holderWork, 'library-insert holder');

      deleterWork = captureDatabaseError(() => deleter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing OneDrive settings deleter backend');
        deleterEntered.resolve(backend.pid);
        await tx`
          DELETE FROM public.config_policy_onedrive_settings
          WHERE id = ${settings.id}
        `;
      }));
      const deleterPid = await waitForRaceSignal(
        deleterEntered.promise,
        deleterWork,
        'settings deleter',
      );
      await waitForExpectedRowOrFkLock(deleterPid);
      releaseInsert.resolve();
      await holderWork;

      expect(await deleterWork).toBeUndefined();
      expect(await getTestDb().select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, settings.id))).toHaveLength(0);
      expect(await getTestDb().select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.settingsId, settings.id))).toHaveLength(0);
    } finally {
      releaseInsert.resolve();
      await Promise.allSettled([holderWork, deleterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, deleter);
    }
  }, 20_000);

  runDb('makes a library insert reject after a concurrent settings delete commits', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing settings row for delete/library race');
    const deleted = deferred<void>();
    const releaseDelete = deferred<void>();
    const inserterEntered = deferred<number>();
    const holder = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    const inserter = postgres(DATABASE_URL_APP, { max: 1, connect_timeout: 5, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let inserterWork: Promise<CapturedDatabaseError | undefined> | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        await tx`
          DELETE FROM public.config_policy_onedrive_settings
          WHERE id = ${settings.id}
        `;
        deleted.resolve();
        await releaseDelete.promise;
      });
      await waitForRaceSignal(deleted.promise, holderWork, 'settings-delete holder');

      inserterWork = captureDatabaseError(() => inserter.begin(async (tx) => {
        await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
        const [backend] = await tx<{ pid: number }[]>`
          SELECT pg_catalog.pg_backend_pid() AS pid
        `;
        if (!backend) throw new Error('missing post-delete OneDrive library inserter backend');
        inserterEntered.resolve(backend.pid);
        await tx`
          INSERT INTO public.config_policy_onedrive_libraries
            (settings_id, org_id, library_id, display_name, targeting_mode)
          VALUES (${settings.id}, ${fx.orgA.id}, 'delete-race-b', 'Delete Race B', 'everyone')
        `;
      }));
      const inserterPid = await waitForRaceSignal(
        inserterEntered.promise,
        inserterWork,
        'library inserter after settings delete',
      );
      await waitForExpectedRowOrFkLock(inserterPid);
      releaseDelete.resolve();
      await holderWork;

      expect(await inserterWork).toEqual({
        sqlState: '23503',
        constraint: 'config_policy_onedrive_libraries_settings_id_fkey',
      });
      expect(await getTestDb().select({ id: configPolicyOnedriveSettings.id })
        .from(configPolicyOnedriveSettings)
        .where(eq(configPolicyOnedriveSettings.id, settings.id))).toHaveLength(0);
      expect(await getTestDb().select({ id: configPolicyOnedriveLibraries.id })
        .from(configPolicyOnedriveLibraries)
        .where(eq(configPolicyOnedriveLibraries.settingsId, settings.id))).toHaveLength(0);
    } finally {
      releaseDelete.resolve();
      await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(holder, inserter);
    }
  }, 20_000);

  runDb('rolls back an invalid bulk library owner move atomically', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing bulk OneDrive settings row');
    const libraries = await getTestDb().insert(configPolicyOnedriveLibraries).values([
      {
        settingsId: settings.id,
        orgId: fx.orgA.id,
        libraryId: 'bulk-library-a',
        displayName: 'Bulk A',
        targetingMode: 'everyone',
      },
      {
        settingsId: settings.id,
        orgId: fx.orgA.id,
        libraryId: 'bulk-library-b',
        displayName: 'Bulk B',
        targetingMode: 'everyone',
      },
    ]).returning({ id: configPolicyOnedriveLibraries.id });

    await expect(getTestDb().execute(sql`
      UPDATE public.config_policy_onedrive_libraries
      SET org_id = ${fx.orgB.id}
      WHERE id = ANY(ARRAY[${libraries[1]!.id}::uuid, ${libraries[0]!.id}::uuid])
    `)).rejects.toMatchObject({ cause: { code: '23503' } });
    const owners = await getTestDb().select({ orgId: configPolicyOnedriveLibraries.orgId })
      .from(configPolicyOnedriveLibraries)
      .where(eq(configPolicyOnedriveLibraries.settingsId, settings.id));
    expect(owners).toHaveLength(2);
    expect(owners.every((owner) => owner.orgId === fx.orgA.id)).toBe(true);
  });

  runDb('allows feature-link delete to cascade through settings and libraries', async () => {
    const fx = await seedFixture();
    const [settings] = await getTestDb().insert(configPolicyOnedriveSettings).values({
      featureLinkId: fx.featureLinkA.id,
      orgId: fx.orgA.id,
    }).returning({ id: configPolicyOnedriveSettings.id });
    if (!settings) throw new Error('missing cascade OneDrive settings row');
    await getTestDb().insert(configPolicyOnedriveLibraries).values({
      settingsId: settings.id,
      orgId: fx.orgA.id,
      libraryId: 'cascade-library',
      displayName: 'Cascade',
      targetingMode: 'everyone',
    });

    await expect(getTestDb().delete(configPolicyFeatureLinks)
      .where(eq(configPolicyFeatureLinks.id, fx.featureLinkA.id))).resolves.toBeDefined();
    expect(await getTestDb().select().from(configPolicyOnedriveSettings)
      .where(eq(configPolicyOnedriveSettings.id, settings.id))).toHaveLength(0);
    expect(await getTestDb().select().from(configPolicyOnedriveLibraries)
      .where(eq(configPolicyOnedriveLibraries.settingsId, settings.id))).toHaveLength(0);
  });

  runDb('migration is idempotent and installs private ordered statement triggers', async () => {
    const admin = getTestDb();
    const migration = readFileSync(ONEDRIVE_SERIALIZATION_MIGRATION_FILE, 'utf8');
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();

    interface OneDriveTriggerTuple extends Record<string, unknown> {
      relation: string;
      name: string;
      operation: 'DELETE' | 'INSERT' | 'UPDATE';
      timing: 'AFTER' | 'BEFORE';
      level: 'ROW' | 'STATEMENT';
      oldTransitionTable: string | null;
      newTransitionTable: string | null;
      helperSchema: string;
      helper: string;
      helperIdentityArguments: string;
    }
    const triggers = await admin.execute<OneDriveTriggerTuple>(sql`
      SELECT relation.relname AS relation,
        trigger.tgname AS name,
        CASE
          WHEN (trigger.tgtype & 4) = 4 THEN 'INSERT'
          WHEN (trigger.tgtype & 8) = 8 THEN 'DELETE'
          ELSE 'UPDATE'
        END AS operation,
        CASE WHEN (trigger.tgtype & 2) = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
        CASE WHEN (trigger.tgtype & 1) = 1 THEN 'ROW' ELSE 'STATEMENT' END AS level,
        trigger.tgoldtable AS "oldTransitionTable",
        trigger.tgnewtable AS "newTransitionTable",
        proc_namespace.nspname AS "helperSchema",
        proc.proname AS helper,
        pg_catalog.pg_get_function_identity_arguments(proc.oid) AS "helperIdentityArguments"
      FROM pg_catalog.pg_trigger trigger
      JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc proc ON proc.oid = trigger.tgfoid
      JOIN pg_catalog.pg_namespace proc_namespace ON proc_namespace.oid = proc.pronamespace
      WHERE namespace.nspname = 'public'
        AND trigger.tgname LIKE 'a_onedrive_%'
        AND NOT trigger.tgisinternal
      ORDER BY relation.relname, trigger.tgname
    `);
    expect(triggers).toEqual([
      {
        relation: 'config_policy_feature_links',
        name: 'a_onedrive_reference_link_delete',
        operation: 'DELETE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: null,
        helperSchema: 'public',
        helper: 'breeze_revalidate_onedrive_parent_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_feature_links',
        name: 'a_onedrive_reference_link_update',
        operation: 'UPDATE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_revalidate_onedrive_parent_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_libraries',
        name: 'a_onedrive_library_delete',
        operation: 'DELETE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: null,
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_library_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_libraries',
        name: 'a_onedrive_library_insert',
        operation: 'INSERT',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: null,
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_library_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_libraries',
        name: 'a_onedrive_library_update',
        operation: 'UPDATE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_library_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_settings',
        name: 'a_onedrive_settings_delete',
        operation: 'DELETE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: null,
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_settings_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_settings',
        name: 'a_onedrive_settings_insert',
        operation: 'INSERT',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: null,
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_settings_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'config_policy_onedrive_settings',
        name: 'a_onedrive_settings_update',
        operation: 'UPDATE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_enforce_onedrive_settings_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'configuration_policies',
        name: 'a_onedrive_reference_policy_delete',
        operation: 'DELETE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: null,
        helperSchema: 'public',
        helper: 'breeze_revalidate_onedrive_parent_statements',
        helperIdentityArguments: '',
      },
      {
        relation: 'configuration_policies',
        name: 'a_onedrive_reference_policy_update',
        operation: 'UPDATE',
        timing: 'AFTER',
        level: 'STATEMENT',
        oldTransitionTable: 'old_rows',
        newTransitionTable: 'new_rows',
        helperSchema: 'public',
        helper: 'breeze_revalidate_onedrive_parent_statements',
        helperIdentityArguments: '',
      },
    ] satisfies OneDriveTriggerTuple[]);

    const [legacy] = await admin.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_trigger trigger
      WHERE NOT trigger.tgisinternal
        AND trigger.tgname IN (
          'config_policy_onedrive_settings_tenant_integrity',
          'config_policy_onedrive_libraries_tenant_integrity',
          'config_policy_onedrive_settings_link_reference_update',
          'config_policy_onedrive_settings_policy_owner_update',
          'config_policy_onedrive_libraries_settings_owner_update'
        )
    `);
    expect(legacy?.count).toBe(0);

    const helpers = await admin.execute<{
      name: string;
      securityDefiner: boolean;
      fixedContext: boolean;
      namespaceCount: number;
      publicExecute: boolean;
      appExecute: boolean;
    }>(sql`
      SELECT proc.proname AS name,
        proc.prosecdef AS "securityDefiner",
        proc.proconfig @> ARRAY[
          'search_path=pg_catalog, public',
          'breeze.scope=system',
          'breeze.accessible_org_ids=',
          'breeze.accessible_partner_ids='
        ]::text[] AS "fixedContext",
        (length(pg_catalog.pg_get_functiondef(proc.oid))
          - length(replace(pg_catalog.pg_get_functiondef(proc.oid),
            'pg_advisory_xact_lock(1000302', '')))::integer
          / length('pg_advisory_xact_lock(1000302') AS "namespaceCount",
        EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
          ) privilege
          WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
        ) AS "publicExecute",
        pg_catalog.has_function_privilege('breeze_app', proc.oid, 'EXECUTE') AS "appExecute"
      FROM pg_catalog.pg_proc proc
      WHERE proc.proname IN (
        'breeze_enforce_onedrive_settings_statements',
        'breeze_enforce_onedrive_library_statements',
        'breeze_revalidate_onedrive_parent_statements'
      )
      ORDER BY proc.proname
    `);
    expect(helpers).toHaveLength(3);
    expect(helpers).toEqual(helpers.map((helper) => ({
      ...helper,
      securityDefiner: true,
      fixedContext: true,
      namespaceCount: 1,
      publicExecute: false,
      appExecute: false,
    })));

    const order = await admin.execute<{ name: string }>(sql`
      SELECT trigger.tgname AS name
      FROM pg_catalog.pg_trigger trigger
      WHERE NOT trigger.tgisinternal
        AND trigger.tgrelid = 'public.configuration_policies'::regclass
        AND trigger.tgname IN (
          'a_onedrive_reference_policy_update',
          'aa_config_policy_feature_reference_policy_update',
          'ab_config_policy_assignment_policy_owner_update',
          'breeze_partner_export_configuration_update'
        )
      ORDER BY trigger.tgname
    `);
    expect(order.map((row) => row.name)).toEqual([
      'a_onedrive_reference_policy_update',
      'aa_config_policy_feature_reference_policy_update',
      'ab_config_policy_assignment_policy_owner_update',
      'breeze_partner_export_configuration_update',
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// onedrive_device_state RLS isolation (Task 5)
// ---------------------------------------------------------------------------
// This table is device-keyed (PK = device_id) with a denormalized org_id
// (Shape 5). Policies are the same breeze_has_org_access(org_id) form as
// the prior tables, so one row per device and cross-tenant isolation is
// enforced at the org boundary.
//
// Each test seeds its own device (+ site) under system scope to satisfy
// the device_id FK. Fixtures are re-seeded per test (same rationale as
// prior suites — beforeEach cleanupDatabase() TRUNCATE wipes everything).
// ---------------------------------------------------------------------------

let deviceAgentCounter = 0;

/** Insert a device under system scope and return its id. */
async function seedDevice(orgId: string, siteId: string): Promise<string> {
  deviceAgentCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `onedrive-state-test-${deviceAgentCounter}-${Date.now()}`,
      hostname: `host-${deviceAgentCounter}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: insert returned no row');
  return row.id;
}

describe('onedrive_device_state RLS isolation (breeze_app)', () => {
  // (a) Positive control: under org A's context, upsert state for org A's
  // own device succeeds and reads back correctly.
  runDb('positive control: org A context can upsert state for its own device', async () => {
    const fx = await seedFixture();

    const { deviceId } = await withSystemDbAccessContext(async () => {
      const siteA = await createSite({ orgId: fx.orgA.id });
      const devId = await seedDevice(fx.orgA.id, siteA.id);
      return { deviceId: devId };
    });

    const [inserted] = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(onedriveDeviceState)
        .values({
          deviceId,
          orgId: fx.orgA.id,
          signedIn: true,
        })
        .returning({
          deviceId: onedriveDeviceState.deviceId,
          orgId: onedriveDeviceState.orgId,
        })
    );
    expect(inserted?.orgId).toBe(fx.orgA.id);
    expect(inserted?.deviceId).toBe(deviceId);

    // Confirm the row is readable back under the same context.
    const fetched = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, deviceId))
    );
    expect(fetched).toHaveLength(1);
  });

  // (b) Cross-org SELECT hidden: a state row seeded for org B's device is
  // invisible to an org A caller. System-scope probe first confirms the row
  // really exists so the 0-row read under org A is meaningfully "RLS hid it".
  runDb('hides org B device state from org A SELECT (system probe confirms it exists)', async () => {
    const fx = await seedFixture();

    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      const devId = await seedDevice(fx.orgB.id, siteB.id);
      await db
        .insert(onedriveDeviceState)
        .values({ deviceId: devId, orgId: fx.orgB.id, signedIn: false });
      return devId;
    });

    // Probe: under system scope the row really exists.
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(existsUnderSystem).toHaveLength(1);

    // Under org A breeze_app context the same device returns 0 rows — RLS hides it.
    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(visibleToA).toHaveLength(0);
  });

  // (c) Cross-org INSERT denied: under org A's context, inserting state
  // carrying org B's device_id + org_id is rejected by the INSERT WITH CHECK
  // policy. Both the device row and org row are real (FKs resolve), so the
  // failure MUST be RLS (42501), not a FK violation (23503).
  runDb('blocks a forged cross-org onedrive_device_state INSERT (42501)', async () => {
    const fx = await seedFixture();

    // Seed org B's device under system scope so the FK resolves.
    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      return seedDevice(fx.orgB.id, siteB.id);
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(onedriveDeviceState).values({
          deviceId: orgBDeviceId, // org B's real device (FK resolves)
          orgId: fx.orgB.id,     // foreign org — RLS WITH CHECK must reject
          signedIn: false,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (d) Cross-org UPDATE hidden (USING): org A cannot update org B's existing
  // state row. The row is invisible under org A's context, so the UPDATE matches
  // 0 rows (no error) and a system-scope probe confirms it is untouched.
  runDb('org A UPDATE of org B device state affects 0 rows and leaves it unchanged', async () => {
    const fx = await seedFixture();

    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      const devId = await seedDevice(fx.orgB.id, siteB.id);
      await db.insert(onedriveDeviceState).values({ deviceId: devId, orgId: fx.orgB.id, signedIn: true });
      return devId;
    });

    const updated = await withDbAccessContext(fx.orgAContext, () =>
      db
        .update(onedriveDeviceState)
        .set({ signedIn: false })
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
        .returning({ deviceId: onedriveDeviceState.deviceId })
    );
    expect(updated).toHaveLength(0);

    // System-scope probe: org B's row is intact (still signedIn = true).
    const [survivor] = await withSystemDbAccessContext(() =>
      db
        .select({ signedIn: onedriveDeviceState.signedIn })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(survivor?.signedIn).toBe(true);
  });

  // (e) Cross-org UPDATE WITH CHECK denied: org A owns a state row and tries to
  // reassign its org_id to org B. USING passes (its own row) but the new org_id
  // violates the UPDATE WITH CHECK policy → 42501.
  runDb('blocks org A re-homing its own device state to org B (42501)', async () => {
    const fx = await seedFixture();

    const orgADeviceId = await withSystemDbAccessContext(async () => {
      const siteA = await createSite({ orgId: fx.orgA.id });
      const devId = await seedDevice(fx.orgA.id, siteA.id);
      await db.insert(onedriveDeviceState).values({ deviceId: devId, orgId: fx.orgA.id, signedIn: true });
      return devId;
    });

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db
          .update(onedriveDeviceState)
          .set({ orgId: fx.orgB.id }) // foreign org — UPDATE WITH CHECK must reject
          .where(eq(onedriveDeviceState.deviceId, orgADeviceId))
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (f) Cross-org DELETE hidden (USING): org A cannot delete org B's state row.
  // The DELETE matches 0 rows and a system-scope probe confirms it survives.
  runDb('org A DELETE of org B device state affects 0 rows and leaves it intact', async () => {
    const fx = await seedFixture();

    const orgBDeviceId = await withSystemDbAccessContext(async () => {
      const siteB = await createSite({ orgId: fx.orgB.id });
      const devId = await seedDevice(fx.orgB.id, siteB.id);
      await db.insert(onedriveDeviceState).values({ deviceId: devId, orgId: fx.orgB.id, signedIn: true });
      return devId;
    });

    const deleted = await withDbAccessContext(fx.orgAContext, () =>
      db
        .delete(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
        .returning({ deviceId: onedriveDeviceState.deviceId })
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withSystemDbAccessContext(() =>
      db
        .select({ deviceId: onedriveDeviceState.deviceId })
        .from(onedriveDeviceState)
        .where(eq(onedriveDeviceState.deviceId, orgBDeviceId))
    );
    expect(survivors).toHaveLength(1);
  });
});
