import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { auditLogs } from '../db/schema/audit';
import { deviceCommands, devices } from '../db/schema/devices';
import { scriptProposals } from '../db/schema/scriptProposals';
import { scriptExecutions } from '../db/schema/scripts';
import { createOrganization, createPartner, createSite } from '../__tests__/integration/db-utils';
import { commandResultHandlers } from '../services/commandResultHandlers';
import { closeRedis } from '../services/redis';
import { getScriptVerifyQueue, SCRIPT_VERIFY_QUEUE, type ScriptVerifyJobData } from '../services/scriptProposals/verify';
import { sweepScriptVerifyProposals } from './scriptVerifyReconciliation';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.REDIS_URL);

runDb('reconciles a completed execution whose real verification producer is disconnected', async () => {
  const fixture = await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `verify-reconcile-${randomUUID()}`,
      hostname: 'verify-reconcile', osType: 'linux', osVersion: 'test',
      architecture: 'x86_64', agentVersion: 'test', status: 'online',
    }).returning();
    // Release has dispatched the script; result ingestion below terminalizes
    // its execution and invokes the production verification enqueue path.
    const [proposal] = await db.insert(scriptProposals).values({
      orgId: org.id, authorKind: 'chat_session', language: 'bash', content: 'echo ok',
      contentDigest: 'a'.repeat(64), timeoutSeconds: 60, goal: 'Print ok',
      expectedEffect: 'Successful exit', verification: { kind: 'exit_code', equals: 0 },
      targetDeviceIds: [device!.id], scannerVersion: 'test', status: 'executed',
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    }).returning();
    const [execution] = await db.insert(scriptExecutions).values({
      orgId: org.id, deviceId: device!.id, sourceKind: 'proposal', proposalId: proposal!.id,
      status: 'running', triggerType: 'manual', language: 'bash', timeoutSeconds: 60,
      runAs: 'system', contentDigest: 'a'.repeat(64), startedAt: new Date(),
    }).returning();
    const [command] = await db.insert(deviceCommands).values({
      deviceId: device!.id, type: 'script', status: 'sent', payload: { executionId: execution!.id },
    }).returning();
    return { orgId: org.id, device: device!, proposal: proposal!, execution: execution!, command: command! };
  });

  const queue = getScriptVerifyQueue();
  // Kill only this producer's real Redis connection. Job-presence reads use
  // the healthy queue, so the sweep can prove absence without stopping the
  // shared integration Redis service or substituting an artificial rejection.
  const producerConnection = (await queue.client).duplicate();
  const deadProducer = new Queue<ScriptVerifyJobData | { type: 'reconcile' }>(SCRIPT_VERIFY_QUEUE, { connection: producerConnection });
  await deadProducer.waitUntilReady();
  producerConnection.disconnect();
  const add = vi.spyOn(queue, 'add').mockImplementation((...args) => deadProducer.add(...args));
  try {
    await withSystemDbAccessContext(() => commandResultHandlers.script!({
      agentId: fixture.device.agentId, command: fixture.command, commandId: fixture.command.id,
      resolvedDeviceId: fixture.device.id, result: { status: 'completed', exitCode: 0 }, stdout: 'ok',
    }));
    expect(add).toHaveBeenCalledTimes(1);
    await withSystemDbAccessContext(async () => {
      const [execution] = await db.select().from(scriptExecutions).where(eq(scriptExecutions.id, fixture.execution.id));
      expect(execution).toMatchObject({ status: 'completed', exitCode: 0 });
      const [proposal] = await db.select().from(scriptProposals).where(eq(scriptProposals.id, fixture.proposal.id));
      expect(proposal!.status).toBe('executed');
      await db.update(scriptExecutions).set({ completedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
        .where(eq(scriptExecutions.id, fixture.execution.id));
    });
    expect(await queue.getJob(`script-verify-${fixture.proposal.id}-${fixture.execution.id}-1`)).toBeUndefined();

    await sweepScriptVerifyProposals();

    expect(add).toHaveBeenCalledTimes(2);
    await withSystemDbAccessContext(async () => {
      const [proposal] = await db.select().from(scriptProposals).where(eq(scriptProposals.id, fixture.proposal.id));
      expect(proposal!.status).toBe('verification_failed');
      expect(proposal!.verificationResult).toMatchObject({ outcome: 'unknown', evidence: { reason: 'verify_enqueue_lost' } });
      const audit = await db.select().from(auditLogs).where(and(
        eq(auditLogs.resourceId, fixture.proposal.id),
        eq(auditLogs.action, 'script.proposal.verification_failed'),
      ));
      expect(audit).toHaveLength(1);
    });
  } finally {
    add.mockRestore();
    await deadProducer.close();
    await queue.close();
    await closeRedis();
  }
});
