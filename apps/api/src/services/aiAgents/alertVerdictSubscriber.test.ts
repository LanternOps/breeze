/**
 * alertVerdictSubscriber (P2-1 wave B, Task 12).
 *
 * Mocked-DB unit tests for the durable `ai-agent-alert-verdict` event
 * subscriber. `createAndEnqueueAgentRun` (runService.ts) is mocked — its own
 * admission behaviour (dedupe, verdict-profile caps, kill switch, circuit
 * breaker, trigger-filter matching) is covered in runService.test.ts; these
 * tests pin only what THIS module is responsible for: extracting the trigger
 * from `alert.correlation_group.created` / `alert.resolved`, the group's
 * root-alert device binding, the auto-resolve gating window + existing-
 * verdict guard, building `alertContext`, and calling admission with the
 * right shape (mirrors `metricAnomalySubscriber.test.ts`'s structure).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const shared = vi.hoisted(() => ({ aiAgentsEnabled: true }));

vi.mock('../../config/env', () => ({
  get AI_AGENTS_ENABLED() { return shared.aiAgentsEnabled; },
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

vi.mock('../../db/schema/alerts', () => ({
  alerts: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    ruleId: 'rule_id',
    severity: 'severity',
    resolvedAt: 'resolved_at',
    resolvedBy: 'resolved_by',
    triggeredAt: 'triggered_at',
  },
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'id', orgId: 'org_id', siteId: 'site_id', tags: 'tags' },
}));

const latestVerdictsForAlerts = vi.hoisted(() => vi.fn());
vi.mock('./alertVerdicts', () => ({ latestVerdictsForAlerts }));

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));

import { db } from '../../db';
import type { BreezeEvent } from '../eventBus';
import { handleAlertVerdictEvent, AUTO_RESOLVE_VERDICT_WINDOW_MINUTES } from './alertVerdictSubscriber';

const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000e2';
const ALERT_ID = '00000000-0000-4000-8000-0000000000e3';
const GROUP_ID = '00000000-0000-4000-8000-0000000000e4';

interface AlertVerdictRowFixture {
  id: string;
  deviceId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  ruleId: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  triggeredAt: Date;
}

const BASE_ALERT_ROW: AlertVerdictRowFixture = {
  id: ALERT_ID,
  deviceId: DEVICE_ID,
  severity: 'high',
  ruleId: 'rule-1',
  resolvedAt: null,
  resolvedBy: null,
  triggeredAt: new Date('2026-08-28T00:00:00.000Z'),
};

const BASE_DEVICE_ROW = { siteId: 'site-1', tags: ['prod'] };

function groupCreatedEvent(payload: Record<string, unknown> = {}, over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-group-1',
    type: 'alert.correlation_group.created',
    orgId: ORG_ID,
    source: 'alert-correlation',
    priority: 'normal',
    payload: { groupId: GROUP_ID, rootAlertId: ALERT_ID, memberCount: 4, deviceId: DEVICE_ID, ...payload },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

function alertResolvedEvent(payload: Record<string, unknown> = {}, over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-resolved-1',
    type: 'alert.resolved',
    orgId: ORG_ID,
    source: 'alert-service',
    priority: 'normal',
    payload: { alertId: ALERT_ID, ruleId: 'rule-1', deviceId: DEVICE_ID, resolutionNote: null, ...payload },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

let lastAlertWhereMock: ReturnType<typeof vi.fn> | undefined;
let lastDeviceWhereMock: ReturnType<typeof vi.fn> | undefined;

/** db.select().from().where().limit() -> rows. */
function queueSelect(rows: unknown[], capture?: (whereMock: ReturnType<typeof vi.fn>) => void) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  capture?.(whereMock);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({ where: whereMock }),
  } as never);
}

function queueAlert(rows: unknown[]) {
  queueSelect(rows, (w) => { lastAlertWhereMock = w; });
}

function queueDevice(rows: unknown[]) {
  queueSelect(rows, (w) => { lastDeviceWhereMock = w; });
}

