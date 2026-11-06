/**
 * #11225 round 3, the catches deliberately LEFT without a savepoint. Each has a
 * comment at its site saying why: the write is part of a safety decision, so a
 * failure must still fail the transaction and leave nothing committed. These
 * pass on the unfixed code too, by design; they pin that the fix did not turn
 * a fail-closed gate into a swallow.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  const { faultingDb } = await import('./caughtQuerySelectFault');
  return { ...actual, db: faultingDb(actual.db) };
});

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { executeFault, resetSelectFault } from './caughtQuerySelectFault';
import { publicShortLinkRoutes } from '../../routes/enrollmentKeys';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { loadEnforcementMoment } from '../../services/backupStorageCredentialHistory';
import { backfillC2cConnectionSecrets } from '../../services/c2cSecrets';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { recordSoftwarePolicyAudit } from '../../services/softwarePolicyService';
import {
  aiSessions, enrollmentKeys, backupConfigs, backupJobs, backupSnapshots, c2cConnections, sites, softwarePolicyAudit, aiToolExecutions, approvalRequests, configPolicyFeatureLinks, configurationPolicies,
  deviceCommands, elevationAudit, elevationRequests, pamRules,
} from '../../db/schema';
import { handleApproval } from '../../services/aiAgent';
import { decideHelperToolAction } from '../../services/pamToolActionGovernance';
import { SCRIPT_SECRET_ENVELOPE_FIELD } from '../../services/scriptSecretEnvelope';
import { failClaimedSecretCommandsForUnsupportedAgent } from '../../services/scriptSecretDelivery';
import { addFeatureLink } from '../../services/configurationPolicy';
import {
  captureSecurityQuarantineAuthority,
  resolveSecurityScanQuarantineAuthority,
} from '../../services/securityScanQuarantineAuthority';
import { clearStatementFaults, failWritesOn } from './caughtQueryFaults';
import { orgContext, tenant, toolAuth } from './caughtQueryFixtures';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * The failed statement surfaces again when the held transaction ends. Matches the
 * trigger text naming the table, through the cause, so a different failure cannot pass.
 */
const forcedOn = (table: string) => (err: unknown): boolean => {
  const e = err as { message?: unknown; cause?: { message?: unknown } };
  return String(e.cause?.message ?? e.message).includes(`forced statement failure on ${table}`);
};

/** A marker written inside the held transaction before the code under test; it must NOT be committed. */
async function writeMarker(siteId: string): Promise<string> {
  const name = `uncommitted-${randomUUID()}`;
  await db.update(sites).set({ name }).where(eq(sites.id, siteId));
  return name;
}
async function expectNoMarker(siteId: string, name: string) {
  const [site] = await getTestDb().select({ name: sites.name }).from(sites).where(eq(sites.id, siteId));
  expect(site!.name).not.toBe(name);
}

beforeEach(() => {
  resetSelectFault();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clearStatementFaults();
});

describe('aiAgent.handleApproval: the approval_requests mirror failing rolls the decision back', () => {
  runDb('the execution row stays pending and the mirror row stays pending', async () => {
    const t = await tenant();
    const auth = await toolAuth(t);
    const userId = auth.user!.id;
    const [session] = await getTestDb().insert(aiSessions).values({ orgId: t.orgId, userId, model: 'rows-model' }).returning({ id: aiSessions.id });
    const [execution] = await getTestDb().insert(aiToolExecutions).values({
      sessionId: session!.id, toolName: 'run_script', toolInput: {}, status: 'pending',
    }).returning({ id: aiToolExecutions.id });
    await getTestDb().insert(approvalRequests).values({
      userId, requestingClientLabel: 'rows', actionLabel: 'Run script', actionToolName: 'run_script', riskTier: 'medium',
      riskSummary: 'rows', expiresAt: new Date(Date.now() + 300_000), executionId: execution!.id,
    });
    await failWritesOn('approval_requests', { ops: 'UPDATE' });

    await expect(withDbAccessContext({ ...orgContext(t), userId }, () => handleApproval(execution!.id, true, auth)))
      .rejects.toSatisfy(forcedOn('approval_requests'));

    const [exec] = await getTestDb().select({ status: aiToolExecutions.status }).from(aiToolExecutions).where(eq(aiToolExecutions.id, execution!.id));
    const [mirror] = await getTestDb().select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.executionId, execution!.id));
    expect(exec?.status).toBe('pending');
    expect(mirror?.status).toBe('pending');
  });
});

