// #6745 (A-W05 follow-up): get_effective_configuration output shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';
import { CONFIG_FEATURE_TYPES } from '@breeze/shared/constants';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));
const { resolveEffectiveConfigMock } = vi.hoisted(() => ({ resolveEffectiveConfigMock: vi.fn() }));
vi.mock('./configurationPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./configurationPolicy')>()),
  resolveEffectiveConfig: resolveEffectiveConfigMock,
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const POLICY_ID = '44444444-4444-4444-8444-444444444444';

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerConfigPolicyTools(reg);
  return reg.get('get_effective_configuration')!;
}
const auth = () => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: 'p1', orgId: 'org-1', scope: 'organization', accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined, canAccessOrg: () => true, canAccessSite: () => true,
}) as unknown as AuthContext;

// Realistic inline settings: a patch/monitoring-style jsonb blob per feature.
const SETTINGS = {
  schedule: { frequency: 'weekly', dayOfWeek: 'tuesday', time: '02:00', timezone: 'America/Chicago' },
  thresholds: { cpuWarning: 80, cpuCritical: 95, ramWarning: 85, ramCritical: 95, diskWarning: 85, diskCritical: 95 },
  exclusions: ['KB5005565', 'KB5006670', 'KB5007186', 'KB5008212'],
  notify: { onFailure: true, onSuccess: false, recipients: ['helpdesk@example.com', 'noc@example.com'] },
  rebootPolicy: 'if_required', maintenanceWindowId: POLICY_ID,
};

function effective() {
  const features: Record<string, unknown> = {};
  for (const ft of CONFIG_FEATURE_TYPES) {
    features[ft] = {
      featureType: ft, featurePolicyId: POLICY_ID, inlineSettings: SETTINGS,
      sourceLevel: 'organization', sourceTargetId: POLICY_ID, sourcePolicyId: POLICY_ID,
      sourcePolicyName: 'Standard Workstation Baseline', sourcePriority: 10,
      inheritedFromPolicyId: null, inheritedFromPolicyName: null,
    };
  }
  return {
    deviceId: DEVICE_ID,
    features,
    inheritanceChain: [
      { level: 'organization', targetId: POLICY_ID, policyId: POLICY_ID, policyName: 'Standard Workstation Baseline', priority: 10, featureTypes: [...CONFIG_FEATURE_TYPES] },
      { level: 'partner', targetId: POLICY_ID, policyId: POLICY_ID, policyName: 'MSP Default', priority: 100, featureTypes: [...CONFIG_FEATURE_TYPES].slice(0, 5) },
    ],
  };
}

describe('get_effective_configuration output shape (#6745)', () => {
  beforeEach(() => { vi.clearAllMocks(); resolveEffectiveConfigMock.mockResolvedValue(effective()); });

  it('omits inlineSettings by default, reports which features carry them, and fits the budget', async () => {
    const raw = await tool().handler({ deviceId: DEVICE_ID }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    const first = out.features[CONFIG_FEATURE_TYPES[0]];
    expect(first.inlineSettings).toBeUndefined();
    expect(first.hasInlineSettings).toBe(true);
    expect(out.settingsOmitted).toBe(true);
    expect(out.note).toMatch(/includeSettings/);
    expect(Object.keys(out.features)).toHaveLength(CONFIG_FEATURE_TYPES.length);
    expectDefaultPageFits('get_effective_configuration', raw);
  });

  it('hasInlineSettings is false for empty or null settings', async () => {
    const cfg = effective();
    const [a, b] = CONFIG_FEATURE_TYPES;
    (cfg.features[a!] as Record<string, unknown>).inlineSettings = {};
    (cfg.features[b!] as Record<string, unknown>).inlineSettings = null;
    resolveEffectiveConfigMock.mockResolvedValue(cfg);
    const out = JSON.parse(await tool().handler({ deviceId: DEVICE_ID }, auth())) as Record<string, any>;
    expect(out.features[a!].hasInlineSettings).toBe(false);
    expect(out.features[b!].hasInlineSettings).toBe(false);
  });

  it('includeSettings + featureType returns that one feature with its settings', async () => {
    const ft = CONFIG_FEATURE_TYPES[0];
    const raw = await tool().handler({ deviceId: DEVICE_ID, includeSettings: true, featureType: ft }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(Object.keys(out.features)).toEqual([ft]);
    expect(out.features[ft].inlineSettings).toEqual(SETTINGS);
    expect(out.settingsOmitted).toBeUndefined();
    expect(out.inheritanceChain.every((e: { featureTypes: string[] }) => e.featureTypes.includes(ft))).toBe(true);
    expectDefaultPageFits('get_effective_configuration', raw);
  });

  // #10397: a blank windowStart was echoed raw and read as "never opens", and
  // nothing told the model that weekly means Sunday. The resolved schedule
  // rides next to the stored settings.
  it('maintenance with includeSettings carries the resolved schedule beside the stored settings', async () => {
    const cfg = effective();
    const maintenance = {
      recurrence: 'weekly', windowStart: '', durationHours: 2, timezone: 'America/Denver',
      suppressAlerts: true, suppressPatching: true, suppressAutomations: false, suppressScripts: false,
      rebootIfPending: true, notifyBeforeMinutes: 15, notifyOnStart: true, notifyOnEnd: true,
    };
    (cfg.features.maintenance as Record<string, unknown>).inlineSettings = maintenance;
    resolveEffectiveConfigMock.mockResolvedValue(cfg);
    const raw = await tool().handler({ deviceId: DEVICE_ID, includeSettings: true, featureType: 'maintenance' }, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.features.maintenance.inlineSettings).toEqual(maintenance);
    expect(out.features.maintenance.effectiveSchedule).toMatchObject({
      recurrence: 'weekly', opensOn: 'Sunday', startTime: '00:00', startTimeSource: 'default_midnight',
      durationHours: 2, timezone: 'America/Denver',
    });
    expect(out.features.maintenance.effectiveSchedule.nextWindow.startsAt).toMatch(/Z$/);
    expectDefaultPageFits('get_effective_configuration', raw);
  });

  it('non-maintenance features and the compact page carry no effectiveSchedule', async () => {
    const all = JSON.parse(await tool().handler({ deviceId: DEVICE_ID, includeSettings: true }, auth())) as Record<string, any>;
    // SETTINGS is not a maintenance shape, so even the maintenance slot gets none.
    for (const feature of Object.values(all.features)) expect((feature as any).effectiveSchedule).toBeUndefined();
    const compact = JSON.parse(await tool().handler({ deviceId: DEVICE_ID }, auth())) as Record<string, any>;
    expect(compact.features.maintenance.effectiveSchedule).toBeUndefined();
  });
});