/** The common "admission proceeds" setup for the group path: root alert found, device found. */
function mockCleanGroup(alertOverrides: Partial<typeof BASE_ALERT_ROW> = {}) {
  queueAlert([{ ...BASE_ALERT_ROW, ...alertOverrides }]);
  queueDevice([BASE_DEVICE_ROW]);
}

/** The common "admission proceeds" setup for the resolved path: alert found (auto-resolved,
 *  in-window), no existing verdict, device found for the alertContext build. */
function mockCleanAutoResolve(alertOverrides: Partial<typeof BASE_ALERT_ROW> = {}) {
  const resolvedAlert = {
    ...BASE_ALERT_ROW,
    resolvedBy: null,
    resolvedAt: new Date('2026-08-28T00:10:00.000Z'),
    ...alertOverrides,
  };
  queueAlert([resolvedAlert]); // gating read in handleAlertVerdictEvent
  latestVerdictsForAlerts.mockResolvedValue(new Map());
  queueAlert([resolvedAlert]); // re-load inside enqueueVerdictRunForAlert
  queueDevice([BASE_DEVICE_ROW]);
}

beforeEach(() => {
  shared.aiAgentsEnabled = true;
  vi.mocked(db.select).mockReset();
  latestVerdictsForAlerts.mockReset().mockResolvedValue(new Map());
  createAndEnqueueAgentRun.mockReset().mockResolvedValue({
    created: true,
    run: { id: 'run-1' },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ai-agent-alert-verdict subscriber', () => {
  describe('alert.correlation_group.created', () => {
    it('admits one verdict run per created group with the root alert as run alert', async () => {
      mockCleanGroup();

      await handleAlertVerdictEvent(groupCreatedEvent());

      expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG_ID,
        kind: 'triage',
        triggerKind: 'alert',
        profile: 'verdict',
        alertId: ALERT_ID,
        correlationGroupId: GROUP_ID,
        deviceId: DEVICE_ID,
        dedupeKey: `group-verdict:${GROUP_ID}`,
        triggerRef: { verdictReason: 'group_created', groupId: GROUP_ID, alertId: ALERT_ID },
      }));
    });

    it('builds alertContext from the root alert row and its device', async () => {
      mockCleanGroup({ severity: 'critical', ruleId: 'rule-critical' });

      await handleAlertVerdictEvent(groupCreatedEvent());

      expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        alertContext: {
          severity: 'critical',
          ruleId: 'rule-critical',
          siteId: 'site-1',
          deviceTags: ['prod'],
        },
      }));
    });

    it('skips with a warning and admits no run when rootAlertId is null in the payload', async () => {
      await handleAlertVerdictEvent(groupCreatedEvent({ rootAlertId: null }));

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });

    it('skips with a warning and admits no run when deviceId is null in the payload', async () => {
      await handleAlertVerdictEvent(groupCreatedEvent({ deviceId: null }));

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });

    it('skips admission when the root alert is not found (or not in org)', async () => {
      queueAlert([]);

      await handleAlertVerdictEvent(groupCreatedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });

    it('skips admission when the root alert device is not found (or not in org)', async () => {
      queueAlert([BASE_ALERT_ROW]);
      queueDevice([]);

      await handleAlertVerdictEvent(groupCreatedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });

    it('does not throw and does not admit when the event payload has no groupId', async () => {
      await expect(
        handleAlertVerdictEvent(groupCreatedEvent({ groupId: undefined })),
      ).resolves.toBeUndefined();
      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('root alert lookup WHERE clause is org-pinned', async () => {
      mockCleanGroup();
      await handleAlertVerdictEvent(groupCreatedEvent());

      const whereArg = lastAlertWhereMock!.mock.calls[0]?.[0];
      const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);
      expect(sqlText).toBe('($1 = $2 and $3 = $4)');
      expect(params).toEqual(['id', ALERT_ID, 'org_id', ORG_ID]);
    });
  });

  describe('alert.resolved', () => {
    it('admits a verdict run for an AUTO-resolved alert (resolvedBy null, within the window)', async () => {
      mockCleanAutoResolve();

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG_ID,
        kind: 'triage',
        triggerKind: 'alert',
        profile: 'verdict',
        alertId: ALERT_ID,
        deviceId: DEVICE_ID,
        dedupeKey: `alert-verdict:${ALERT_ID}`,
        triggerRef: { verdictReason: 'auto_resolved', alertId: ALERT_ID },
      }));
    });

    it('ignores a HUMAN resolve (resolvedBy set)', async () => {
      queueAlert([{
        ...BASE_ALERT_ROW,
        resolvedBy: 'user-1',
        resolvedAt: new Date('2026-08-28T00:05:00.000Z'),
      }]);

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(latestVerdictsForAlerts).not.toHaveBeenCalled();
    });

    it(`ignores an auto-resolve outside the ${AUTO_RESOLVE_VERDICT_WINDOW_MINUTES}-minute window`, async () => {
      queueAlert([{
        ...BASE_ALERT_ROW,
        resolvedBy: null,
        resolvedAt: new Date('2026-08-28T01:00:00.001Z'), // 60:00.001 after triggeredAt
      }]);

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });

    it('admits at exactly the 30-minute boundary', async () => {
      const resolvedAlert = {
        ...BASE_ALERT_ROW,
        resolvedBy: null,
        resolvedAt: new Date('2026-08-28T00:30:00.000Z'), // exactly 30:00 after triggeredAt
      };
      queueAlert([resolvedAlert]);
      latestVerdictsForAlerts.mockResolvedValue(new Map());
      queueAlert([resolvedAlert]);
      queueDevice([BASE_DEVICE_ROW]);

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).toHaveBeenCalled();
    });

    it('ignores alert.resolved when the alert already carries a verdict', async () => {
      queueAlert([{
        ...BASE_ALERT_ROW,
        resolvedBy: null,
        resolvedAt: new Date('2026-08-28T00:10:00.000Z'),
      }]);
      latestVerdictsForAlerts.mockResolvedValue(new Map([[ALERT_ID, { id: 'verdict-1' }]]));

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });

    it('skips admission when the alert is not found (or not in org)', async () => {
      queueAlert([]);

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(latestVerdictsForAlerts).not.toHaveBeenCalled();
    });

    it('does not throw and does not admit when the event payload has no alertId', async () => {
      await expect(
        handleAlertVerdictEvent(alertResolvedEvent({ alertId: undefined })),
      ).resolves.toBeUndefined();
      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    // C2 fix (P2-1 wave B, task 16d) — the auto-resolve sweep publishes
    // `alert.resolved` from inside the SAME transaction that performed the
    // UPDATE, before it commits. A re-read on this subscriber's own
    // connection can then see the PRE-update row. These pin that resolve
    // state is decided from the PUBLISHED PAYLOAD, never from such a read.
    describe('payload-gated resolve state (C2 fix)', () => {
      it('admits a system resolve using the PAYLOAD even when the row read still shows a stale resolvedAt: null', async () => {
        const staleRow = { ...BASE_ALERT_ROW, resolvedAt: null, resolvedBy: null };
        queueAlert([staleRow]); // gating/context read — still shows the PRE-commit row
        latestVerdictsForAlerts.mockResolvedValue(new Map());
        queueAlert([staleRow]); // re-load inside enqueueVerdictRunForAlert
        queueDevice([BASE_DEVICE_ROW]);

        await handleAlertVerdictEvent(alertResolvedEvent({
          resolvedBy: null,
          resolvedAt: '2026-08-28T00:10:00.000Z',
          triggeredAt: '2026-08-28T00:00:00.000Z',
        }));

        expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(expect.objectContaining({
          alertId: ALERT_ID,
          dedupeKey: `alert-verdict:${ALERT_ID}`,
        }));
      });

      it('a human resolvedBy in the PAYLOAD skips even when the row itself looks like a system resolve', async () => {
        queueAlert([{ ...BASE_ALERT_ROW, resolvedBy: null, resolvedAt: new Date('2026-08-28T00:10:00.000Z') }]);

        await handleAlertVerdictEvent(alertResolvedEvent({
          resolvedBy: 'user-1',
          resolvedAt: '2026-08-28T00:10:00.000Z',
          triggeredAt: '2026-08-28T00:00:00.000Z',
        }));

        expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
        expect(latestVerdictsForAlerts).not.toHaveBeenCalled();
      });

      it(`skips when resolvedAt - triggeredAt in the PAYLOAD exceeds ${AUTO_RESOLVE_VERDICT_WINDOW_MINUTES} minutes`, async () => {
        queueAlert([{ ...BASE_ALERT_ROW, resolvedBy: null, resolvedAt: new Date('2026-08-28T00:05:00.000Z') }]);

        await handleAlertVerdictEvent(alertResolvedEvent({
          resolvedBy: null,
          resolvedAt: '2026-08-28T01:00:00.001Z',
          triggeredAt: '2026-08-28T00:00:00.000Z',
        }));

        expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
      });

      // Task 16e fix: an unparseable ISO string parses to `Invalid Date`,
      // whose `.getTime()` is `NaN` — and `NaN > WINDOW` is `false`, so
      // without the fail-closed guard this would fall through the window
      // check above and admit the run instead of skipping it.
      it('fails closed (skips with a warning, no run admitted) when resolvedAt in the PAYLOAD is unparseable', async () => {
        queueAlert([{ ...BASE_ALERT_ROW, resolvedBy: null, resolvedAt: new Date('2026-08-28T00:05:00.000Z') }]);

        await handleAlertVerdictEvent(alertResolvedEvent({
          resolvedBy: null,
          resolvedAt: 'not-a-real-timestamp',
          triggeredAt: '2026-08-28T00:00:00.000Z',
        }));

        expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
        expect(latestVerdictsForAlerts).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalled();
      });

      it('fails closed the same way when triggeredAt in the PAYLOAD is unparseable', async () => {
        queueAlert([{ ...BASE_ALERT_ROW, resolvedBy: null, resolvedAt: new Date('2026-08-28T00:05:00.000Z') }]);

        await handleAlertVerdictEvent(alertResolvedEvent({
          resolvedBy: null,
          resolvedAt: '2026-08-28T00:05:00.000Z',
          triggeredAt: 'also-not-a-real-timestamp',
        }));

        expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalled();
      });

      it('falls back to the ROW when the payload carries only SOME of resolvedBy/resolvedAt/triggeredAt (older publisher shape)', async () => {
        // Row: system resolve, 10 minutes after trigger — in-window admit.
        mockCleanAutoResolve();

        // Payload only has resolvedBy — resolvedAt/triggeredAt are absent,
        // so the gate must not treat this as payload-gated.
        await handleAlertVerdictEvent(alertResolvedEvent({ resolvedBy: null }));

        expect(createAndEnqueueAgentRun).toHaveBeenCalled();
      });
    });
  });

  describe('feature gate', () => {
    it('is a no-op (no DB reads, no admission) when AI_AGENTS_ENABLED is false, for a group event', async () => {
      shared.aiAgentsEnabled = false;

      await handleAlertVerdictEvent(groupCreatedEvent());

      expect(db.select).not.toHaveBeenCalled();
      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });

    it('is a no-op (no DB reads, no admission) when AI_AGENTS_ENABLED is false, for a resolved event', async () => {
      shared.aiAgentsEnabled = false;

      await handleAlertVerdictEvent(alertResolvedEvent());

      expect(db.select).not.toHaveBeenCalled();
      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });
  });

  describe('retry contract', () => {
    it('throws on createAndEnqueue failure so the durable dispatcher retries', async () => {
      mockCleanGroup();
      createAndEnqueueAgentRun.mockRejectedValue(new Error('enqueue boom'));

      await expect(handleAlertVerdictEvent(groupCreatedEvent())).rejects.toThrow('enqueue boom');
    });

    it('treats a { created: false, skipped } admission as success (no retry)', async () => {
      mockCleanGroup();
      createAndEnqueueAgentRun.mockResolvedValue({ created: false, skipped: 'trigger_filter_mismatch' });

      await expect(handleAlertVerdictEvent(groupCreatedEvent())).resolves.toBeUndefined();
    });

    it('rethrows when the underlying alert lookup itself fails', async () => {
      vi.mocked(db.select).mockImplementationOnce(() => {
        throw new Error('db boom');
      });

      await expect(handleAlertVerdictEvent(groupCreatedEvent())).rejects.toThrow('db boom');
      expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    });
  });
});