describe('pamToolActionGovernance: a failed audit insert fails the gate closed', () => {
  runDb('the decision falls back to pending and no auto-approval is committed', async () => {
    const t = await tenant();
    const auth = await toolAuth(t);
    await getTestDb().insert(pamRules).values({
      orgId: t.orgId, name: 'Allow run_script', matchToolName: 'run_script', verdict: 'auto_approve',
    } as never);
    const [session] = await getTestDb().insert(aiSessions).values({ orgId: t.orgId, userId: auth.user!.id, model: 'rows-model' }).returning({ id: aiSessions.id });
    const execution = async () => (await getTestDb().insert(aiToolExecutions).values({
      sessionId: session!.id, toolName: 'run_script', toolInput: {}, status: 'pending',
    }).returning({ id: aiToolExecutions.id }))[0]!.id;
    const decide = async (executionId: string) => decideHelperToolAction({
      orgId: t.orgId, deviceId: t.deviceId, executionId, toolName: 'run_script', toolInput: {},
      riskTier: 2, subjectUsername: 'rows-host',
    });

    // CONTROL: with nothing failing the rule auto-approves, so a 'pending' below can
    // only come from the audit failure.
    const controlExecution = await execution();
    await expect(decide(controlExecution)).resolves.toBe('auto_approved');
    const before = (await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.orgId, t.orgId))).length;
    expect(before).toBe(1);

    await failWritesOn('elevation_audit', { ops: 'INSERT' });
    const faultedExecution = await execution();
    const logged = vi.mocked(console.error);
    logged.mockClear();

    await expect(decide(faultedExecution)).resolves.toBe('pending');

    // The next statement fails with 25P02 on the aborted transaction, so the gate's
    // own fail-safe answers. Its log is what separates this from a rule that no-matched.
    expect(logged.mock.calls.some(([message]) => String(message).includes('failing safe to pending'))).toBe(true);
    expect(await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.orgId, t.orgId))).toHaveLength(before);
    const [row] = await getTestDb().select({ status: aiToolExecutions.status }).from(aiToolExecutions).where(eq(aiToolExecutions.id, faultedExecution));
    expect(row!.status).toBe('pending');
  });
});

describe('securityScanQuarantineAuthority: a failed status record fails the gate closed', () => {
  runDb('the resolve rejects and the link status is unchanged', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [{ resource: 'devices', action: 'write' }, { resource: 'devices', action: 'execute' }],
    });
    const auth = {
      scope: 'organization', user: env.user, orgId: env.organization.id, partnerId: env.partner.id, partnerOrgAccess: null,
      accessibleOrgIds: [env.organization.id], orgCondition: () => undefined, canAccessOrg: (id: string) => id === env.organization.id,
    } as never;
    const system = { scope: 'system' as const, orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
    const [policy] = await getTestDb().insert(configurationPolicies).values({ orgId: env.organization.id, name: `rows-${randomUUID()}` }).returning();
    const authority = captureSecurityQuarantineAuthority(auth, { orgId: env.organization.id, partnerId: null })!;
    const link = await withDbAccessContext(system, () => addFeatureLink(
      policy!.id, 'security', null, { autoQuarantine: true }, undefined, db, { executionAuthority: authority },
    ));
    const status = async () => (await getTestDb().select({ s: configPolicyFeatureLinks.executionAuthorityStatus })
      .from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, link!.id)))[0]?.s;
    const before = await status();
    await failWritesOn('config_policy_feature_links', { ops: 'UPDATE' });

    await expect(withDbAccessContext(system, () => resolveSecurityScanQuarantineAuthority(link!.id, env.site.id)))
      .rejects.toSatisfy(forcedOn('config_policy_feature_links'));

    // Also true under a savepoint (the failed write is rolled back either way), so only the
    // rejection above discriminates: it proves the catch did not swallow the failure.
    expect(await status()).toBe(before);
  });
});

