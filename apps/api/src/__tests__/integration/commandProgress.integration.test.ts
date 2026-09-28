/**
 * #3578 — `applyCommandProgress` against real Postgres.
 *
 * The unit test pins the shape of the call; only a real database can prove the
 * WHERE clause does what the service promises: a stage lands only on the
 * authenticated device's in-flight (`status='sent'`) agent command, and only
 * ever moves FORWARD, so a late/duplicate/out-of-order frame is a no-op that
 * neither regresses the stage nor refreshes its timestamp.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { devices, deviceCommands } from '../../db/schema';
import { applyCommandProgress } from '../../services/commandProgress';

async function makeDevice(): Promise<string> {
  const env = await setupTestEnvironment();
  const agentId = `agent-3578-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId,
      hostname: `progress-${agentId}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('makeDevice: no device');
  return device.id;
}

async function seedCommand(deviceId: string, status = 'sent'): Promise<string> {
  const [command] = await getTestDb()
    .insert(deviceCommands)
    .values({
      deviceId,
      type: 'software_install',
      targetRole: 'agent',
      payload: { deploymentId: '00000000-0000-4000-8000-000000000000', retryCount: 0 },
      status,
      executedAt: status === 'pending' ? null : new Date(),
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedCommand: no command');
  return command.id;
}

async function readProgress(commandId: string) {
  const [row] = await getTestDb()
    .select({ stage: deviceCommands.progressStage, at: deviceCommands.progressAt })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId));
  return row;
}

describe('applyCommandProgress (real Postgres, #3578)', () => {
  it('advances downloading → installing and records when each stage began', async () => {
    const deviceId = await makeDevice();
    const commandId = await seedCommand(deviceId);
    const t1 = new Date('2026-09-28T10:00:00Z');
    const t2 = new Date('2026-09-28T10:07:00Z');

    expect(await applyCommandProgress({ deviceId, commandId, stage: 'downloading', now: t1 }))
      .toEqual({ applied: true });
    expect(await readProgress(commandId)).toEqual({ stage: 'downloading', at: t1 });

    expect(await applyCommandProgress({ deviceId, commandId, stage: 'installing', now: t2 }))
      .toEqual({ applied: true });
    expect(await readProgress(commandId)).toEqual({ stage: 'installing', at: t2 });
  });

  it('never regresses the stage or refreshes its timestamp', async () => {
    const deviceId = await makeDevice();
    const commandId = await seedCommand(deviceId);
    const t1 = new Date('2026-09-28T11:00:00Z');

    await applyCommandProgress({ deviceId, commandId, stage: 'installing', now: t1 });

    // A late `downloading` frame and a duplicate `installing` frame both miss.
    expect(await applyCommandProgress({ deviceId, commandId, stage: 'downloading' }))
      .toEqual({ applied: false, reason: 'not-applicable' });
    expect(await applyCommandProgress({ deviceId, commandId, stage: 'installing' }))
      .toEqual({ applied: false, reason: 'not-applicable' });
    expect(await readProgress(commandId)).toEqual({ stage: 'installing', at: t1 });
  });

  it("refuses another device's command", async () => {
    const owner = await makeDevice();
    const other = await makeDevice();
    const commandId = await seedCommand(owner);

    expect(await applyCommandProgress({ deviceId: other, commandId, stage: 'downloading' }))
      .toEqual({ applied: false, reason: 'not-applicable' });
    expect(await readProgress(commandId)).toEqual({ stage: null, at: null });
  });

  it('ignores a command that is not in flight (queued, or already terminal)', async () => {
    const deviceId = await makeDevice();
    const queued = await seedCommand(deviceId, 'pending');
    const done = await seedCommand(deviceId, 'completed');

    for (const commandId of [queued, done]) {
      expect(await applyCommandProgress({ deviceId, commandId, stage: 'downloading' }))
        .toEqual({ applied: false, reason: 'not-applicable' });
      expect(await readProgress(commandId)).toEqual({ stage: null, at: null });
    }
  });
});
