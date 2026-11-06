/**
 * #11225 round 3, the catches deliberately LEFT without a savepoint. Each has a
 * comment at its site saying why: the write is part of a safety decision, so a
 * failure must still fail the transaction and leave nothing committed. These
 * pass on the unfixed code too, by design; they pin that the fix did not turn
 * a fail-closed gate into a swallow.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  aiSessions, aiToolExecutions, approvalRequests, configPolicyFeatureLinks, configurationPolicies,
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

/** The failed statement surfaces again when the held transaction ends. */
const FAILED = /forced statement failure|Failed query/;

beforeEach(() => {
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
      .rejects.toThrow(FAILED);

    const [exec] = await getTestDb().select({ status: aiToolExecutions.status }).from(aiToolExecutions).where(eq(aiToolExecutions.id, execution!.id));
    const [mirror] = await getTestDb().select({ status: approvalRequests.status }).from(approvalRequests).where(eq(approvalRequests.executionId, execution!.id));
    expect(exec?.status).toBe('pending');
    expect(mirror?.status).toBe('pending');
  });
});

describe('pamToolActionGovernance: a failed audit insert fails the gate closed', () => {
  runDb('the decision falls back to pending and no auto-approval is committed', async () => {
    const t = await tenant();
    await getTestDb().insert(pamRules).values({
      orgId: t.orgId, name: 'Allow run_script', matchToolName: 'run_script', verdict: 'auto_approve',
    } as never);
    await failWritesOn('elevation_audit', { ops: 'INSERT' });

    const decision = await decideHelperToolAction({
      orgId: t.orgId, deviceId: t.deviceId, executionId: randomUUID(), toolName: 'run_script', toolInput: {},
      riskTier: 2, subjectUsername: 'rows-host',
    });

    expect(decision).toBe('pending');
    expect(await getTestDb().select().from(elevationRequests).where(eq(elevationRequests.orgId, t.orgId))).toHaveLength(0);
    expect(await getTestDb().select().from(elevationAudit).where(eq(elevationAudit.orgId, t.orgId))).toHaveLength(0);
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
      .rejects.toThrow(FAILED);

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
    ))).rejects.toThrow(FAILED);

    const [row] = await getTestDb().select({ status: deviceCommands.status, payload: deviceCommands.payload })
      .from(deviceCommands).where(eq(deviceCommands.id, command!.id));
    expect(row?.status).toBe('sent');
    expect(row?.payload).toEqual(payload);
  });
});