describe('scriptSecretDelivery: a failed terminal update rolls the whole claim back', () => {
  runDb('the command stays sent with its sealed payload', async () => {
    const t = await tenant();
    const payload = { [SCRIPT_SECRET_ENVELOPE_FIELD]: 'sealed-envelope', scriptId: randomUUID() };
    const [command] = await getTestDb().insert(deviceCommands).values({
      deviceId: t.deviceId, type: 'script', status: 'sent', payload,
    }).returning({ id: deviceCommands.id });
    await failWritesOn('device_commands', { ops: 'UPDATE' });

    await expect(withSystemDbAccessContext(() => failClaimedSecretCommandsForUnsupportedAgent(
      [{ id: command!.id, type: 'script', deviceId: t.deviceId, payload, executedAt: null }],
      { reportedVersion: 0 },
    ))).rejects.toSatisfy(forcedOn('device_commands'));

    const [row] = await getTestDb().select({ status: deviceCommands.status, payload: deviceCommands.payload })
      .from(deviceCommands).where(eq(deviceCommands.id, command!.id));
    expect(row?.status).toBe('sent');
    expect(row?.payload).toEqual(payload);
  });
});

describe('softwarePolicyService.recordSoftwarePolicyAudit: not a savepoint, the caller commit fails', () => {
  runDb('the awaited audit resolves, the held commit rejects, nothing is committed', async () => {
    const t = await tenant();
    await failWritesOn('software_policy_audit');
    let resolved = false;
    let marker = '';
    await expect(withDbAccessContext(orgContext(t), async () => {
      marker = await writeMarker(t.siteId);
      await recordSoftwarePolicyAudit({ orgId: t.orgId, action: 'policy.checked', actor: 'system' });
      resolved = true;
    })).rejects.toSatisfy(forcedOn('software_policy_audit'));
    expect(resolved).toBe(true);
    await expectNoMarker(t.siteId, marker);
    expect(await getTestDb().select().from(softwarePolicyAudit).where(eq(softwarePolicyAudit.orgId, t.orgId))).toHaveLength(0);
  });
});

describe('backupResultPersistence protection block: not a savepoint, the result does not commit', () => {
  runDb('a failed protection update rejects the commit; the job stays running and no snapshot exists', async () => {
    const t = await tenant();
    const [config] = await getTestDb().insert(backupConfigs)
      .values({ orgId: t.orgId, name: `rows-${randomUUID()}`, type: 'file', provider: 'local', providerConfig: {} })
      .returning({ id: backupConfigs.id });
    const [job] = await getTestDb().insert(backupJobs).values({
      orgId: t.orgId, configId: config!.id, deviceId: t.deviceId, status: 'running', startedAt: new Date(), lastProgressAt: new Date(),
    }).returning({ id: backupJobs.id });
    await failWritesOn('backup_snapshots', { ops: 'UPDATE', when: 'NEW.gfs_tags IS NOT DISTINCT FROM OLD.gfs_tags' });

    await expect(withSystemDbAccessContext(() => applyBackupCommandResultToJob({
      jobId: job!.id, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: { snapshotId: `snap-${job!.id}`, filesBackedUp: 3, bytesBackedUp: 30 },
    }))).rejects.toSatisfy(forcedOn('backup_snapshots'));

    const [after] = await getTestDb().select({ status: backupJobs.status }).from(backupJobs).where(eq(backupJobs.id, job!.id));
    expect(after?.status).toBe('running');
    expect(await getTestDb().select().from(backupSnapshots).where(eq(backupSnapshots.jobId, job!.id))).toHaveLength(0);
  });
});

