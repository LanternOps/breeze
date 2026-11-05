import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A4 — the automation-style alert writer, moved
 * verbatim out of automationRuntime's `executeCreateAlertAction` so the flow
 * `create_alert` built-in writes the same rows. The legacy row and event shape
 * are pinned here (captured from the pre-extraction function).
 */

const m = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  selects: [] as unknown[][],
  publish: vi.fn(),
  failAlertInsert: false,
}));

vi.mock('../db', () => {
  const tableName = (t: unknown) => (t as { [k: symbol]: string })[Symbol.for('drizzle:Name')] ?? 'unknown';
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => m.selects.shift() ?? [] }) }) }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          returning: async () => {
            const name = tableName(table);
            m.inserts.push({ table: name, values });
            if (name === 'alerts' && m.failAlertInsert) return [];
            return [{ id: values.id ?? `${name}-id` }];
          },
        }),
      }),
    },
  };
});
vi.mock('./eventBus', () => ({ publishEvent: m.publish }));

import { createAutomationStyleAlert } from './alertCreation';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  m.inserts.length = 0;
  m.selects.length = 0;
  m.publish.mockReset().mockResolvedValue(undefined);
  m.failAlertInsert = false;
});

describe('createAutomationStyleAlert', () => {
  it('legacy output is identical after extraction', async () => {
    // Existing template and rule: no template/rule insert, one alert insert.
    m.selects.push([{ id: 'tpl-1' }], [{ id: 'rule-1' }]);
    const out = await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'high', title: 'Disk low on web-1', message: 'C: below 10%',
      provenance: { kind: 'automation', automationId: 'auto-1', runId: 'run-1' },
    });
    expect(out).not.toBeNull();
    const alert = m.inserts.find((i) => i.table === 'alerts')!;
    expect(alert.values).toEqual({
      ownerKind: 'device',
      id: out!.alertId,
      subjectKey: `automation-alert:${out!.alertId}`,
      ruleId: 'rule-1',
      deviceId: DEVICE,
      orgId: ORG,
      status: 'active',
      severity: 'high',
      title: 'Disk low on web-1',
      message: 'C: below 10%',
      context: { automationId: 'auto-1', automationRunId: 'run-1', deviceId: DEVICE },
      triggeredAt: expect.any(Date),
    });
    expect(m.publish).toHaveBeenCalledWith('alert.triggered', ORG, {
      alertId: out!.alertId, ruleId: 'rule-1', deviceId: DEVICE, severity: 'high',
      title: 'Disk low on web-1', message: 'C: below 10%', automationId: 'auto-1', runId: 'run-1',
    }, 'automation-executor');
  });

  it('creates the per-org template and rule on first use', async () => {
    m.selects.push([], []);
    await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'low', title: 't', message: 'm',
      provenance: { kind: 'automation', automationId: 'auto-1', runId: 'run-1' },
    });
    expect(m.inserts.map((i) => i.table)).toEqual(['alert_templates', 'alert_rules', 'alerts']);
    expect(m.inserts[1]!.values).toMatchObject({ orgId: ORG, name: 'Automation Action Alerts', targetType: 'org', targetId: ORG });
  });

  // partner-wide-write-coverage allowlists this file on this property: the
  // template and rule are ORG-axis rows of the one org passed in (every flow
  // run has an org — flow_runs.org_id NOT NULL — and the legacy caller passes
  // the device's org). A partner-axis row (partner_id set, org_id NULL) would
  // be partner-wide config and need canManagePartnerWidePolicies.
  it('only ever writes org-axis template and rule rows (never partner-wide config)', async () => {
    m.selects.push([], []);
    await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'low', title: 't', message: 'm',
      provenance: { kind: 'flow', flowRunId: 'frun-1' },
    });
    for (const i of m.inserts) {
      expect(i.values.orgId, i.table).toBe(ORG);
      expect(i.values, i.table).not.toHaveProperty('partnerId');
    }
    expect(m.inserts.find((i) => i.table === 'alert_rules')!.values).toMatchObject({ targetType: 'org', targetId: ORG });
  });

  it('flow provenance carries flowRunId and never an automationId', async () => {
    m.selects.push([{ id: 'tpl-1' }], [{ id: 'rule-1' }]);
    const out = await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'medium', title: 't', message: 'm',
      provenance: { kind: 'flow', flowRunId: 'frun-1' },
    });
    const alert = m.inserts.find((i) => i.table === 'alerts')!;
    expect(alert.values.context).toEqual({ flowRunId: 'frun-1', deviceId: DEVICE });
    const [, , payload, source] = m.publish.mock.calls[0]!;
    expect(payload).toEqual({ alertId: out!.alertId, ruleId: 'rule-1', deviceId: DEVICE, severity: 'medium', title: 't', message: 'm', flowRunId: 'frun-1' });
    expect(payload).not.toHaveProperty('automationId');
    expect(source).toBe('flow-executor');
  });

  it('returns null and publishes nothing when the insert returns no row', async () => {
    m.selects.push([{ id: 'tpl-1' }], [{ id: 'rule-1' }]);
    m.failAlertInsert = true;
    const out = await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'low', title: 't', message: 'm',
      provenance: { kind: 'automation', automationId: 'a', runId: 'r' },
    });
    expect(out).toBeNull();
    expect(m.publish).not.toHaveBeenCalled();
  });
});
