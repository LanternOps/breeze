import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';
import { configurationPolicies } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const SERIALIZATION_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-01-a-serialize-feature-policy-references.sql',
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    throw new AggregateError(failures, 'failed to close feature-reference race database client(s)');
  }
}

async function waitForBackendLockWait(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const rows = await getTestDb().execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity
        WHERE pid = ${backendPid}
          AND state = 'active'
          AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
      ) AS waiting
    `);
    if (rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`feature-policy owner move backend ${backendPid} never waited on a lock`);
}

async function captureSqlState(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as { code?: string; cause?: { code?: string } };
    return wrapped.cause?.code ?? wrapped.code;
  }
}

runDb('serializes an automation link insert against a referenced policy owner move', async () => {
  const admin = getTestDb();
  const partnerA = await createPartner({ name: `Feature race A ${randomUUID()}` });
  const partnerB = await createPartner({ name: `Feature race B ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const [parentPolicy, targetPolicy] = await admin.insert(configurationPolicies).values([
    { orgId: orgA.id, name: 'Automation race parent' },
    { orgId: orgA.id, name: 'Automation race target' },
  ]).returning();
  if (!parentPolicy || !targetPolicy) throw new Error('feature race policy seed failed');

  const applicationName = `feature-reference-owner-move-${randomUUID()}`;
  const linkInserted = deferred<void>();
  const releaseLinkInsert = deferred<void>();
  const moverEntered = deferred<number>();
  const holder = postgres(DATABASE_URL, {
    max: 1,
    connection: { application_name: `feature-reference-link-holder-${randomUUID()}` },
    onnotice: () => {},
  });
  const mover = postgres(DATABASE_URL, {
    max: 1,
    connection: { application_name: applicationName },
    onnotice: () => {},
  });

  let holderWork: Promise<void> | undefined;
  let moverWork: Promise<string | undefined> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`
        INSERT INTO public.config_policy_feature_links
          (config_policy_id, feature_type, feature_policy_id)
        VALUES (${parentPolicy.id}, 'automation', ${targetPolicy.id})
      `;
      linkInserted.resolve();
      await releaseLinkInsert.promise;
    });
    await waitForRaceSignal(
      linkInserted.promise,
      holderWork,
      'feature-link insert holder',
    );

    moverWork = captureSqlState(() => mover.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('application_name', ${applicationName}, true)`;
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing feature-policy mover backend pid');
      moverEntered.resolve(backend.pid);
      await tx`
        UPDATE public.configuration_policies
        SET org_id = ${orgB.id}, updated_at = now()
        WHERE id = ${targetPolicy.id}
      `;
    }));
    const moverBackendPid = await waitForRaceSignal(
      moverEntered.promise,
      moverWork,
      'referenced-policy mover',
    );

    // The link insert's configuration-material watermark update holds the
    // transaction open.  The target-policy update runs reverse validation
    // under its earlier statement snapshot, then waits while touching the
    // same export material.  Seeing the tagged backend wait makes the race
    // deterministic instead of relying on sleeps.
    await waitForBackendLockWait(moverBackendPid);
    releaseLinkInsert.resolve();
    await holderWork;
    expect(await moverWork).toBe('23503');

    const [persistedTarget] = await admin.select({ orgId: configurationPolicies.orgId })
      .from(configurationPolicies)
      .where(eq(configurationPolicies.id, targetPolicy.id));
    expect(persistedTarget?.orgId).toBe(orgA.id);

    const [validation] = await admin.execute<{ valid: boolean }>(sql`
      SELECT public.breeze_config_policy_feature_reference_is_valid(
        ${parentPolicy.id}::uuid,
        'automation'::public.config_feature_type,
        ${targetPolicy.id}::uuid
      ) AS valid
    `);
    expect(validation?.valid, 'the committed feature reference must remain tenant-valid').toBe(true);
  } finally {
    releaseLinkInsert.resolve();
    await Promise.allSettled([holderWork, moverWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(holder, mover);
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentPolicy.id));
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, targetPolicy.id));
  }
}, 20_000);

runDb('makes a link insert wait for and reject a committed referenced-policy owner move', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Feature opposite A ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const [parentPolicy, targetPolicy] = await admin.insert(configurationPolicies).values([
    { orgId: orgA.id, name: 'Opposite race parent' },
    { orgId: orgA.id, name: 'Opposite race target' },
  ]).returning();
  if (!parentPolicy || !targetPolicy) throw new Error('opposite policy race seed failed');

  const moved = deferred<void>();
  const releaseMove = deferred<void>();
  const inserterEntered = deferred<number>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const inserter = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  let inserterWork: Promise<string | undefined> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`UPDATE public.configuration_policies
        SET org_id = ${orgB.id}, updated_at = now() WHERE id = ${targetPolicy.id}`;
      moved.resolve();
      await releaseMove.promise;
    });
    await waitForRaceSignal(
      moved.promise,
      holderWork,
      'referenced-policy move holder',
    );
    inserterWork = captureSqlState(() => inserter.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing opposite link backend pid');
      inserterEntered.resolve(backend.pid);
      await tx`INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
        VALUES (${parentPolicy.id}, 'automation', ${targetPolicy.id})`;
    }));
    const inserterPid = await waitForRaceSignal(
      inserterEntered.promise,
      inserterWork,
      'feature-link inserter',
    );
    await waitForBackendLockWait(inserterPid);
    releaseMove.resolve();
    await holderWork;
    expect(await inserterWork).toBe('23503');
  } finally {
    releaseMove.resolve();
    await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(holder, inserter);
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentPolicy.id));
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, targetPolicy.id));
  }
}, 20_000);

runDb('makes a link insert wait for and reject a committed organization partner move', async () => {
  const admin = getTestDb();
  const partnerA = await createPartner({ name: `Feature org A ${randomUUID()}` });
  const partnerB = await createPartner({ name: `Feature org B ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partnerA.id });
  const [parentPolicy] = await admin.insert(configurationPolicies).values({
    orgId: org.id, name: 'Organization opposite race parent',
  }).returning();
  if (!parentPolicy) throw new Error('organization race policy seed failed');
  const [ring] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.patch_policies (partner_id, kind, name)
    VALUES (${partnerA.id}, 'ring', ${`Organization race ring ${randomUUID()}`})
    RETURNING id
  `);
  if (!ring) throw new Error('organization race ring seed failed');

  const moved = deferred<void>();
  const releaseMove = deferred<void>();
  const inserterEntered = deferred<number>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const inserter = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  let inserterWork: Promise<string | undefined> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`UPDATE public.organizations SET partner_id = ${partnerB.id} WHERE id = ${org.id}`;
      moved.resolve();
      await releaseMove.promise;
    });
    await waitForRaceSignal(
      moved.promise,
      holderWork,
      'organization move holder',
    );
    inserterWork = captureSqlState(() => inserter.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing organization link backend pid');
      inserterEntered.resolve(backend.pid);
      await tx`INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
        VALUES (${parentPolicy.id}, 'patch', ${ring.id})`;
    }));
    const inserterPid = await waitForRaceSignal(
      inserterEntered.promise,
      inserterWork,
      'organization feature-link inserter',
    );
    await waitForBackendLockWait(inserterPid);
    releaseMove.resolve();
    await holderWork;
    expect(await inserterWork).toBe('23503');
  } finally {
    releaseMove.resolve();
    await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(holder, inserter);
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentPolicy.id));
    await admin.execute(sql`DELETE FROM public.patch_policies WHERE id = ${ring.id}`);
  }
}, 20_000);

runDb('makes a typed link insert wait for and reject a committed software target move', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Feature typed ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const [parentPolicy] = await admin.insert(configurationPolicies).values({
    orgId: orgA.id, name: 'Typed opposite race parent',
  }).returning();
  const [target] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.software_policies (org_id, partner_id, name, mode, rules)
    VALUES (${orgA.id}, NULL, ${`Typed race ${randomUUID()}`}, 'audit', '{"software":[]}'::jsonb)
    RETURNING id
  `);
  if (!parentPolicy || !target) throw new Error('typed race seed failed');

  const moved = deferred<void>();
  const releaseMove = deferred<void>();
  const inserterEntered = deferred<number>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const inserter = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  let inserterWork: Promise<string | undefined> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`UPDATE public.software_policies SET org_id = ${orgB.id} WHERE id = ${target.id}`;
      moved.resolve();
      await releaseMove.promise;
    });
    await waitForRaceSignal(
      moved.promise,
      holderWork,
      'typed target move holder',
    );
    inserterWork = captureSqlState(() => inserter.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing typed link backend pid');
      inserterEntered.resolve(backend.pid);
      await tx`INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
        VALUES (${parentPolicy.id}, 'software_policy', ${target.id})`;
    }));
    const inserterPid = await waitForRaceSignal(
      inserterEntered.promise,
      inserterWork,
      'typed feature-link inserter',
    );
    await waitForBackendLockWait(inserterPid);
    releaseMove.resolve();
    await holderWork;
    expect(await inserterWork).toBe('23503');
  } finally {
    releaseMove.resolve();
    await Promise.allSettled([holderWork, inserterWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(holder, inserter);
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentPolicy.id));
    await admin.execute(sql`DELETE FROM public.software_policies WHERE id = ${target.id}`);
  }
}, 20_000);

