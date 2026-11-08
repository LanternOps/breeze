/**
 * #11328 — a log correlation rule with `alertOnMatch` raised its alert through
 * a raw `db.insert(alerts)`. The row showed up in the inbox, but no
 * `alert.triggered` was ever published, so notification channels, routing
 * rules and escalation never saw it. The alert now goes through
 * `createSourcedAlert`, which stages the event with the row and announces it
 * after COMMIT.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertReturningQueue: [] as unknown[][],
  inserts: [] as Array<{ table: unknown; values: unknown }>,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
}));

vi.mock('../db', () => {
  const chain = (result: () => Promise<unknown>) => {
    const builder: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'orderBy']) builder[method] = vi.fn(() => builder);
    builder.limit = vi.fn(() => result());
    return builder;
  };
  return {
    db: {
      select: vi.fn(() => chain(async () => h.selectQueue.shift() ?? [])),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          h.inserts.push({ table, values });
          return { returning: vi.fn(async () => h.insertReturningQueue.shift() ?? []) };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((set: Record<string, unknown>) => {
          h.updates.push({ table, set });
          return { where: vi.fn(async () => undefined) };
        }),
      })),
    },
  };
});

vi.mock('./alertService', () => ({
  createSourcedAlert: vi.fn(),
}));

import { alerts, logCorrelationRules, logCorrelations } from '../db/schema';
import { createSourcedAlert } from './alertService';
import { persistCorrelationForRule } from './logSearch';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const RULE_ID = '00000000-0000-4000-8000-000000000002';
const DEVICE_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_DEVICE_ID = '00000000-0000-4000-8000-000000000004';
const CORRELATION_ID = '00000000-0000-4000-8000-000000000005';
const ALERT_ID = '00000000-0000-4000-8000-000000000006';

function rule(overrides: Record<string, unknown> = {}) {
  return {
    id: RULE_ID,
    orgId: ORG_ID,
    name: 'Repeated logon failures',
    description: null,
    pattern: 'logon failure',
    isRegex: false,
    minOccurrences: 3,
    minDevices: 2,
    timeWindow: 300,
    severity: 'error',
    alertOnMatch: true,
    isActive: true,
    lastMatchedAt: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  } as Parameters<typeof persistCorrelationForRule>[0];
}

function detection() {
  return {
    orgId: ORG_ID,
    pattern: 'logon failure',
    firstSeen: new Date('2026-11-07T10:00:00Z'),
    lastSeen: new Date('2026-11-07T10:04:00Z'),
    occurrences: 7,
    affectedDevices: [
      { deviceId: DEVICE_ID, hostname: 'host-a', count: 4 },
      { deviceId: OTHER_DEVICE_ID, hostname: 'host-b', count: 3 },
    ],
    sampleLogs: [],
    timeWindowSeconds: 300,
    minDevices: 2,
    minOccurrences: 3,
  } as unknown as Parameters<typeof persistCorrelationForRule>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.selectQueue = [];
  h.insertReturningQueue = [];
  h.inserts = [];
  h.updates = [];
});

describe('persistCorrelationForRule — correlation alert (#11328)', () => {
  it('raises the alert through createSourcedAlert so alert.triggered publishes, and links it to the correlation', async () => {
    h.selectQueue.push([]); // no active correlation for this rule yet
    h.insertReturningQueue.push([{ id: CORRELATION_ID, alertId: null }]);
    vi.mocked(createSourcedAlert).mockResolvedValueOnce(ALERT_ID);

    const result = await persistCorrelationForRule(rule(), detection());

    expect(result).toEqual({ correlationId: CORRELATION_ID, alertId: ALERT_ID });
    // The only insert is the correlation row: no raw alert insert.
    expect(h.inserts.map((i) => i.table)).toEqual([logCorrelations]);
    expect(h.inserts.some((i) => i.table === alerts)).toBe(false);

    expect(createSourcedAlert).toHaveBeenCalledTimes(1);
    const params = vi.mocked(createSourcedAlert).mock.calls[0]![0];
    expect(params).toMatchObject({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      severity: 'high',
      title: 'Log correlation detected: Repeated logon failures',
      publisher: 'log-correlation',
      context: {
        source: 'log_correlation',
        correlationRuleId: RULE_ID,
        correlationId: CORRELATION_ID,
      },
    });
    expect(params.owner).toBeUndefined();

    const link = h.updates.find((u) => u.table === logCorrelations && 'alertId' in u.set);
    expect(link?.set).toEqual({ alertId: ALERT_ID });
  });

  it('does not raise (or re-publish) an alert when the active correlation already has one', async () => {
    h.selectQueue.push([{ id: CORRELATION_ID, alertId: ALERT_ID, firstSeen: new Date('2026-11-07T09:00:00Z') }]);

    const result = await persistCorrelationForRule(rule(), detection());

    expect(result).toEqual({ correlationId: CORRELATION_ID, alertId: ALERT_ID });
    expect(createSourcedAlert).not.toHaveBeenCalled();
    expect(h.inserts).toEqual([]);
  });

  it('raises nothing for a rule without alertOnMatch', async () => {
    h.selectQueue.push([]);
    h.insertReturningQueue.push([{ id: CORRELATION_ID, alertId: null }]);

    const result = await persistCorrelationForRule(rule({ alertOnMatch: false }), detection());

    expect(result).toEqual({ correlationId: CORRELATION_ID, alertId: null });
    expect(createSourcedAlert).not.toHaveBeenCalled();
  });

  it('leaves the correlation unlinked when createSourcedAlert produced no alert, so the next run retries', async () => {
    h.selectQueue.push([]);
    h.insertReturningQueue.push([{ id: CORRELATION_ID, alertId: null }]);
    vi.mocked(createSourcedAlert).mockResolvedValueOnce(null);

    const result = await persistCorrelationForRule(rule(), detection());

    expect(result).toEqual({ correlationId: CORRELATION_ID, alertId: null });
    expect(h.updates.some((u) => u.table === logCorrelations && 'alertId' in u.set)).toBe(false);
    // The rule's lastMatchedAt still moves.
    expect(h.updates.some((u) => u.table === logCorrelationRules)).toBe(true);
  });
});
