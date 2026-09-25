/**
 * W03 (#6854) — every automation `create_alert` action inserts under ONE
 * synthetic per-org rule ("Automation Action Alerts"). The open-alert identity
 * index (alerts_open_rule_device_subject_uidx) allows one open alert per
 * (rule, device, subject), so each automation alert must carry its own subject
 * key or a second open automation alert on the same device fails with 23505.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { withSystemDbAccessContext } from '../../db';
import { alerts, automationRuns, automations, devices } from '../../db/schema';
import { executeAutomationRun } from '../../services/automationRuntime';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('automation create_alert open-alert identity', () => {
  runDb('two create_alert actions on one device both stay open, each with its own subject', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await adminDb.insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId: `create-alert-identity-${randomUUID()}`,
      hostname: 'create-alert-identity',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online',
    }).returning();
    const [automation] = await adminDb.insert(automations).values({
      orgId: org.id,
      partnerId: null,
      name: `Create alert identity ${randomUUID()}`,
      trigger: { type: 'manual' },
      conditions: { type: 'devices', deviceIds: [device!.id] },
      actions: [
        { type: 'create_alert', alertSeverity: 'high', alertTitle: 'First', alertMessage: 'first' },
        { type: 'create_alert', alertSeverity: 'high', alertTitle: 'Second', alertMessage: 'second' },
      ],
      onFailure: 'stop',
    }).returning();
    const [run] = await adminDb.insert(automationRuns).values({
      automationId: automation!.id,
      triggeredBy: 'create-alert-identity',
      status: 'running',
      devicesTargeted: 1,
    }).returning();

    const outcome = await withSystemDbAccessContext(() => executeAutomationRun(run!.id, [device!.id]));
    expect(outcome).toMatchObject({ devicesSucceeded: 1, devicesFailed: 0 });

    const rows = await adminDb.select().from(alerts).where(eq(alerts.deviceId, device!.id));
    expect(rows.map((row) => row.title).sort()).toEqual(['First', 'Second']);
    expect(new Set(rows.map((row) => row.ruleId)).size).toBe(1);
    for (const row of rows) {
      expect(row.status).toBe('active');
      expect(row.subjectKey).toBe(`automation-alert:${row.id}`);
    }
  });
});
