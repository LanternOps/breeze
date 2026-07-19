import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const DATABASE_URL_APP = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const GATE_MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-08-01-d-harden-feature-reference-serialization.sql',
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

interface GateTrigger extends Record<string, unknown> {
  tableName: string;
  operation: 'DELETE' | 'INSERT' | 'UPDATE';
  updateColumns: string[];
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => { resolve = res; });
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
    throw new AggregateError(failures, 'failed to close feature-reference gate client(s)');
  }
}

async function waitForAdvisoryGate(backendPid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const [state] = await getTestDb().execute<{
      waiting: boolean;
      classId: string | null;
      objectId: string | null;
      objectSubId: number | null;
    }>(sql`
      SELECT lock.pid IS NOT NULL AS waiting,
        lock.classid::text AS "classId",
        lock.objid::text AS "objectId",
        lock.objsubid AS "objectSubId"
      FROM (SELECT 1) probe
      LEFT JOIN pg_catalog.pg_locks lock
        ON lock.pid = ${backendPid}
       AND lock.locktype = 'advisory'
       AND lock.mode = 'ExclusiveLock'
       AND NOT lock.granted
      LIMIT 1
    `);
    if (state?.waiting) {
      expect(state).toMatchObject({
        classId: '1000302',
        objectId: '2147483648',
        objectSubId: 2,
      });
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`backend ${backendPid} never waited on the feature-reference advisory gate`);
}

async function sqlState(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    const wrapped = error as { code?: string; cause?: { code?: string } };
    return wrapped.cause?.code ?? wrapped.code;
  }
}