describe('c2cSecrets.backfillC2cConnectionSecrets: a failed write rolls the backfill back', () => {
  // Under a savepoint the failed row would be re-selected forever, so a short timeout turns a hang into a failure.
  runDb('rejects with the forced failure and the row is still plaintext', async () => {
    const t = await tenant();
    const [row] = await getTestDb().insert(c2cConnections).values({
      orgId: t.orgId, provider: 'microsoft_365', displayName: 'Rows', clientSecret: 'plaintext-secret',
    } as never).returning({ id: c2cConnections.id });
    await failWritesOn('c2c_connections', { ops: 'UPDATE' });

    // The batch loop's next read runs on the aborted transaction, so it is the 25P02 that rejects
    // (the forced failure itself is then the transaction's recorded error). Under a savepoint the
    // row would be re-selected forever and this test would time out.
    await expect(withSystemDbAccessContext(() => backfillC2cConnectionSecrets())).rejects.toSatisfy((err: unknown) => {
      const e = err as { message?: unknown; cause?: { message?: unknown } };
      return /forced statement failure on c2c_connections|current transaction is aborted/.test(String(e.cause?.message ?? e.message));
    });

    const [after] = await getTestDb().select({ clientSecret: c2cConnections.clientSecret }).from(c2cConnections).where(eq(c2cConnections.id, row!.id));
    expect(after?.clientSecret).toBe('plaintext-secret');
  }, 15_000);
});

describe('backupStorageCredentialHistory.loadEnforcementMoment: a failed ledger read fails the commit', () => {
  runDb('rejects instead of returning a guessed null, and nothing is committed', async () => {
    const t = await tenant();
    // One shot: the first read of the migration ledger fails with a real Postgres error on the held transaction.
    executeFault.match = 'FROM breeze_migrations';
    let marker = '';
    let resolvedWith: unknown = 'not-called';
    await expect(withSystemDbAccessContext(async () => {
      marker = await writeMarker(t.siteId);
      resolvedWith = await loadEnforcementMoment();
    })).rejects.toSatisfy((err: unknown) => String((err as { cause?: { message?: unknown }; message?: unknown }).cause?.message
      ?? (err as { message?: unknown }).message).includes('division by zero'));
    expect(executeFault.hits).toBe(1);
    expect(resolvedWith).toBeNull();
    await expectNoMarker(t.siteId, marker);
  });
});

describe('enrollmentKeys short link: a failed claim release fails the redemption commit', () => {
  runDb('the claim and the minted download key are rolled back, not left half-released', async () => {
    const t = await tenant();
    const shortCode = randomUUID().replace(/-/g, '').slice(0, 10);
    const [link] = await getTestDb().insert(enrollmentKeys).values({
      orgId: t.orgId, siteId: t.siteId, name: 'Rows link', key: hashEnrollmentKey(`rows-${randomUUID()}`), shortCode,
      installerPlatform: 'windows', maxUsage: 5, expiresAt: new Date(Date.now() + 3_600_000),
    } as never).returning({ id: enrollmentKeys.id });
    const usage = async () => (await getTestDb().select({ n: enrollmentKeys.usageCount }).from(enrollmentKeys).where(eq(enrollmentKeys.id, link!.id)))[0]?.n;
    const children = () => getTestDb().select({ id: enrollmentKeys.id }).from(enrollmentKeys)
      .where(and(eq(enrollmentKeys.orgId, t.orgId), like(enrollmentKeys.name, '%short-link download%')));

    // CONTROL: unfaulted, the installer build fails here (no server URL configured) and the release gives the use back and drops the child key.
    const control = await publicShortLinkRoutes.request(`/${shortCode}`);
    expect(control.status).toBe(500);
    expect(await control.json()).toEqual({ error: 'Server URL not configured' });
    expect(await usage()).toBe(0);
    expect(await children()).toHaveLength(0);

    await failWritesOn('enrollment_keys', { ops: 'DELETE' });
    const res = await publicShortLinkRoutes.request(`/${shortCode}`);
    // The route's commit fails, so the claim and the mint roll back together. Under a savepoint the
    // failed delete would be undone alone and the live download key would outlive the failed redemption.
    expect(res.status).toBe(500);
    expect(await usage()).toBe(0);
    expect(await children()).toHaveLength(0);
  });
});
