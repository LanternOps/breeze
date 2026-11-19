import { beforeEach, describe, expect, it, vi } from 'vitest';

// #11306 — new remote access / RMM tool alerts. Every alert goes through
// createAlert (dedupe, cooldown, outbox, notifications), never a bare insert
// into `alerts` (#5241).

const dbState = vi.hoisted(() => ({
  selects: [] as unknown[][],
  inserts: [] as Array<{ values: Record<string, unknown> }>,
}));

vi.mock('../../db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      orderBy: () => c,
      limit: () => Promise.resolve(rows),
    };
    return c;
  };
  return {
    db: {
      select: vi.fn(() => chain(dbState.selects.shift() ?? [])),
      insert: vi.fn(() => ({
        values: (values: Record<string, unknown>) => {
          dbState.inserts.push({ values });
          return { returning: () => Promise.resolve([{ id: 'template-1' }]) };
        },
      })),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    // Even inside a system context, each raise opens its own transaction.
    getCurrentDbAccessContext: vi.fn(() => ({ scope: 'system' })),
  };
});

vi.mock('../alertService', () => ({ createAlert: vi.fn(async () => 'alert-1') }));
vi.mock('../builtInAlertRules', () => ({ insertBuiltInAlertRule: vi.fn(async () => 'rule-new') }));
vi.mock('../featureConfigResolver', () => ({
  checkDeviceMaintenanceWindow: vi.fn(async () => ({ active: false, suppressAlerts: false })),
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import * as dbModule from '../../db';
import { createAlert } from '../alertService';
import { insertBuiltInAlertRule } from '../builtInAlertRules';
import { checkDeviceMaintenanceWindow } from '../featureConfigResolver';
import { captureException } from '../sentry';
import {
  MANAGEMENT_POSTURE_ALERT_SOURCE,
  raiseRemoteToolAppearedAlerts,
  remoteToolRuleName,
} from './alerts';

const DEVICE_ID = 'device-1';
const ORG_ID = 'org-1';
const DETECTED_AT = '2026-11-06T10:00:00.000Z';

describe('remoteToolRuleName', () => {
  it('names the rule by category and tool', () => {
    expect(remoteToolRuleName({ name: 'UltraViewer', category: 'remoteAccess' })).toBe('New remote access tool: UltraViewer');
    expect(remoteToolRuleName({ name: 'ScreenConnect', category: 'rmm' })).toBe('New RMM agent: ScreenConnect');
  });
});

describe('raiseRemoteToolAppearedAlerts', () => {
  beforeEach(() => {
    dbState.selects = [];
    dbState.inserts = [];
    vi.mocked(createAlert).mockReset();
    vi.mocked(createAlert).mockResolvedValue('alert-1');
    vi.mocked(insertBuiltInAlertRule).mockClear();
    vi.mocked(captureException).mockClear();
    vi.mocked(dbModule.withSystemDbAccessContext).mockClear();
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValue({ active: false, suppressAlerts: false } as never);
  });

  it('creates the org rule on first fire under the management-posture source and raises a warning for a remote access tool', async () => {
    dbState.selects = [
      [{ hostname: 'desk-01', displayName: null }], // host label
      [], // no rule yet
      [], // no template yet
    ];
    const outcome = await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      detectedAt: DETECTED_AT,
      tools: [{ name: 'UltraViewer', category: 'remoteAccess', status: 'installed' }],
    });

    expect(outcome).toEqual({ raised: ['UltraViewer'], held: [], failed: [], suppressedByMaintenance: false });
    expect(dbState.inserts[0]!.values).toMatchObject({
      orgId: null,
      partnerId: null,
      name: 'New remote access tool detected',
      isBuiltIn: true,
      severity: 'medium',
      conditions: { source: MANAGEMENT_POSTURE_ALERT_SOURCE, toolCategory: 'remoteAccess' },
    });
    expect(insertBuiltInAlertRule).toHaveBeenCalledWith({
      orgId: ORG_ID,
      templateId: 'template-1',
      name: 'New remote access tool: UltraViewer',
      overrideSettings: { source: 'management-posture', toolName: 'UltraViewer', toolCategory: 'remoteAccess' },
    });
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-new',
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      severity: 'medium',
      title: 'New remote access tool on desk-01: UltraViewer',
      context: expect.objectContaining({
        source: 'management-posture',
        toolName: 'UltraViewer',
        toolCategory: 'remoteAccess',
        detectionStatus: 'installed',
        detectedAt: DETECTED_AT,
      }),
    }));
    // The template is global and the rule org-owned: system scope.
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('reuses the existing rule and raises an RMM agent at info', async () => {
    dbState.selects = [[{ hostname: 'desk-01', displayName: 'Front desk' }], [{ id: 'rule-existing' }]];
    await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID,
      orgId: ORG_ID,
      detectedAt: DETECTED_AT,
      tools: [{ name: 'ScreenConnect', category: 'rmm', status: 'active' }],
    });
    expect(insertBuiltInAlertRule).not.toHaveBeenCalled();
    expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({
      ruleId: 'rule-existing',
      severity: 'info',
      title: 'New RMM agent on Front desk: ScreenConnect',
    }));
  });

  it('reuses the global template when the org has no rule for the tool yet', async () => {
    dbState.selects = [[{ hostname: 'desk-01' }], [], [{ id: 'template-existing' }]];
    await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID, orgId: ORG_ID, detectedAt: DETECTED_AT,
      tools: [{ name: 'RustDesk', category: 'remoteAccess', status: 'active' }],
    });
    expect(dbState.inserts).toEqual([]);
    expect(insertBuiltInAlertRule).toHaveBeenCalledWith(expect.objectContaining({
      templateId: 'template-existing',
      name: 'New remote access tool: RustDesk',
    }));
  });

  it('counts an alert createAlert held back (rule off, open alert, cooldown) as held, not raised', async () => {
    dbState.selects = [[{ hostname: 'desk-01' }], [{ id: 'rule-existing' }]];
    vi.mocked(createAlert).mockResolvedValueOnce(null);
    const outcome = await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID, orgId: ORG_ID, detectedAt: DETECTED_AT,
      tools: [{ name: 'AnyDesk', category: 'remoteAccess', status: null }],
    });
    expect(outcome.held).toEqual(['AnyDesk']);
    expect(outcome.raised).toEqual([]);
  });

  it('raises nothing inside a maintenance window that suppresses alerts', async () => {
    vi.mocked(checkDeviceMaintenanceWindow).mockResolvedValueOnce({ active: true, suppressAlerts: true } as never);
    dbState.selects = [[{ hostname: 'desk-01' }]];
    const outcome = await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID, orgId: ORG_ID, detectedAt: DETECTED_AT,
      tools: [{ name: 'AnyDesk', category: 'remoteAccess', status: null }],
    });
    expect(outcome.suppressedByMaintenance).toBe(true);
    expect(createAlert).not.toHaveBeenCalled();
  });

  it('keeps going after one tool fails, and reports the failure instead of throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbState.selects = [[{ hostname: 'desk-01' }], [{ id: 'rule-a' }], [{ id: 'rule-b' }]];
    vi.mocked(createAlert).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce('alert-2');
    const outcome = await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID, orgId: ORG_ID, detectedAt: DETECTED_AT,
      tools: [
        { name: 'AnyDesk', category: 'remoteAccess', status: null },
        { name: 'UltraViewer', category: 'remoteAccess', status: null },
      ],
    });
    expect(outcome).toEqual({ raised: ['UltraViewer'], held: [], failed: ['AnyDesk'], suppressedByMaintenance: false });
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toEqual({ errorId: 'remote-tool-alert-failed', tool: 'AnyDesk' });
    // Each tool in its own transaction (prelude + one per tool), even though the
    // mock reports an ambient system context: the failed one cannot abort the next.
    expect(dbModule.withSystemDbAccessContext).toHaveBeenCalledTimes(3);
    consoleError.mockRestore();
  });

  it('does not throw when the maintenance read fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(checkDeviceMaintenanceWindow).mockRejectedValueOnce(new Error('db down'));
    const outcome = await raiseRemoteToolAppearedAlerts({
      deviceId: DEVICE_ID, orgId: ORG_ID, detectedAt: DETECTED_AT,
      tools: [{ name: 'AnyDesk', category: 'remoteAccess', status: null }],
    });
    expect(outcome.failed).toEqual(['AnyDesk']);
    expect(createAlert).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