const expectedGateTriggers: GateTrigger[] = [
  { tableName: 'alert_rules', operation: 'DELETE', updateColumns: [] },
  { tableName: 'alert_rules', operation: 'UPDATE', updateColumns: ['id', 'org_id', 'partner_id'] },
  { tableName: 'automation_policies', operation: 'DELETE', updateColumns: [] },
  { tableName: 'automation_policies', operation: 'UPDATE', updateColumns: ['id', 'org_id', 'partner_id'] },
  { tableName: 'backup_configs', operation: 'DELETE', updateColumns: [] },
  { tableName: 'backup_configs', operation: 'UPDATE', updateColumns: ['id', 'org_id'] },
  { tableName: 'backup_profiles', operation: 'DELETE', updateColumns: [] },
  { tableName: 'backup_profiles', operation: 'INSERT', updateColumns: [] },
  { tableName: 'backup_profiles', operation: 'UPDATE', updateColumns: ['id', 'org_id', 'partner_id'] },
  { tableName: 'config_policy_backup_settings', operation: 'DELETE', updateColumns: [] },
  { tableName: 'config_policy_backup_settings', operation: 'INSERT', updateColumns: [] },
  {
    tableName: 'config_policy_backup_settings',
    operation: 'UPDATE',
    updateColumns: [
      'id', 'feature_link_id', 'org_id', 'partner_id', 'backup_profile_id', 'destination_config_id',
    ],
  },
  { tableName: 'config_policy_feature_links', operation: 'DELETE', updateColumns: [] },
  { tableName: 'config_policy_feature_links', operation: 'INSERT', updateColumns: [] },
  {
    tableName: 'config_policy_feature_links',
    operation: 'UPDATE',
    updateColumns: ['id', 'config_policy_id', 'feature_type', 'feature_policy_id'],
  },
  { tableName: 'config_policy_onedrive_libraries', operation: 'DELETE', updateColumns: [] },
  { tableName: 'config_policy_onedrive_libraries', operation: 'INSERT', updateColumns: [] },
  {
    tableName: 'config_policy_onedrive_libraries',
    operation: 'UPDATE',
    updateColumns: ['id', 'settings_id', 'org_id'],
  },
  { tableName: 'config_policy_onedrive_settings', operation: 'DELETE', updateColumns: [] },
  { tableName: 'config_policy_onedrive_settings', operation: 'INSERT', updateColumns: [] },
  {
    tableName: 'config_policy_onedrive_settings',
    operation: 'UPDATE',
    updateColumns: ['id', 'feature_link_id', 'org_id'],
  },
  { tableName: 'configuration_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'configuration_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
  { tableName: 'maintenance_windows', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'maintenance_windows',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
  { tableName: 'organizations', operation: 'UPDATE', updateColumns: ['id', 'partner_id'] },
  { tableName: 'patch_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'patch_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'partner_id', 'kind'],
  },
  { tableName: 'peripheral_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'peripheral_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
  { tableName: 'security_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'security_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
  { tableName: 'sensitive_data_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'sensitive_data_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
  { tableName: 'software_policies', operation: 'DELETE', updateColumns: [] },
  {
    tableName: 'software_policies',
    operation: 'UPDATE',
    updateColumns: ['id', 'org_id', 'partner_id'],
  },
];

runDb('takes the gate as breeze_app before target row locking in a link DELETE/target DELETE race', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Gate delete ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partner.id });
  const [parent] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.configuration_policies (org_id, name)
    VALUES (${org.id}, 'Gate delete parent') RETURNING id
  `);
  const [target] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.software_policies (org_id, name, mode, rules)
    VALUES (${org.id}, 'Gate delete target', 'audit', '{"software":[]}'::jsonb)
    RETURNING id
  `);
  if (!parent || !target) throw new Error('gate delete seed failed');
  const [link] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.config_policy_feature_links
      (config_policy_id, feature_type, feature_policy_id)
    VALUES (${parent.id}, 'software_policy', ${target.id}) RETURNING id
  `);
  if (!link) throw new Error('gate delete link seed failed');

  const linkDeleted = deferred<void>();
  const releaseLinkDelete = deferred<void>();
  const targetEntered = deferred<number>();
  const linkWriter = postgres(DATABASE_URL_APP, { max: 1, onnotice: () => {} });
  const targetWriter = postgres(DATABASE_URL_APP, { max: 1, onnotice: () => {} });
  let linkWork: Promise<void> | undefined;
  let targetWork: Promise<string | undefined> | undefined;
  try {
    const [role] = await linkWriter<{ who: string; bypass: boolean }[]>`
      SELECT current_user AS who, rolbypassrls AS bypass
      FROM pg_catalog.pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ who: 'breeze_app', bypass: false });

    linkWork = linkWriter.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
      await tx`DELETE FROM public.config_policy_feature_links WHERE id = ${link.id}`;
      linkDeleted.resolve();
      await releaseLinkDelete.promise;
    });
    await waitForRaceSignal(
      linkDeleted.promise,
      linkWork,
      'feature-link delete holder',
    );
    targetWork = sqlState(() => targetWriter.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('breeze.scope', 'system', true)`;
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing target-delete backend');
      targetEntered.resolve(backend.pid);
      await tx`DELETE FROM public.software_policies WHERE id = ${target.id}`;
    }));
    const targetPid = await waitForRaceSignal(
      targetEntered.promise,
      targetWork,
      'target deleter',
    );
    await waitForAdvisoryGate(targetPid);
    releaseLinkDelete.resolve();
    await linkWork;
    expect(await targetWork, 'the race must neither deadlock (40P01) nor reject').toBeUndefined();

    const [finalState] = await admin.execute<{ links: number; targets: number }>(sql`
      SELECT
        (SELECT count(*)::integer FROM public.config_policy_feature_links WHERE id = ${link.id}) AS links,
        (SELECT count(*)::integer FROM public.software_policies WHERE id = ${target.id}) AS targets
    `);
    expect(finalState).toEqual({ links: 0, targets: 0 });
  } finally {
    releaseLinkDelete.resolve();
    await Promise.allSettled([linkWork, targetWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(linkWriter, targetWriter);
  }
}, 20_000);

runDb('serializes reverse writes to sensitive-data candidates with one UUID', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Gate sensitive ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const candidateId = '10000000-0000-4000-8000-000000000031';
  const [parent] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.configuration_policies (org_id, name)
    VALUES (${orgA.id}, 'Sensitive gate parent') RETURNING id
  `);
  if (!parent) throw new Error('sensitive gate parent seed failed');
  await admin.execute(sql`
    INSERT INTO public.configuration_policies (id, org_id, name)
    VALUES (${candidateId}, ${orgA.id}, 'Sensitive fallback')
  `);
  await admin.execute(sql`
    INSERT INTO public.sensitive_data_policies (id, org_id, name)
    VALUES (${candidateId}, ${orgA.id}, 'Sensitive physical')
  `);
  await admin.execute(sql`
    INSERT INTO public.config_policy_feature_links
      (config_policy_id, feature_type, feature_policy_id)
    VALUES (${parent.id}, 'sensitive_data', ${candidateId})
  `);

  const firstMoved = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondEntered = deferred<number>();
  const first = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const second = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let firstWork: Promise<void> | undefined;
  let secondWork: Promise<string | undefined> | undefined;
  try {
    firstWork = first.begin(async (tx) => {
      await tx`UPDATE public.sensitive_data_policies SET org_id = ${orgB.id}
        WHERE id = ${candidateId}`;
      firstMoved.resolve();
      await releaseFirst.promise;
    });
    await waitForRaceSignal(
      firstMoved.promise,
      firstWork,
      'sensitive-data mover',
    );
    secondWork = sqlState(() => second.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing sensitive fallback backend');
      secondEntered.resolve(backend.pid);
      await tx`UPDATE public.configuration_policies SET org_id = ${orgB.id}
        WHERE id = ${candidateId}`;
    }));
    const secondPid = await waitForRaceSignal(
      secondEntered.promise,
      secondWork,
      'sensitive-data fallback mover',
    );
    await waitForAdvisoryGate(secondPid);
    releaseFirst.resolve();
    await firstWork;
    expect(await secondWork).toBe('23503');
    const [validity] = await admin.execute<{ valid: boolean }>(sql`
      SELECT public.breeze_config_policy_feature_reference_is_valid(
        ${parent.id}, 'sensitive_data', ${candidateId}
      ) AS valid
    `);
    expect(validity?.valid).toBe(true);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([firstWork, secondWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(first, second);
  }
}, 20_000);

