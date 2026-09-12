import './setup';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  deploymentResults,
  devices,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../../db/schema';
import {
  fingerprintSoftwareInstallMethodDependency,
  fingerprintSoftwareVersionDependency,
} from '../../services/softwareDependencyIdentity';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { buildAndDispatchMock } = vi.hoisted(() => ({
  buildAndDispatchMock: vi.fn(),
}));

vi.mock('../../services/softwareDeployment', () => ({
  buildAndDispatchSoftwareInstalls: (...args: unknown[]) =>
    buildAndDispatchMock(...(args as [])),
}));

import {
  processDueDeployment,
  type DueDeploymentCandidate,
} from '../../jobs/softwareDeploymentScheduler';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const migrationPath = join(
  process.cwd(),
  'migrations/2026-10-15-150020-pin-software-deployment-dependencies.sql',
);

async function seedTargetDevice() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `dependency-pinning-${Date.now()}-${Math.random()}`,
    hostname: 'dependency-pinning-target',
    osType: 'windows',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
  }).returning({ id: devices.id });
  return { org, device: device! };
}

async function insertDeployment(input: {
  orgId: string;
  deviceId: string;
  softwareVersionId?: string;
  installMethodId?: string;
  dependencyFingerprint: string | null;
}): Promise<DueDeploymentCandidate> {
  const [deployment] = await getTestDb().insert(softwareDeployments).values({
    orgId: input.orgId,
    name: 'Approved dependency deployment',
    softwareVersionId: input.softwareVersionId ?? null,
    installMethodId: input.installMethodId ?? null,
    deploymentType: 'install',
    targetType: 'devices',
    targetIds: [input.deviceId],
    scheduleType: 'scheduled',
    scheduledAt: new Date(Date.now() - 60_000),
    options: input.installMethodId ? { versionMode: 'latest' } : null,
    dependencyFingerprint: input.dependencyFingerprint,
    createdBy: null,
  }).returning();
  await getTestDb().insert(deploymentResults).values({
    deploymentId: deployment!.id,
    deviceId: input.deviceId,
    status: 'pending',
  });
  return {
    id: deployment!.id,
    orgId: input.orgId,
    softwareVersionId: input.softwareVersionId ?? null,
    installMethodId: input.installMethodId ?? null,
    scheduleType: 'scheduled',
    scheduledAt: deployment!.scheduledAt,
    options: deployment!.options,
    dependencyFingerprint: input.dependencyFingerprint,
    createdBy: null,
    windowStatus: null,
    windowStartTime: null,
    windowEndTime: null,
  };
}

async function processAsWorker(candidate: DueDeploymentCandidate) {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [role] = await db.execute<{
      roleName: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(sql`
      SELECT current_user AS "roleName", r.rolsuper, r.rolbypassrls
        FROM pg_roles r WHERE r.rolname = current_user`);
    expect(role).toEqual({ roleName: 'breeze_app', rolsuper: false, rolbypassrls: false });
    return processDueDeployment(candidate);
  }));
}

async function resultState(deploymentId: string) {
  const [row] = await getTestDb().execute<{ status: string; errorMessage: string | null }>(sql`
    SELECT status, error_message AS "errorMessage"
      FROM public.deployment_results
     WHERE deployment_id = ${deploymentId}::uuid`);
  return row;
}

