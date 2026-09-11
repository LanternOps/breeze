/**
 * #5264 — live-Postgres proof that a device which changes organization
 * between a background caller's DECISION and its DISPATCH cannot receive the
 * command.
 *
 * Why this needs a real database, and why the mocked unit cases in
 * `services/commandQueue.dbcontext.test.ts` are not enough:
 *
 *  - The unit suite hands `precheckCommandExecution` whatever device row its
 *    `db` double is told to return, so it can only prove the comparison
 *    fires. It cannot prove the premise the comparison exists FOR — that
 *    under `withSystemDbAccessContext` the `devices` SELECT genuinely returns
 *    the moved row, i.e. that RLS is NOT quietly filtering it and the guard
 *    is therefore load-bearing rather than belt-and-braces.
 *  - The first case below asserts exactly that premise against real RLS,
 *    with a real cross-org UPDATE in between. If a future migration ever made
 *    the system scope org-filtered, this case would go green for the wrong
 *    reason — so it asserts the visibility DIRECTLY rather than inferring it
 *    from the refusal.
 *
 * Placement: `src/__tests__/integration/**` is the shared glob in
 * `vitest.integration.config.ts`, so this file runs in the blocking
 * `integration-test` job with no extra registration and no `runIf` gate.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

// The WS layer is the only thing between the precheck and a real socket send.
// Stubbing it lets a PASSING dispatch be observed (the positive control) without
// an agent — and makes "was anything sent?" a direct assertion rather than an
// inference from the returned status.
const wsMocks = vi.hoisted(() => ({
  sendCommandToAgent: vi.fn(() => true),
  isAgentConnected: vi.fn(() => true),
}));
vi.mock('../../routes/agentWs', () => ({
  sendCommandToAgent: wsMocks.sendCommandToAgent,
  isAgentConnected: wsMocks.isAgentConnected,
}));

async function seedOnlineDevice() {
  const adminDb = getTestDb() as never as typeof db;
  const partner = await createPartner({});
  const sourceOrg = await createOrganization({ partnerId: partner.id });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: sourceOrg.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: site.id,
      agentId: `dispatch-move-agent-${unique}`,
      hostname: `dispatch-move-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();
  return { partner, sourceOrg, targetOrg, device: device! };
}

/** The org move a real `POST /devices/:id/move-org` performs, reduced to the
 *  one column this guard reads. */
async function moveDeviceToOrg(deviceId: string, orgId: string, siteId: string) {
  const adminDb = getTestDb() as never as typeof db;
  await adminDb.update(devices).set({ orgId, siteId }).where(eq(devices.id, deviceId));
}

describe('command dispatch after a device org move (#5264)', () => {
  beforeEach(() => {
    wsMocks.sendCommandToAgent.mockClear();
    wsMocks.isAgentConnected.mockClear();
  });

  it('refuses the dispatch, and the system-scope read really can still see the moved device', async () => {
    const { sourceOrg, targetOrg, device } = await seedOnlineDevice();
    const decidedUnderOrgId = sourceOrg.id;

    // ---- the move, between decision and dispatch ----
    const targetSite = await createSite({ orgId: targetOrg.id });
    await moveDeviceToOrg(device.id, targetOrg.id, targetSite.id);

    // PREMISE (not the conclusion): under the same system scope the precheck
    // uses, the id-only SELECT still resolves the row — now owned by the
    // OTHER org. This is what makes the guard load-bearing.
    const seenUnderSystemScope = await withSystemDbAccessContext(() =>
      db.select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, device.id)).limit(1),
    );
    expect(seenUnderSystemScope).toHaveLength(1);
    expect(seenUnderSystemScope[0]!.orgId).toBe(targetOrg.id);
    expect(seenUnderSystemScope[0]!.orgId).not.toBe(decidedUnderOrgId);

    // ---- the dispatch ----
    const { executeCommandWithSystemPrecheck } = await import('../../services/commandQueue');
    const result = await executeCommandWithSystemPrecheck(
      device.id,
      'list_services',
      {},
      { timeoutMs: 2_000, expectedOrgId: decidedUnderOrgId },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Device not found');
    // Refused BEFORE the row existed: no commandId, and nothing in the table.
    expect(result.commandId).toBeUndefined();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: deviceCommands.id }).from(deviceCommands).where(eq(deviceCommands.deviceId, device.id)),
    );
    expect(rows).toHaveLength(0);
    expect(wsMocks.sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('positive control: the same dispatch is admitted while the device has NOT moved', async () => {
    // Without this, the case above would pass equally against a precheck that
    // refused unconditionally — which would break every background dispatch
    // in the product while looking like a security win.
    const { sourceOrg, device } = await seedOnlineDevice();

    const { executeCommandWithSystemPrecheck } = await import('../../services/commandQueue');
    const result = await executeCommandWithSystemPrecheck(
      device.id,
      'list_services',
      {},
      { timeoutMs: 1_000, expectedOrgId: sourceOrg.id },
    );

    // No agent answers, so it times out — the point is that it got PAST the
    // precheck and a real command row was written and sent.
    expect(result.error).not.toBe('Device not found');
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: deviceCommands.id }).from(deviceCommands).where(eq(deviceCommands.deviceId, device.id)),
    );
    expect(rows).toHaveLength(1);
    expect(wsMocks.sendCommandToAgent).toHaveBeenCalled();
  });
});
