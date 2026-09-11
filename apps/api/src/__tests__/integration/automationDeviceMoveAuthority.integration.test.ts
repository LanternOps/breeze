/**
 * Real-PostgreSQL proof for the pre-command device-move boundary. All targets,
 * commands and tenants are synthetic; no agent socket or provider is used.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import {
  automationActionResults,
  automationResourceBindings,
  automationRunDeviceResults,
  automationRuns,
  automations,
  cisRemediationActions,
  deviceCommands,
  devices,
  deploymentResults,
  organizations,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../../db/schema';
import {
  configPolicyAutomations,
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema/configurationPolicies';
import {
  executeAutomationRun,
  executeConfigPolicyAutomationRun,
  __testOnly as automationRuntimeTestOnly,
} from '../../services/automationRuntime';
import { __testOnly as cisJobsTestOnly } from '../../jobs/cisJobs';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';
import {
  createOrganization,
  createPartner,
  createSite,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function waitForAdvisoryLockWaiter(tx: ReturnType<typeof getTestDb>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND NOT granted
      ) AS blocked
    `) as unknown as Array<{ blocked: boolean }>;
    if (result[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the dispatch advisory-lock waiter');
}

async function createDeployTarget(orgId: string) {
  const adminDb = getTestDb();
  const [catalog] = await adminDb.insert(softwareCatalog).values({
    orgId,
    partnerId: null,
    name: `Synthetic authority package ${randomUUID()}`,
  }).returning();
  await adminDb.insert(softwareVersions).values({
    catalogId: catalog!.id,
    version: '1.0.0',
    downloadUrl: 'https://example.invalid/authority-package.test',
    supportedOs: ['linux'],
    isLatest: true,
  });
  return catalog!;
}

async function bindDeployTarget(args: {
  automationId: string;
  ownerOrgId: string | null;
  ownerPartnerId: string | null;
  resourceOrgId: string;
  catalogId: string;
}) {
  await getTestDb().insert(automationResourceBindings).values({
    automationId: args.automationId,
    orgId: args.ownerOrgId,
    partnerId: args.ownerPartnerId,
    resourceKind: 'software_catalog',
    resourceId: args.catalogId,
    expectedResourceOrgId: args.resourceOrgId,
    expectedResourcePartnerId: null,
    expectedResourceIsSystem: false,
    state: 'active',
  });
}

describe('automation and CIS pre-command authority across device org moves', () => {
  runDb('denies the moved target, preserves an allowed control, and cancels CIS before child restamp', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const sourceOrg = await createOrganization({ partnerId: partner.id });
    const destinationOrg = await createOrganization({ partnerId: partner.id });
    const sourceSite = await createSite({ orgId: sourceOrg.id });
    const destinationSite = await createSite({ orgId: destinationOrg.id });

    const [allowedDevice, movedDevice] = await adminDb.insert(devices).values([
      {
        orgId: sourceOrg.id,
        siteId: sourceSite.id,
        agentId: `authority-allowed-${randomUUID()}`,
        hostname: 'authority-allowed',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
      {
        orgId: sourceOrg.id,
        siteId: sourceSite.id,
        agentId: `authority-moved-${randomUUID()}`,
        hostname: 'authority-moved',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
    ]).returning();

    const [automation] = await adminDb.insert(automations).values({
      orgId: sourceOrg.id,
      partnerId: null,
      name: `Source authority automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [allowedDevice!.id, movedDevice!.id] },
      actions: [{ type: 'execute_command', command: 'synthetic-authority-control' }],
      onFailure: 'stop',
    }).returning();
    const [run] = await adminDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'authority-integration',
      status: 'running',
      devicesTargeted: 2,
    }).returning();
    const [cisAction] = await adminDb.insert(cisRemediationActions).values({
      orgId: sourceOrg.id,
      deviceId: movedDevice!.id,
      checkId: 'authority.synthetic',
      action: 'synthetic',
      status: 'queued',
      approvalStatus: 'approved',
      details: { synthetic: true },
    }).returning();

    // Exercise the database trigger path directly, not only the HTTP route.
    await adminDb.update(devices).set({
      orgId: destinationOrg.id,
      siteId: destinationSite.id,
    }).where(eq(devices.id, movedDevice!.id));

    const outcome = await withSystemDbAccessContext(() => executeAutomationRun(
      run!.id,
      [allowedDevice!.id, movedDevice!.id],
    ));
    expect(outcome.status).toBe('running');

    const commands = await adminDb
      .select({ deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(inArray(deviceCommands.deviceId, [allowedDevice!.id, movedDevice!.id]));
    expect(commands).toEqual([{ deviceId: allowedDevice!.id }]);

    // The denied target does NOT vanish. `devices_targeted` counted it, so it
    // must be visible in the run with a terminal failed row naming the reason —
    // a silently-missing device is indistinguishable from the bug.
    const deviceResults = await adminDb
      .select({
        deviceId: automationRunDeviceResults.deviceId,
        status: automationRunDeviceResults.status,
        error: automationRunDeviceResults.error,
      })
      .from(automationRunDeviceResults)
      .where(eq(automationRunDeviceResults.runId, run!.id));
    const actionResults = await adminDb
      .select({ deviceId: automationActionResults.deviceId })
      .from(automationActionResults)
      .where(eq(automationActionResults.runId, run!.id));
    expect(deviceResults).toHaveLength(2);
    expect(deviceResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: allowedDevice!.id }),
      expect.objectContaining({
        deviceId: movedDevice!.id,
        status: 'failed',
        error: expect.stringContaining('no longer belongs'),
      }),
    ]));
    // A denied target is denied BEFORE any action sink, so it has no per-action
    // rows at all — only the device-level failure above.
    expect(actionResults).toEqual([{ deviceId: allowedDevice!.id }]);

    // A partner-owned automation retains authority when the same device moves
    // between two CURRENT member organizations of that partner. This positive
    // control proves the repair follows the durable owner boundary rather than
    // treating every org change as a blanket denial.
    const [partnerAutomation] = await adminDb.insert(automations).values({
      orgId: null,
      partnerId: partner.id,
      name: `Partner authority automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [movedDevice!.id] },
      actions: [{ type: 'execute_command', command: 'synthetic-partner-authority-control' }],
      onFailure: 'stop',
    }).returning();
    const [partnerRun] = await adminDb.insert(automationRuns).values({
      automationId: partnerAutomation!.id,
      triggeredBy: 'authority-partner-integration',
      status: 'running',
      devicesTargeted: 1,
    }).returning();
    await withSystemDbAccessContext(() => executeAutomationRun(
      partnerRun!.id,
      [movedDevice!.id],
    ));
    const partnerCommands = await adminDb
      .select({ deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, movedDevice!.id));
    expect(partnerCommands).toEqual([{ deviceId: movedDevice!.id }]);

    const [cancelled] = await adminDb
      .select({
        orgId: cisRemediationActions.orgId,
        status: cisRemediationActions.status,
        details: cisRemediationActions.details,
      })
      .from(cisRemediationActions)
      .where(eq(cisRemediationActions.id, cisAction!.id));
    expect(cancelled).toMatchObject({
      orgId: destinationOrg.id,
      status: 'cancelled',
      details: expect.objectContaining({ cancelledReason: 'device_org_changed_before_dispatch' }),
    });
  }, 30_000);

  runDb('move lock wins against automation and CIS dispatch, denying both before command creation', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const sourceOrg = await createOrganization({ partnerId: partner.id });
    const destinationOrg = await createOrganization({ partnerId: partner.id });
    const sourceSite = await createSite({ orgId: sourceOrg.id });
    const destinationSite = await createSite({ orgId: destinationOrg.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `authority-race-${randomUUID()}`,
      hostname: 'authority-race',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
    }).returning();
    const [action] = await adminDb.insert(cisRemediationActions).values({
      orgId: sourceOrg.id,
      deviceId: device!.id,
      checkId: 'authority.race',
      action: 'synthetic',
      status: 'queued',
      approvalStatus: 'approved',
      details: { synthetic: true },
    }).returning();
    const [automation] = await adminDb.insert(automations).values({
      orgId: sourceOrg.id,
      partnerId: null,
      name: `Move-wins automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [{ type: 'execute_command', command: 'synthetic-move-wins' }],
      onFailure: 'stop',
    }).returning();
    let workerPromise!: ReturnType<typeof cisJobsTestOnly.processRemediationAction>;
    let automationAuthorityPromise!: ReturnType<
      typeof automationRuntimeTestOnly.lockCurrentAutomationTargetDevices
    >;
    await adminDb.transaction(async (tx) => {
      await tx.select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, device!.id))
        .for('update');

      workerPromise = cisJobsTestOnly.processRemediationAction({
        type: 'remediate-action',
        actionId: action!.id,
      });
      automationAuthorityPromise = withSystemDbAccessContext(() =>
        automationRuntimeTestOnly.lockCurrentAutomationTargetDevices(automation!, [device!.id]));
      const early = await Promise.race([
        Promise.all([workerPromise, automationAuthorityPromise]).then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(early).toBe('blocked');

      await tx.update(devices).set({
        orgId: destinationOrg.id,
        siteId: destinationSite.id,
      }).where(eq(devices.id, device!.id));
    });

    expect(await workerPromise).toEqual({
      actionId: action!.id,
      queued: false,
      commandId: null,
    });
    expect(await automationAuthorityPromise).toEqual([]);
    const commands = await adminDb
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device!.id));
    expect(commands).toEqual([]);
    const [cancelled] = await adminDb
      .select({ status: cisRemediationActions.status, orgId: cisRemediationActions.orgId })
      .from(cisRemediationActions)
      .where(eq(cisRemediationActions.id, action!.id));
    expect(cancelled).toEqual({ status: 'cancelled', orgId: destinationOrg.id });
  }, 30_000);

  runDb('deploy sink lock wins before a concurrent move and commits against the source owner', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const sourceOrg = await createOrganization({ partnerId: partner.id });
    const destinationOrg = await createOrganization({ partnerId: partner.id });
    const sourceSite = await createSite({ orgId: sourceOrg.id });
    const destinationSite = await createSite({ orgId: destinationOrg.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `authority-sink-wins-${randomUUID()}`,
      hostname: 'authority-sink-wins',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
    }).returning();
    const catalog = await createDeployTarget(sourceOrg.id);
    const [automation] = await adminDb.insert(automations).values({
      orgId: sourceOrg.id,
      partnerId: null,
      name: `Sink-wins automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [{ type: 'deploy_software', catalogId: catalog.id }],
      onFailure: 'stop',
    }).returning();
    await bindDeployTarget({
      automationId: automation!.id,
      ownerOrgId: sourceOrg.id,
      ownerPartnerId: null,
      resourceOrgId: sourceOrg.id,
      catalogId: catalog.id,
    });
    const [run] = await adminDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'authority-sink-wins',
      status: 'running',
      devicesTargeted: 1,
    }).returning();

    await adminDb.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION public.test_block_deployment_result_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(118001);
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_block_deployment_result_insert ON public.deployment_results;
      CREATE TRIGGER test_block_deployment_result_insert
      BEFORE INSERT ON public.deployment_results
      FOR EACH ROW
      WHEN (NEW.device_id = '${device!.id}'::uuid)
      EXECUTE FUNCTION public.test_block_deployment_result_insert();
    `));

    let dispatchPromise!: ReturnType<typeof executeAutomationRun>;
    let movePromise!: Promise<unknown>;
    try {
      await adminDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(118001)`);
        dispatchPromise = withSystemDbAccessContext(() => executeAutomationRun(run!.id, [device!.id]));
        await waitForAdvisoryLockWaiter(tx as unknown as ReturnType<typeof getTestDb>);

        movePromise = adminDb.update(devices).set({
          orgId: destinationOrg.id,
          siteId: destinationSite.id,
        }).where(eq(devices.id, device!.id));
        const moveState = await Promise.race([
          movePromise.then(() => 'settled' as const),
          new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
        ]);
        expect(moveState).toBe('blocked');
      });

      await dispatchPromise;
      await movePromise;
      const commands = await adminDb
        .select({ deviceId: deviceCommands.deviceId })
        .from(deviceCommands)
        .where(eq(deviceCommands.deviceId, device!.id));
      expect(commands).toEqual([{ deviceId: device!.id }]);
      const results = await adminDb.select({ deviceId: deploymentResults.deviceId })
        .from(deploymentResults)
        .where(eq(deploymentResults.deviceId, device!.id));
      expect(results).toEqual([{ deviceId: device!.id }]);
    } finally {
      await adminDb.execute(sql.raw(`
        DROP TRIGGER IF EXISTS test_block_deployment_result_insert ON public.deployment_results;
        DROP FUNCTION IF EXISTS public.test_block_deployment_result_insert();
      `));
    }
  }, 30_000);

  runDb('standalone deploy_software completes while holding the current-owner lock', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `authority-deploy-positive-${randomUUID()}`,
      hostname: 'authority-deploy-positive',
      osType: 'linux', osVersion: 'test', architecture: 'amd64', agentVersion: 'test', status: 'online',
    }).returning();
    const catalog = await createDeployTarget(org.id);
    const [automation] = await adminDb.insert(automations).values({
      orgId: org.id,
      partnerId: null,
      name: `Deploy authority positive ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [{ type: 'deploy_software', catalogId: catalog.id }],
      onFailure: 'stop',
    }).returning();
    await bindDeployTarget({
      automationId: automation!.id,
      ownerOrgId: org.id,
      ownerPartnerId: null,
      resourceOrgId: org.id,
      catalogId: catalog.id,
    });
    const [run] = await adminDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'authority-deploy-positive',
      status: 'running',
      devicesTargeted: 1,
    }).returning();

    const outcome = await withSystemDbAccessContext(() => executeAutomationRun(run!.id, [device!.id]));
    expect(outcome.status).toBe('running');
    const deployments = await adminDb.select({ id: softwareDeployments.id, orgId: softwareDeployments.orgId })
      .from(softwareDeployments)
      .where(eq(softwareDeployments.orgId, org.id));
    expect(deployments).toHaveLength(1);
    const results = await adminDb.select({ deviceId: deploymentResults.deviceId })
      .from(deploymentResults)
      .where(eq(deploymentResults.deploymentId, deployments[0]!.id));
    expect(results).toEqual([{ deviceId: device!.id }]);
    const commands = await adminDb.select({ deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device!.id));
    expect(commands).toEqual([{ deviceId: device!.id }]);
  }, 30_000);

  runDb('rechecks and locks current partner membership before dispatch', async () => {
    const adminDb = getTestDb();
    const sourcePartner = await createPartner();
    const destinationPartner = await createPartner();
    const org = await createOrganization({ partnerId: sourcePartner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `authority-partner-move-${randomUUID()}`,
      hostname: 'authority-partner-move',
      osType: 'linux', osVersion: 'test', architecture: 'amd64', agentVersion: 'test', status: 'online',
    }).returning();
    const [automation] = await adminDb.insert(automations).values({
      orgId: null,
      partnerId: sourcePartner.id,
      name: `Partner membership automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [{ type: 'execute_command', command: 'synthetic-partner-move' }],
      onFailure: 'stop',
    }).returning();
    const [run] = await adminDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'authority-partner-move',
      status: 'running',
      devicesTargeted: 1,
    }).returning();

    let dispatchSettled!: Promise<{ error?: unknown }>;
    await adminDb.transaction(async (tx) => {
      await tx.select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, org.id))
        .for('update');
      await tx.update(organizations)
        .set({ partnerId: destinationPartner.id })
        .where(eq(organizations.id, org.id));

      dispatchSettled = withSystemDbAccessContext(() => executeAutomationRun(run!.id, [device!.id])).then(
        () => ({}),
        (error: unknown) => ({ error }),
      );
      const early = await Promise.race([
        dispatchSettled.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100)),
      ]);
      expect(early).toBe('blocked');
    });

    const outcome = await dispatchSettled;
    expect(outcome.error).toBeUndefined();
    const commands = await adminDb.select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(eq(deviceCommands.deviceId, device!.id));
    expect(commands).toEqual([]);
  }, 30_000);

  // ==========================================================================
  // SEC-118 review blocker 1 — cross-org LOCK ORDER (#3778)
  // ==========================================================================
  //
  // The repo-wide order for anything that spans organizations is
  // `organizations FOR SHARE (ascending) -> devices -> children`
  // (services/orgCurrencyCore.ts's readOrgStampingDefaultsMany, used by
  // routes/devices/moveOrg.ts and services/ticketService.ts). The first cut of
  // this fix locked devices FIRST and organizations SECOND for partner-owned
  // automations, which is the AB-BA Postgres resolves by killing one side with
  // 40P01: a partner automation dispatching while one of its own targets is
  // being moved would abort at random.
  //
  // This test pins the ORDER itself rather than hoping a race reproduces. A
  // third transaction holds the device's organization in a mode that conflicts
  // with FOR SHARE; the dispatch must then be blocked on the ORGANIZATION and
  // must NOT yet hold the device row. Under the inverted order the device lock
  // is taken first and the `FOR UPDATE` probe below blocks instead of
  // returning.
  runDb('takes organizations before devices, so a concurrent move cannot deadlock it', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `authority-order-${randomUUID()}`,
      hostname: 'authority-order',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
    }).returning();
    const [automation] = await adminDb.insert(automations).values({
      orgId: null,
      partnerId: partner.id,
      name: `Lock-order automation ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [{ type: 'execute_command', command: 'synthetic-lock-order' }],
      onFailure: 'stop',
    }).returning();

    let authorityPromise!: Promise<unknown>;
    let releaseAuthority!: () => void;
    const authorityHeld = new Promise<void>((resolve) => { releaseAuthority = resolve; });

    await adminDb.transaction(async (blocker) => {
      // Conflicts with the dispatch's `organizations FOR SHARE`.
      await blocker.select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, org.id))
        .for('no key update');

      authorityPromise = withSystemDbAccessContext(async () => {
        const locked = await automationRuntimeTestOnly
          .lockCurrentAutomationTargetDevices(automation!, [device!.id]);
        // Hold the authority transaction open so the probe below observes the
        // locks it actually took, not the locks it released at commit.
        await authorityHeld;
        return locked;
      });

      // 1. The dispatch is stuck. (On the organization — proven by 2.)
      const early = await Promise.race([
        authorityPromise.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 400)),
      ]);
      expect(early).toBe('blocked');

      // 2. ...and it holds NO lock on the device row: an independent
      //    transaction can still take `devices FOR UPDATE` immediately. This is
      //    the assertion that fails under the inverted (devices-first) order.
      const probe = adminDb.transaction(async (tx) => {
        await tx.select({ id: devices.id })
          .from(devices)
          .where(eq(devices.id, device!.id))
          .for('update');
        return 'acquired' as const;
      });
      const probeOutcome = await Promise.race([
        probe,
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2_000)),
      ]);
      expect(probeOutcome).toBe('acquired');
    });

    releaseAuthority();
    // Once the organization lock is released the dispatch completes normally
    // and still admits its own partner's device.
    const locked = await authorityPromise as Array<{ id: string }>;
    expect(locked.map((row) => row.id)).toEqual([device!.id]);
  }, 30_000);

  // End-to-end form of the same blocker: the REAL `POST /devices/:id/move-org`
  // route running concurrently with a partner-owned dispatch of that exact
  // device. Either order is acceptable — the move may win or the dispatch may
  // win — but neither side may abort with a deadlock (40P01).
  //
  // HONEST LIMIT: this is a regression NET, not the discriminating control.
  // Measured against the inverted (devices-first) order it does not reliably go
  // red — six attempts produced no 40P01 in one run — because the interleaving
  // the deadlock needs (dispatch holds the device, move holds the orgs, each
  // then wants the other's) depends on where the scheduler happens to land. The
  // deterministic proof of the lock order is the test above; this one exists to
  // catch a regression that shows up under real concurrency rather than under a
  // hand-built lock sequence, and to prove a losing dispatch loses CLOSED.
  runDb('never deadlocks a partner-owned dispatch against the real move-org route', async () => {
    const adminDb = getTestDb();
    const env = await setupTestEnvironment({ scope: 'partner' });
    const { partner, organization: sourceOrg, site: sourceSite, user, role } = env;
    const destinationOrg = await createOrganization({ partnerId: partner.id });
    const destinationSite = await createSite({ orgId: destinationOrg.id });

    const token = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: 'sec118-deadlock-session',
    });
    const app = new Hono();
    app.route('/devices', moveOrgRoutes);

    const deadlocks: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const [device] = await adminDb.insert(devices).values({
        orgId: sourceOrg.id,
        siteId: sourceSite.id,
        agentId: `authority-deadlock-${randomUUID()}`,
        hostname: `authority-deadlock-${attempt}`,
        osType: 'linux',
        osVersion: 'test',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      }).returning();
      const [automation] = await adminDb.insert(automations).values({
        orgId: null,
        partnerId: partner.id,
        name: `Deadlock automation ${randomUUID()}`,
        trigger: { type: 'manual' },
        conditions: { type: 'devices', deviceIds: [device!.id] },
        actions: [{ type: 'execute_command', command: 'synthetic-deadlock' }],
        onFailure: 'stop',
      }).returning();
      const [run] = await adminDb.insert(automationRuns).values({
        automationId: automation!.id,
        triggeredBy: 'authority-deadlock',
        status: 'running',
        devicesTargeted: 1,
      }).returning();

      const movePromise = app.request(`/devices/${device!.id}/move-org`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: destinationOrg.id, siteId: destinationSite.id }),
      });
      const dispatchPromise = withSystemDbAccessContext(() =>
        executeAutomationRun(run!.id, [device!.id]));

      const [moveOutcome, dispatchOutcome] = await Promise.allSettled([movePromise, dispatchPromise]);
      for (const outcome of [moveOutcome, dispatchOutcome]) {
        if (outcome.status !== 'rejected') continue;
        const message = outcome.reason instanceof Error
          ? `${outcome.reason.message}${outcome.reason.stack ? '' : ''}`
          : String(outcome.reason);
        // 40P01 is what this test rules out.
        if (/40P01|deadlock detected/i.test(message)) deadlocks.push(message);
      }
      // Both sides must reach a decision; a move that 500s is not "no deadlock".
      if (moveOutcome.status === 'fulfilled') {
        expect([200, 409]).toContain(moveOutcome.value.status);
      }

      // A dispatch that LOSES the race must lose closed. The move winning is a
      // legitimate outcome — the pre-existing org-mismatch guard in
      // seedAutomationActionResults raises on the run's own seeding step when
      // the device leaves mid-flight — but it must never leave a command
      // behind for a device that is no longer in the automation's owner org.
      if (dispatchOutcome.status === 'rejected') {
        const [movedRow] = await adminDb.select({ orgId: devices.orgId })
          .from(devices)
          .where(eq(devices.id, device!.id));
        const leftBehind = await adminDb.select({ id: deviceCommands.id })
          .from(deviceCommands)
          .where(eq(deviceCommands.deviceId, device!.id));
        expect({ orgId: movedRow?.orgId, commands: leftBehind }).toEqual({
          orgId: destinationOrg.id,
          commands: [],
        });
      }
    }
    expect(deadlocks).toEqual([]);
  }, 60_000);

  // ==========================================================================
  // SEC-118 review blocker 3 — the trigger must NOT fire on an org MERGE
  // ==========================================================================
  //
  // An org merge repoints the loser's devices to the survivor set-based. That
  // is an absorption, not a device leaving its tenant: the admitting authority
  // survives, so cancelling every pending remediation — and stamping
  // 'device_org_changed_before_dispatch', which would be a lie — destroys live
  // work. Same fence every sibling detach in breeze_cascade_device_org_id()
  // carries.
  runDb('leaves pending CIS remediation alone when the source org is merging', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const losingOrg = await createOrganization({ partnerId: partner.id });
    const survivingOrg = await createOrganization({ partnerId: partner.id });
    const losingSite = await createSite({ orgId: losingOrg.id });
    const survivingSite = await createSite({ orgId: survivingOrg.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: losingOrg.id,
      siteId: losingSite.id,
      agentId: `authority-merge-${randomUUID()}`,
      hostname: 'authority-merge',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
    }).returning();
    const [pending] = await adminDb.insert(cisRemediationActions).values({
      orgId: losingOrg.id,
      deviceId: device!.id,
      checkId: 'authority.merge',
      action: 'synthetic',
      status: 'pending_approval',
      approvalStatus: 'pending',
      details: { synthetic: true },
    }).returning();

    await adminDb.update(organizations)
      .set({ status: 'merging' })
      .where(eq(organizations.id, losingOrg.id));
    await adminDb.update(devices)
      .set({ orgId: survivingOrg.id, siteId: survivingSite.id })
      .where(eq(devices.id, device!.id));

    const [survived] = await adminDb
      .select({
        status: cisRemediationActions.status,
        orgId: cisRemediationActions.orgId,
        details: cisRemediationActions.details,
      })
      .from(cisRemediationActions)
      .where(eq(cisRemediationActions.id, pending!.id));
    // Not cancelled, no false reason, and re-stamped to the survivor by the
    // existing breeze_cascade_device_org_id() loop.
    expect(survived).toMatchObject({ status: 'pending_approval', orgId: survivingOrg.id });
    expect((survived!.details as Record<string, unknown>).cancelledReason).toBeUndefined();

    // Positive control on the SAME pair of orgs: with the merge fence lifted,
    // the identical UPDATE does cancel. Without this the assertion above would
    // also pass if the trigger were simply broken.
    await adminDb.update(organizations)
      .set({ status: 'active' })
      .where(eq(organizations.id, survivingOrg.id));
    await adminDb.update(devices)
      .set({ orgId: losingOrg.id, siteId: losingSite.id })
      .where(eq(devices.id, device!.id));
    const [cancelled] = await adminDb
      .select({ status: cisRemediationActions.status, details: cisRemediationActions.details })
      .from(cisRemediationActions)
      .where(eq(cisRemediationActions.id, pending!.id));
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      details: expect.objectContaining({ cancelledReason: 'device_org_changed_before_dispatch' }),
    });
  }, 30_000);

  // ==========================================================================
  // SEC-118 review blocker 2 — the CONFIG-POLICY sibling path
  // ==========================================================================
  //
  // `targetDeviceIds` is frozen at enqueue time by automationWorker's
  // enqueueConfigPolicyRun, and admitConfigPolicyAutomationRun validates the
  // POLICY owner, not the devices. Before this change the dispatch loaded its
  // targets with `inArray(devices.id, targetDeviceIds)` and NO org predicate,
  // so SEC-118 survived here untouched.
  runDb('does not action a config-policy target that left the policy org between enqueue and dispatch', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const policyOrg = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const policySite = await createSite({ orgId: policyOrg.id });
    const otherSite = await createSite({ orgId: otherOrg.id });

    const [stayingDevice, movedDevice] = await adminDb.insert(devices).values([
      {
        orgId: policyOrg.id,
        siteId: policySite.id,
        agentId: `cp-staying-${randomUUID()}`,
        hostname: 'cp-staying',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
      {
        orgId: policyOrg.id,
        siteId: policySite.id,
        agentId: `cp-moved-${randomUUID()}`,
        hostname: 'cp-moved',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'amd64',
        agentVersion: 'test',
        status: 'online',
      },
    ]).returning();

    const [policy] = await adminDb.insert(configurationPolicies)
      .values({ orgId: policyOrg.id, name: `SEC118 policy ${randomUUID()}` })
      .returning({ id: configurationPolicies.id });
    const [link] = await adminDb.insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'automation' })
      .returning({ id: configPolicyFeatureLinks.id });
    const [cpAutomation] = await adminDb.insert(configPolicyAutomations)
      .values({
        featureLinkId: link!.id,
        name: `SEC118 policy automation ${randomUUID()}`,
        triggerType: 'schedule',
        cronExpression: '0 2 * * *',
        timezone: 'UTC',
        actions: [{ type: 'execute_command', command: 'synthetic-config-policy' }],
      })
      .returning();

    // The move happens AFTER enqueue (targetDeviceIds is already frozen) and
    // BEFORE dispatch.
    await adminDb.update(devices)
      .set({ orgId: otherOrg.id, siteId: otherSite.id })
      .where(eq(devices.id, movedDevice!.id));

    const outcome = await withSystemDbAccessContext(() => executeConfigPolicyAutomationRun(
      cpAutomation!,
      policy!.id,
      [stayingDevice!.id, movedDevice!.id],
      'sec118-integration',
    ));

    const commands = await adminDb
      .select({ deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(inArray(deviceCommands.deviceId, [stayingDevice!.id, movedDevice!.id]));
    expect(commands).toEqual([{ deviceId: stayingDevice!.id }]);

    const deviceResults = await adminDb
      .select({
        deviceId: automationRunDeviceResults.deviceId,
        status: automationRunDeviceResults.status,
        error: automationRunDeviceResults.error,
      })
      .from(automationRunDeviceResults)
      .where(eq(automationRunDeviceResults.runId, outcome.runId));
    expect(deviceResults).toHaveLength(2);
    expect(deviceResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: stayingDevice!.id }),
      expect.objectContaining({
        deviceId: movedDevice!.id,
        status: 'failed',
        error: expect.stringContaining('device_org_changed'),
      }),
    ]));
    // The denial is also on the run's own log, so an operator reading the run
    // sees why the target is missing. (`devicesFailed` on the RETURN value is
    // deliberately 0 here: an accepted asynchronous dispatch makes the run
    // nonterminal, and that branch zeroes both counters until reconciliation.)
    const [runRow] = await adminDb
      .select({ logs: automationRuns.logs })
      .from(automationRuns)
      .where(eq(automationRuns.id, outcome.runId));
    expect(JSON.stringify(runRow?.logs)).toContain('device_org_changed');
  }, 30_000);
});