runDb('serializes backup profile removal against its same-UUID legacy candidate move', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Gate backup ${randomUUID()}` });
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const candidateId = 'f0000000-0000-4000-8000-000000000032';
  const [parent] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.configuration_policies (org_id, name)
    VALUES (${orgA.id}, 'Backup gate parent') RETURNING id
  `);
  if (!parent) throw new Error('backup gate parent seed failed');
  await admin.execute(sql`
    INSERT INTO public.backup_profiles (id, org_id, name, selections)
    VALUES (${candidateId}, ${orgA.id}, 'Backup profile candidate', '{}'::jsonb)
  `);
  await admin.execute(sql`
    INSERT INTO public.backup_configs
      (id, org_id, name, type, provider, provider_config)
    VALUES (${candidateId}, ${orgA.id}, 'Backup legacy candidate', 'file', 's3', '{}'::jsonb)
  `);
  const [link] = await admin.transaction(async (tx) => {
    const [createdLink] = await tx.execute<{ id: string }>(sql`
      INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
      VALUES (${parent.id}, 'backup', ${candidateId}) RETURNING id
    `);
    if (!createdLink) throw new Error('backup gate link seed failed');
    await tx.execute(sql`
      INSERT INTO public.config_policy_backup_settings
        (feature_link_id, org_id, backup_profile_id)
      VALUES (${createdLink.id}, ${orgA.id}, ${candidateId})
    `);
    return [createdLink];
  });
  if (!link) throw new Error('backup gate transaction seed failed');

  const profileRemoved = deferred<void>();
  const releaseRemoval = deferred<void>();
  const legacyEntered = deferred<number>();
  const first = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const second = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let firstWork: Promise<void> | undefined;
  let secondWork: Promise<string | undefined> | undefined;
  try {
    firstWork = first.begin(async (tx) => {
      await tx`UPDATE public.config_policy_backup_settings
        SET backup_profile_id = NULL, destination_config_id = ${candidateId}
        WHERE feature_link_id = ${link.id}`;
      await tx`DELETE FROM public.backup_profiles WHERE id = ${candidateId}`;
      profileRemoved.resolve();
      await releaseRemoval.promise;
    });
    await waitForRaceSignal(
      profileRemoved.promise,
      firstWork,
      'backup-profile removal holder',
    );
    secondWork = sqlState(() => second.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      if (!backend) throw new Error('missing legacy backup backend');
      legacyEntered.resolve(backend.pid);
      await tx`UPDATE public.backup_configs SET org_id = ${orgB.id}
        WHERE id = ${candidateId}`;
    }));
    const legacyPid = await waitForRaceSignal(
      legacyEntered.promise,
      secondWork,
      'legacy backup mover',
    );
    await waitForAdvisoryGate(legacyPid);
    releaseRemoval.resolve();
    await firstWork;
    expect(await secondWork).toBe('23503');

    const [validity] = await admin.execute<{ featureValid: boolean; parityValid: boolean }>(sql`
      SELECT public.breeze_config_policy_feature_reference_is_valid(
          ${parent.id}, 'backup', ${candidateId}
        ) AS "featureValid",
        public.breeze_backup_feature_settings_parity_is_valid(${link.id}) AS "parityValid"
    `);
    expect(validity).toEqual({ featureValid: true, parityValid: true });
  } finally {
    releaseRemoval.resolve();
    await Promise.allSettled([firstWork, secondWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(first, second);
  }
}, 20_000);