runDb('serializes link UPDATE and DELETE through the statement trigger', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Feature link mutations ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partner.id });
  const [parentPolicy, targetA, targetB] = await admin.insert(configurationPolicies).values([
    { orgId: org.id, name: 'Link mutation parent' },
    { orgId: org.id, name: 'Link mutation target A' },
    { orgId: org.id, name: 'Link mutation target B' },
  ]).returning();
  if (!parentPolicy || !targetA || !targetB) throw new Error('link mutation seed failed');
  try {
    const [link] = await admin.execute<{ id: string }>(sql`
      INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
      VALUES (${parentPolicy.id}, 'automation', ${targetA.id})
      RETURNING id
    `);
    if (!link) throw new Error('link mutation row seed failed');
    const updated = await admin.execute<{ id: string; featurePolicyId: string }>(sql`
      UPDATE public.config_policy_feature_links
      SET feature_policy_id = ${targetB.id}, updated_at = now()
      WHERE id = ${link.id}
      RETURNING id, feature_policy_id AS "featurePolicyId"
    `);
    expect(updated).toEqual([{ id: link.id, featurePolicyId: targetB.id }]);
    const deleted = await admin.execute<{ id: string }>(sql`
      DELETE FROM public.config_policy_feature_links WHERE id = ${link.id} RETURNING id
    `);
    expect(deleted).toEqual([{ id: link.id }]);
  } finally {
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentPolicy.id));
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, targetA.id));
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, targetB.id));
  }
});

