import '../../__tests__/integration/setup';
import { getTestDb } from '../../__tests__/integration/setup';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { hardwareHealthSnapshotSchema, type HardwareComponentReport } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { alerts, alertRules, alertTemplates, devices, monitorDefinitions, deviceHardwareHealth } from '../../db/schema';

// #6895 end to end against real Postgres: the W06 Storage Spaces timeline as a
// pre-fix agent reported it (missing member under a phantom key).
const m = vi.hoisted(() => ({ monitorId: '' }));
vi.mock('../eventBus', async original => ({ ...await original<typeof import('../eventBus')>(), publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: vi.fn().mockResolvedValue('correlation-job') }));
vi.mock('../alertCooldown', async original => ({
  ...await original<typeof import('../alertCooldown')>(),
  isCooldownActive: vi.fn().mockResolvedValue(false), isFlapping: vi.fn().mockResolvedValue(false),
  setCooldown: vi.fn().mockResolvedValue(undefined), recordStateTransition: async () => {},
}));
vi.mock('../monitors/monitorResolver', () => ({
  resolveMonitorsForDevice: async () => ({
    kind: 'resolved',
    monitors: [{ monitorId: m.monitorId, enabled: true, overrides: null, sourcePolicyId: 'test', sourceLevel: 'device', inheritedFromParent: false }],
  }),
}));
vi.mock('bullmq', () => ({
  Queue: class { add = vi.fn().mockResolvedValue({ id: 'queued' }); getJob = async () => null; close = async () => {}; },
  Worker: class { on() {} }, Job: class {}, UnrecoverableError: class extends Error {},
}));
vi.mock('../redis', async original => ({
  ...await original<typeof import('../redis')>(),
  isRedisAvailable: () => true, getRedisConnection: () => ({}), getBullMQConnection: () => ({}),
}));
vi.mock('../notificationSenders/inAppSender', async original => ({
  ...await original<typeof import('../notificationSenders/inAppSender')>(),
  sendInAppNotification: vi.fn(),
}));

import { evaluateDeviceAlerts } from '../alertService';
import { ingestHardwareHealthSnapshot } from './ingest';

beforeEach(() => { vi.clearAllMocks(); });

const ctrl = { componentKey: 'storage_spaces:ctrl', componentType: 'controller', source: 'storage_spaces', name: 'Storage Spaces', state: 'ok' } as const;
const vd = (state: string) => ({ componentKey: 'storage_spaces:vd:1', componentType: 'virtual_disk', parentKey: ctrl.componentKey, source: 'storage_spaces', name: 'Mirror', state }) as const;
const disk = (key: string, state: string) => ({ componentKey: key, componentType: 'physical_disk', parentKey: ctrl.componentKey, source: 'storage_spaces', name: key, state }) as const;
const healthy = [ctrl, vd('optimal'), disk('storage_spaces:ctrl:e-:sA', 'online'), disk('storage_spaces:ctrl:e-:sB', 'online')];
const faulted = [ctrl, vd('degraded'), disk('storage_spaces:ctrl:e-:sA', 'online'), disk('storage_spaces:ctrl:e-:sPHANTOM', 'missing')];

async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: 'spaces-6895',
      osType: 'windows', osVersion: '1', architecture: 'amd64', agentVersion: '1', status: 'online',
    }).returning();
    if (!row) throw new Error('Device seed failed');
    // The physical_disk_failed built-in shape: physical disks, critical, 2 snapshots.
    const condition = { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: false, consecutiveSnapshots: 2 };
    const [monitor] = await db.insert(monitorDefinitions).values({
      partnerId: partner.id, name: 'Physical disk failed', kind: 'hardware_health', condition, severity: 'high', autoResolve: true, deliveryMode: 'none',
    }).returning();
    m.monitorId = monitor!.id;
    const [template] = await db.insert(alertTemplates).values({
      partnerId: partner.id, name: 'Physical disk failed', conditions: { type: 'hardware_health', ...condition }, severity: 'high', autoResolve: true,
      titleTemplate: '{{componentLabel}} {{stateLabel}}', messageTemplate: '{{stateDetail}}', managedByMonitorId: monitor!.id,
    }).returning();
    await db.insert(alertRules).values({
      partnerId: partner.id, templateId: template!.id, name: 'Physical disk failed', targetType: 'monitor', targetId: monitor!.id, managedByMonitorId: monitor!.id,
    });
    return row;
  });
  const ctx = { scope: 'organization' as const, orgId: org.id, accessibleOrgIds: [org.id], currentPartnerId: partner.id };
  let seq = 0;
  const base = Date.now();
  const send = (components: Array<Partial<HardwareComponentReport>>) => {
    seq++;
    const at = new Date(base + seq * 1000);
    return withDbAccessContext(ctx, () => ingestHardwareHealthSnapshot({
      device: { id: device.id, orgId: org.id }, writer: 'agent', receivedAt: at,
      snapshot: hardwareHealthSnapshotSchema.parse({
        snapshotId: randomUUID(), sequence: seq, collectedAt: at.toISOString(), agentVersion: '1',
        pollIntervalMinutes: 5, diskHealthIntervalMinutes: 15, tiersRun: ['raid'],
        sources: [{ source: 'storage_spaces', status: 'ok', complete: true }], components,
      }),
    }));
  };
  const evaluate = () => withSystemDbAccessContext(() => evaluateDeviceAlerts(device.id));
  const alertRows = () => withSystemDbAccessContext(() => db.select().from(alerts).where(eq(alerts.deviceId, device.id)));
  const rollup = async () => (await getTestDb().select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId, device.id)))[0]!.health;
  return { send, evaluate, alertRows, rollup };
}

it('a missing-member fault alerts, and recovery resolves the stale phantom subject without waiting 7 days', async () => {
  const f = await fixture();
  await f.send(healthy);
  await f.evaluate();
  await f.send(faulted);
  await f.evaluate();
  await f.send(faulted);
  await f.evaluate();
  const [fault] = await f.alertRows();
  expect(fault).toMatchObject({ subjectKey: 'storage_spaces:ctrl:e-:sPHANTOM', status: 'active' });
  expect(await f.rollup()).toBe('critical');

  // Reattach: the phantom goes stale while still critical.
  expect(await f.send(healthy)).toMatchObject({ accepted: true, health: 'ok' });
  await f.evaluate();
  expect((await f.alertRows())[0]!.status).toBe('active'); // one healthy snapshot is not yet recovery

  await f.send(healthy);
  await f.evaluate();
  const [after] = await f.alertRows();
  expect(after).toMatchObject({ subjectKey: 'storage_spaces:ctrl:e-:sPHANTOM', status: 'resolved' });
  expect(after!.resolutionNote).toContain('the array it belonged to reports healthy');
  expect(await f.rollup()).toBe('ok');
});

it('a phantom stays open while the array is still degraded', async () => {
  const f = await fixture();
  await f.send(faulted);
  await f.send(faulted);
  await f.evaluate();
  const degradedWithB = [ctrl, vd('degraded'), disk('storage_spaces:ctrl:e-:sA', 'online'), disk('storage_spaces:ctrl:e-:sB', 'online')];
  await f.send(degradedWithB);
  await f.send(degradedWithB);
  await f.send(degradedWithB);
  await f.evaluate();
  expect((await f.alertRows()).map(a => a.status)).toEqual(['active']);
});
