import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task A4 — the automation-style alert writer, moved
 * verbatim out of automationRuntime's `executeCreateAlertAction` so the flow
 * `create_alert` built-in writes the same rows. The legacy row and event shape
 * are pinned here (captured from the pre-extraction function).
 *
 * #11348 — the event is no longer published inline (inside the caller's
 * transaction, before the row is visible to `process-alert`). It is staged on
 * the row as the outbox envelope and dispatched after COMMIT.
 */

const m = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  selects: [] as unknown[][],
  publish: vi.fn(),
  schedule: vi.fn(),
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
vi.mock('./subjectAlertOutbox', () => ({ scheduleStagedAlertDispatch: m.schedule }));
vi.mock('./deviceSiteResolver', () => ({ resolveDeviceSiteId: vi.fn(async () => 'site-1') }));

import { createAutomationStyleAlert } from './alertCreation';
import { withFlowExecutionContext } from './flows/flowExecutionContext';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const FLOW_RUN = '33333333-3333-4333-8333-333333333333';

/** The outbox envelope staged on the alert row, or undefined. */
function stagedEnvelope(): Record<string, unknown> | undefined {
  const alert = m.inserts.find((i) => i.table === 'alerts');
  return (alert?.values.context as { _subjectDispatch?: Record<string, unknown> } | undefined)?._subjectDispatch;
}

beforeEach(() => {
  m.inserts.length = 0;
  m.selects.length = 0;
  m.publish.mockReset().mockResolvedValue(undefined);
  m.schedule.mockReset();
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
      context: {
        automationId: 'auto-1', automationRunId: 'run-1', deviceId: DEVICE,
        // The outbox envelope, written in the SAME insert as the row.
        _subjectDispatch: {
          eventId: out!.alertId,
          eventType: 'alert.triggered',
          publisher: 'automation-executor',
          siteId: 'site-1',
          cooldownMinutes: 0,
          payload: {
            alertId: out!.alertId, ruleId: 'rule-1', deviceId: DEVICE, severity: 'high',
            title: 'Disk low on web-1', message: 'C: below 10%', automationId: 'auto-1', runId: 'run-1',
          },
          occurredAt: expect.any(String),
          retryOnPublishFailure: true,
          // Every action is its own subject: no cooldown or flap state to record.
          noiseControls: false,
        },
      },
      triggeredAt: expect.any(Date),
    });
    // Announced after COMMIT by the outbox, never inline.
    expect(m.publish).not.toHaveBeenCalled();
    expect(m.schedule).toHaveBeenCalledExactlyOnceWith(out!.alertId);
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
    const { _subjectDispatch: _envelope, ...rowContext } = alert.values.context as Record<string, unknown>;
    expect(rowContext).toEqual({ flowRunId: 'frun-1', deviceId: DEVICE });
    const envelope = stagedEnvelope()!;
    expect(envelope.payload).toEqual({ alertId: out!.alertId, ruleId: 'rule-1', deviceId: DEVICE, severity: 'medium', title: 't', message: 'm', flowRunId: 'frun-1' });
    expect(envelope.payload).not.toHaveProperty('automationId');
    expect(envelope.publisher).toBe('flow-executor');
    expect(m.publish).not.toHaveBeenCalled();
  });

  // Decision 14: `publishEvent` stamps a flow step's ancestry from the step's
  // frame, and the event trigger reads it to stop flow loops. The outbox
  // publishes later, outside that frame, so the envelope carries it.
  it('a flow step stages its run ancestry on the envelope', async () => {
    m.selects.push([{ id: 'tpl-1' }], [{ id: 'rule-1' }]);
    await withFlowExecutionContext({ runId: FLOW_RUN, chainDepth: 2 }, () => createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'medium', title: 't', message: 'm',
      provenance: { kind: 'flow', flowRunId: FLOW_RUN },
    }));
    expect(stagedEnvelope()).toMatchObject({ flow: { runId: FLOW_RUN, chainDepth: 2 } });
  });

  it('outside a flow step the envelope carries no ancestry', async () => {
    m.selects.push([{ id: 'tpl-1' }], [{ id: 'rule-1' }]);
    await createAutomationStyleAlert({
      orgId: ORG, deviceId: DEVICE, severity: 'low', title: 't', message: 'm',
      provenance: { kind: 'automation', automationId: 'a', runId: 'r' },
    });
    expect(stagedEnvelope()).not.toHaveProperty('flow');
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
    expect(m.schedule).not.toHaveBeenCalled();
  });
});