runDb('revalidates a descending-UUID bulk physical target statement atomically', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Feature bulk ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const [parentA, parentB] = await admin.insert(configurationPolicies).values([
    { orgId: orgA.id, name: 'Bulk parent A' },
    { orgId: orgA.id, name: 'Bulk parent B' },
  ]).returning();
  if (!parentA || !parentB) throw new Error('bulk parent seed failed');
  const targetLow = '10000000-0000-4000-8000-000000000001';
  const targetHigh = 'f0000000-0000-4000-8000-000000000002';
  try {
    await admin.execute(sql`
      INSERT INTO public.software_policies (id, org_id, partner_id, name, mode, rules)
      VALUES
        (${targetHigh}, ${orgA.id}, NULL, 'Bulk high', 'audit', '{"software":[]}'::jsonb),
        (${targetLow}, ${orgA.id}, NULL, 'Bulk low', 'audit', '{"software":[]}'::jsonb)
    `);
    await admin.execute(sql`
      INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
      VALUES
        (${parentA.id}, 'software_policy', ${targetHigh}),
        (${parentB.id}, 'software_policy', ${targetLow})
    `);
    await expect(admin.execute(sql`
      UPDATE public.software_policies SET org_id = ${orgB.id}
      WHERE id = ANY(ARRAY[${targetHigh}::uuid, ${targetLow}::uuid])
    `)).rejects.toMatchObject({ cause: { code: '23503' } });
    const owners = await admin.execute<{ id: string; orgId: string }>(sql`
      SELECT id, org_id AS "orgId" FROM public.software_policies
      WHERE id = ANY(ARRAY[${targetHigh}::uuid, ${targetLow}::uuid]) ORDER BY id
    `);
    expect(owners).toEqual([
      { id: targetLow, orgId: orgA.id },
      { id: targetHigh, orgId: orgA.id },
    ]);
  } finally {
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentA.id));
    await admin.delete(configurationPolicies).where(eq(configurationPolicies.id, parentB.id));
    await admin.execute(sql`
      DELETE FROM public.software_policies
      WHERE id = ANY(ARRAY[${targetHigh}::uuid, ${targetLow}::uuid])
    `);
  }
});