describe('software deployment dependency pinning', () => {
  beforeEach(() => {
    buildAndDispatchMock.mockReset();
    buildAndDispatchMock.mockResolvedValue({
      status: 'pending',
      dispatchedDeviceIds: [],
    });
  });

  runDb('keeps the forward migration idempotent and permits legacy null pins', async () => {
    const migration = readFileSync(migrationPath, 'utf8');

    await expect(getTestDb().execute(sql.raw(migration))).resolves.toBeDefined();
    await expect(getTestDb().execute(sql.raw(migration))).resolves.toBeDefined();

    const [shape] = await getTestDb().execute<{
      nullable: string;
      constraintCount: number;
    }>(sql`
      SELECT c.is_nullable AS nullable,
             count(k.conname)::int AS "constraintCount"
        FROM information_schema.columns c
        LEFT JOIN pg_constraint k
          ON k.conrelid = 'public.software_deployments'::regclass
         AND k.conname = 'software_deployments_dependency_fingerprint_chk'
       WHERE c.table_schema = 'public'
         AND c.table_name = 'software_deployments'
         AND c.column_name = 'dependency_fingerprint'
       GROUP BY c.is_nullable`);
    expect(shape).toEqual({ nullable: 'YES', constraintCount: 1 });
  });

  runDb('fails a scheduled checksumless URL dependency closed after catalog mutation', async () => {
    const { org, device } = await seedTargetDevice();
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      orgId: org.id,
      name: 'URL package',
    }).returning();
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId: catalog!.id,
      version: '1.0.0',
      downloadUrl: 'https://approved.example.test/package.exe',
      fileType: 'exe',
      originalFileName: 'package.exe',
      checksum: null,
      silentInstallArgs: '/S',
      detectionRules: null,
    }).returning();
    const approved = fingerprintSoftwareVersionDependency(version!, catalog!);
    const candidate = await insertDeployment({
      orgId: org.id,
      deviceId: device.id,
      softwareVersionId: version!.id,
      dependencyFingerprint: approved,
    });

    await getTestDb().update(softwareVersions).set({
      downloadUrl: 'https://substituted.example.test/package.exe',
    }).where(sql`${softwareVersions.id} = ${version!.id}::uuid`);

    await expect(processAsWorker(candidate)).resolves.toBe(true);
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
    expect(await resultState(candidate.id)).toEqual({
      status: 'failed',
      errorMessage: expect.stringMatching(/dependency changed/i),
    });
  });

  runDb('fails a scheduled package-manager dependency closed after package mutation', async () => {
    const { org, device } = await seedTargetDevice();
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      orgId: org.id,
      name: 'Manager package',
    }).returning();
    const [method] = await getTestDb().insert(softwareInstallMethods).values({
      catalogId: catalog!.id,
      platform: 'windows',
      kind: 'winget',
      packageId: 'Approved.Package',
      enabled: true,
    }).returning();
    const approved = fingerprintSoftwareInstallMethodDependency(method!, catalog!);
    const candidate = await insertDeployment({
      orgId: org.id,
      deviceId: device.id,
      installMethodId: method!.id,
      dependencyFingerprint: approved,
    });

    await getTestDb().update(softwareInstallMethods).set({
      packageId: 'Substituted.Package',
    }).where(sql`${softwareInstallMethods.id} = ${method!.id}::uuid`);

    await expect(processAsWorker(candidate)).resolves.toBe(true);
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
    expect(await resultState(candidate.id)).toEqual({
      status: 'failed',
      errorMessage: expect.stringMatching(/dependency changed/i),
    });
  });

  runDb('dispatches when the approved dependency identity is unchanged', async () => {
    const { org, device } = await seedTargetDevice();
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      orgId: org.id,
      name: 'Unchanged package',
    }).returning();
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId: catalog!.id,
      version: '1.0.0',
      downloadUrl: 'https://approved.example.test/package.exe',
      fileType: 'exe',
      originalFileName: 'package.exe',
      checksum: 'a'.repeat(64),
      silentInstallArgs: '/S',
      detectionRules: null,
    }).returning();
    const candidate = await insertDeployment({
      orgId: org.id,
      deviceId: device.id,
      softwareVersionId: version!.id,
      dependencyFingerprint: fingerprintSoftwareVersionDependency(version!, catalog!),
    });

    await expect(processAsWorker(candidate)).resolves.toBe(true);
    expect(buildAndDispatchMock).toHaveBeenCalledOnce();
    expect(buildAndDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      deploymentId: candidate.id,
      versionRecord: expect.objectContaining({ id: version!.id }),
      deviceIds: [device.id],
    }));
    expect(await resultState(candidate.id)).toEqual({
      status: 'pending',
      errorMessage: null,
    });
  });

  runDb('fails a legacy scheduled deployment without an approved dependency pin closed', async () => {
    const { org, device } = await seedTargetDevice();
    const [catalog] = await getTestDb().insert(softwareCatalog).values({
      orgId: org.id,
      name: 'Legacy package',
    }).returning();
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId: catalog!.id,
      version: '1.0.0',
      downloadUrl: 'https://legacy.example.test/package.exe',
      fileType: 'exe',
      originalFileName: 'package.exe',
      checksum: null,
      silentInstallArgs: '/S',
      detectionRules: null,
    }).returning();
    const candidate = await insertDeployment({
      orgId: org.id,
      deviceId: device.id,
      softwareVersionId: version!.id,
      dependencyFingerprint: null,
    });

    await expect(processAsWorker(candidate)).resolves.toBe(true);
    expect(buildAndDispatchMock).not.toHaveBeenCalled();
    expect(await resultState(candidate.id)).toEqual({
      status: 'failed',
      errorMessage: expect.stringMatching(/predates dependency pinning/i),
    });
  });
});