for (const scenario of [
  {
    name: 'low-to-high UUID retarget against target DELETE',
    oldTargetId: '10000000-0000-4000-8000-000000000041',
    newTargetId: 'f0000000-0000-4000-8000-000000000042',
    targetOperation: 'DELETE' as const,
  },
  {
    name: 'high-to-low UUID retarget against target owner UPDATE',
    oldTargetId: 'f0000000-0000-4000-8000-000000000043',
    newTargetId: '10000000-0000-4000-8000-000000000044',
    targetOperation: 'UPDATE' as const,
  },
]) {
  runDb(`serializes a ${scenario.name}`, async () => {
    const admin = getTestDb();
    const partner = await createPartner({ name: `Gate retarget ${randomUUID()}` });
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const [parent] = await admin.execute<{ id: string }>(sql`
      INSERT INTO public.configuration_policies (org_id, name)
      VALUES (${orgA.id}, 'Gate retarget parent') RETURNING id
    `);
    await admin.execute(sql`
      INSERT INTO public.software_policies (id, org_id, name, mode, rules)
      VALUES
        (${scenario.oldTargetId}, ${orgA.id}, 'Gate old target', 'audit', '{"software":[]}'::jsonb),
        (${scenario.newTargetId}, ${orgA.id}, 'Gate new target', 'audit', '{"software":[]}'::jsonb)
    `);
    if (!parent) throw new Error('retarget seed failed');
    const [link] = await admin.execute<{ id: string }>(sql`
      INSERT INTO public.config_policy_feature_links
        (config_policy_id, feature_type, feature_policy_id)
      VALUES (${parent.id}, 'software_policy', ${scenario.oldTargetId}) RETURNING id
    `);
    if (!link) throw new Error('retarget link seed failed');

    const retargeted = deferred<void>();
    const releaseRetarget = deferred<void>();
    const targetEntered = deferred<number>();
    const first = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const second = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let firstWork: Promise<void> | undefined;
    let secondWork: Promise<string | undefined> | undefined;
    try {
      firstWork = first.begin(async (tx) => {
        await tx`UPDATE public.config_policy_feature_links
          SET feature_policy_id = ${scenario.newTargetId} WHERE id = ${link.id}`;
        retargeted.resolve();
        await releaseRetarget.promise;
      });
      await waitForRaceSignal(
        retargeted.promise,
        firstWork,
        'feature-link retarget holder',
      );
      secondWork = sqlState(() => second.begin(async (tx) => {
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
        if (!backend) throw new Error('missing retarget target backend');
        targetEntered.resolve(backend.pid);
        if (scenario.targetOperation === 'DELETE') {
          await tx`DELETE FROM public.software_policies WHERE id = ${scenario.newTargetId}`;
        } else {
          await tx`UPDATE public.software_policies SET org_id = ${orgB.id}
            WHERE id = ${scenario.newTargetId}`;
        }
      }));
      const targetPid = await waitForRaceSignal(
        targetEntered.promise,
        secondWork,
        'retarget target writer',
      );
      await waitForAdvisoryGate(targetPid);
      releaseRetarget.resolve();
      await firstWork;
      expect(await secondWork).toBe('23503');

      const [persisted] = await admin.execute<{ targetId: string; valid: boolean }>(sql`
        SELECT link.feature_policy_id AS "targetId",
          public.breeze_config_policy_feature_reference_is_valid(
            link.config_policy_id, link.feature_type, link.feature_policy_id
          ) AS valid
        FROM public.config_policy_feature_links link WHERE link.id = ${link.id}
      `);
      expect(persisted).toEqual({ targetId: scenario.newTargetId, valid: true });
    } finally {
      releaseRetarget.resolve();
      await Promise.allSettled([firstWork, secondWork].filter(Boolean) as Promise<unknown>[]);
      await closeRaceClients(first, second);
    }
  }, 20_000);
}