runDb('serialization migration is idempotent and installs private statement triggers', async () => {
  const admin = getTestDb();
  const migration = readFileSync(SERIALIZATION_MIGRATION_FILE, 'utf8');
  await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
  await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();

  const [catalog] = await admin.execute<{
    triggerCount: number;
    rowTriggerCount: number;
    missingTransitionCount: number;
  }>(sql`
    SELECT count(*)::integer AS "triggerCount",
      count(*) FILTER (WHERE (trigger.tgtype & 1) = 1)::integer AS "rowTriggerCount",
      count(*) FILTER (
        WHERE trigger.tgoldtable IS NULL AND trigger.tgnewtable IS NULL
      )::integer AS "missingTransitionCount"
    FROM pg_catalog.pg_trigger trigger
    WHERE NOT trigger.tgisinternal
      AND trigger.tgname LIKE 'aa_config_policy_feature_ref%'
  `);
  expect(catalog).toEqual({
    triggerCount: 27,
    rowTriggerCount: 0,
    missingTransitionCount: 0,
  });

  const helpers = await admin.execute<{
    name: string;
    securityDefiner: boolean;
    inBodyElevationScope: boolean;
    publicExecute: boolean;
    appExecute: boolean;
  }>(sql`
    SELECT proc.proname AS name,
      proc.prosecdef AS "securityDefiner",
      -- Elevation is in-body (set_config save/restore); the attribute
      -- form needs superuser in prod, so proconfig stays breeze.*-free.
      (proc.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
        AND NOT EXISTS (
          SELECT 1 FROM unnest(proc.proconfig) cfg WHERE cfg LIKE 'breeze.%'
        )) AS "inBodyElevationScope",
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
        ) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS "publicExecute",
      pg_catalog.has_function_privilege('breeze_app', proc.oid, 'EXECUTE') AS "appExecute"
    FROM pg_catalog.pg_proc proc
    WHERE proc.proname IN (
      'breeze_enforce_config_policy_feature_reference_statements',
      'breeze_revalidate_config_policy_feature_reference_policy_statements',
      'breeze_revalidate_config_policy_feature_reference_target_statements',
      'breeze_revalidate_config_policy_feature_reference_org_statements'
    )
    ORDER BY proc.proname
  `);
  expect(helpers).toHaveLength(4);
  expect(helpers).toEqual(helpers.map((helper) => ({
    ...helper,
    securityDefiner: true,
    inBodyElevationScope: true,
    publicExecute: false,
    appExecute: false,
  })));
}, 30_000);