runDb('does not collide with the adjacent advisory-lock namespace', async () => {
  const admin = getTestDb();
  const partner = await createPartner({ name: `Gate namespace ${randomUUID()}` });
  const org = await createOrganization({ partnerId: partner.id });
  const [target] = await admin.execute<{ id: string }>(sql`
    INSERT INTO public.software_policies (org_id, name, mode, rules)
    VALUES (${org.id}, 'Gate namespace target', 'audit', '{"software":[]}'::jsonb)
    RETURNING id
  `);
  if (!target) throw new Error('namespace target seed failed');

  const adjacentLocked = deferred<void>();
  const releaseAdjacent = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const writer = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  let writerWork: Promise<string | undefined> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(1000301, -2147483648)`;
      adjacentLocked.resolve();
      await releaseAdjacent.promise;
    });
    await waitForRaceSignal(
      adjacentLocked.promise,
      holderWork,
      'adjacent-namespace lock holder',
    );
    writerWork = sqlState(() => writer.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '750ms'`;
      await tx`UPDATE public.software_policies SET org_id = org_id WHERE id = ${target.id}`;
    }));
    expect(await writerWork).toBeUndefined();
  } finally {
    releaseAdjacent.resolve();
    await Promise.allSettled([holderWork, writerWork].filter(Boolean) as Promise<unknown>[]);
    await closeRaceClients(holder, writer);
  }
}, 20_000);

runDb('reapplies idempotently and installs the exact private BEFORE STATEMENT gate set', async () => {
  const admin = getTestDb();
  const migration = readFileSync(GATE_MIGRATION_FILE, 'utf8');
  await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();
  await expect(admin.execute(sql.raw(migration))).resolves.toBeDefined();

  const triggers = await admin.execute<GateTrigger & {
    beforeStatement: boolean;
    enabled: string;
    helper: string;
  }>(sql`
    SELECT relation.relname AS "tableName",
      CASE
        WHEN (trigger.tgtype & 4) = 4 THEN 'INSERT'
        WHEN (trigger.tgtype & 8) = 8 THEN 'DELETE'
        ELSE 'UPDATE'
      END AS operation,
      COALESCE(
        array_agg(attribute.attname ORDER BY selected.ordinality)
          FILTER (WHERE attribute.attname IS NOT NULL),
        ARRAY[]::text[]
      ) AS "updateColumns",
      ((trigger.tgtype & 1) = 0 AND (trigger.tgtype & 2) = 2) AS "beforeStatement",
      trigger.tgenabled AS enabled,
      proc.proname AS helper
    FROM pg_catalog.pg_trigger trigger
    JOIN pg_catalog.pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc proc ON proc.oid = trigger.tgfoid
    LEFT JOIN LATERAL unnest(trigger.tgattr::smallint[]) WITH ORDINALITY
      selected(attnum, ordinality) ON true
    LEFT JOIN pg_catalog.pg_attribute attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum = selected.attnum
    WHERE namespace.nspname = 'public'
      AND trigger.tgname LIKE 'aaa_feature_reference_gate_%'
      AND NOT trigger.tgisinternal
    GROUP BY relation.relname, trigger.tgtype, trigger.tgenabled, proc.proname
    ORDER BY relation.relname, operation
  `);
  expect(triggers.map(({ tableName, operation, updateColumns }) => ({
    tableName, operation, updateColumns,
  }))).toEqual(expectedGateTriggers);
  expect(triggers).toHaveLength(36);
  expect(triggers.every((trigger) =>
    trigger.beforeStatement
    && trigger.enabled === 'O'
    && trigger.helper === 'breeze_feature_reference_integrity_gate'
  )).toBe(true);

  const [helper] = await admin.execute<{
    schemaName: string;
    securityDefiner: boolean;
    inBodyElevationConfiguration: boolean;
    exactGate: boolean;
    publicExecute: boolean;
    appExecute: boolean;
  }>(sql`
    SELECT namespace.nspname AS "schemaName",
      proc.prosecdef AS "securityDefiner",
      -- The gate takes only an advisory lock and reads no RLS-governed
      -- rows, so it carries no breeze.* elevation at all (the attribute form
      -- needs superuser in prod).
      (proc.proconfig @> ARRAY['search_path=pg_catalog, public']::text[]
        AND NOT EXISTS (
          SELECT 1 FROM unnest(proc.proconfig) cfg WHERE cfg LIKE 'breeze.%'
        )) AS "inBodyElevationConfiguration",
      proc.prosrc LIKE '%pg_catalog.pg_advisory_xact_lock(1000302, -2147483648)%' AS "exactGate",
      EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(
          COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
        ) privilege
        WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
      ) AS "publicExecute",
      pg_catalog.has_function_privilege('breeze_app', proc.oid, 'EXECUTE') AS "appExecute"
    FROM pg_catalog.pg_proc proc
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
    WHERE namespace.nspname = 'public'
      AND proc.proname = 'breeze_feature_reference_integrity_gate'
      AND proc.pronargs = 0
  `);
  expect(helper).toEqual({
    schemaName: 'public',
    securityDefiner: true,
    inBodyElevationConfiguration: true,
    exactGate: true,
    publicExecute: false,
    appExecute: false,
  });
}, 30_000);
