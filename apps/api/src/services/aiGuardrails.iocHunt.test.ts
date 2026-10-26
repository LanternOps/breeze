/**
 * `ioc_hunt` tiering, approval scope and approval headline (#6263 W05 PR B,
 * Gate B 4 and 6). The input-aware `sweep` scope is resolved from
 * `expectedDeviceCount` against `iocHuntFourEyesDeviceThreshold()` (25 by
 * default, env `IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_FOUR_EYES_TOOLS,
  TIER3_INPUT_AWARE_ACTIONS,
  TIER3_SUPERVISED_ACTIONS,
  TIER3_SUPERVISED_TOOLS,
  TIER_DECIDING_INPUT_KEYS,
  buildApprovalDescription,
  checkGuardrails,
  resolveApprovalScope,
} from './aiGuardrails';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET_A = '22222222-2222-4222-8222-222222222222';
const SET_B = '33333333-3333-4333-8333-333333333333';
const sweep = (extra: Record<string, unknown> = {}) => ({
  action: 'sweep', orgId: ORG, ruleSetIds: [SET_A], scope: { kind: 'all' }, scanType: 'quick', previewDigest: 'd'.repeat(64), ...extra,
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('ioc_hunt sweep approval scope (Gate B 6)', () => {
  it('is input-aware: in no static scope table and no whole-tool set', () => {
    expect(TIER3_INPUT_AWARE_ACTIONS.has('ioc_hunt:sweep')).toBe(true);
    expect(TIER3_FOUR_EYES_ACTIONS.ioc_hunt ?? []).not.toContain('sweep');
    expect(TIER3_SUPERVISED_ACTIONS.ioc_hunt ?? []).not.toContain('sweep');
    expect(TIER3_SUPERVISED_ACTIONS.ioc_hunt).toEqual(['import_iocs']);
    expect(TIER3_FOUR_EYES_TOOLS.has('ioc_hunt')).toBe(false);
    expect(TIER3_SUPERVISED_TOOLS.has('ioc_hunt')).toBe(false);
    expect(TIER_DECIDING_INPUT_KEYS.ioc_hunt).toEqual(['expectedDeviceCount']);
  });

  it('expectedDeviceCount 25 → supervised, 26 → four_eyes', () => {
    expect(resolveApprovalScope('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 0 }))).toBe('supervised');
    expect(resolveApprovalScope('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 25 }))).toBe('supervised');
    expect(resolveApprovalScope('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 26 }))).toBe('four_eyes');
  });

  it('missing, non-numeric, negative or fractional count → four_eyes', () => {
    for (const bad of [undefined, '25', -1, 1.5, null, Number.NaN]) {
      const input = bad === undefined ? sweep() : sweep({ expectedDeviceCount: bad });
      expect(resolveApprovalScope('ioc_hunt', 'sweep', input)).toBe('four_eyes');
    }
  });

  it('honours the env threshold', () => {
    vi.stubEnv('IOC_HUNT_FOUR_EYES_DEVICE_THRESHOLD', '5');
    expect(resolveApprovalScope('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 5 }))).toBe('supervised');
    expect(resolveApprovalScope('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 6 }))).toBe('four_eyes');
  });

  it('import_iocs is supervised; checkGuardrails surfaces the sweep scope', () => {
    expect(resolveApprovalScope('ioc_hunt', 'import_iocs', {})).toBe('supervised');
    const big = checkGuardrails('ioc_hunt', sweep({ expectedDeviceCount: 26 }));
    expect(big.tier).toBe(3);
    expect(big.approvalScope).toBe('four_eyes');
    expect(checkGuardrails('ioc_hunt', sweep({ expectedDeviceCount: 25 })).approvalScope).toBe('supervised');
  });
});

describe('ioc_hunt tiers', () => {
  // MCP's effective tier is max(registry tier 1, guardrail tier, floor); with
  // no ioc_hunt floor it equals the guardrail tier, the same one chat uses.
  it.each([
    ['list_rule_sets', 1], ['preview_sweep', 1], ['list_sweeps', 1], ['sweep_status', 1],
    ['cancel_sweep', 2], ['sweep', 3], ['import_iocs', 3],
  ] as const)('%s is tier %i in chat and over MCP', (action, tier) => {
    expect(checkGuardrails('ioc_hunt', { action }).tier).toBe(tier);
    expect(Math.max(1, checkGuardrails('ioc_hunt', { action }).tier)).toBe(tier);
  });

});

describe('ioc_hunt approval headline', () => {
  const snake = /[a-z]_[a-z]/;

  it('sweep names the set count, device ceiling and scope', () => {
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ ruleSetIds: [SET_A, SET_B], expectedDeviceCount: 12, scope: { kind: 'sites', siteIds: [SET_A, SET_B, ORG] } })))
      .toBe('IOC sweep (quick scan): 2 rule sets on up to 12 devices in this organization (3 sites)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 1 })))
      .toBe('IOC sweep (quick scan): 1 rule set on up to 1 device in this organization (all reachable devices)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 30, scanType: 'full' })))
      .toBe('IOC sweep (full scan): 1 rule set on up to 30 devices in this organization (all reachable devices)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 3, scanType: 'custom', paths: ['C:\\Temp', 'D:\\Share'] })))
      .toContain('IOC sweep (custom scan of 2 paths)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 4, scope: { kind: 'groups', groupIds: [SET_A] } })))
      .toContain('(1 group)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 4, scope: { kind: 'devices', deviceIds: [SET_A, SET_B] } })))
      .toContain('(2 devices)');
    expect(buildApprovalDescription('ioc_hunt', 'sweep', sweep({ expectedDeviceCount: 4, scope: { kind: 'orgs', orgIds: [ORG] } })))
      .toContain('(this organization)');
  });

  it('import_iocs and cancel_sweep headlines', () => {
    expect(buildApprovalDescription('ioc_hunt', 'import_iocs', { ruleSetId: SET_A, iocs: [{ kind: 'md5', value: 'x' }, { kind: 'ip', value: 'y' }] }))
      .toBe('Import 2 IOCs into rule set 22222222');
    expect(buildApprovalDescription('ioc_hunt', 'cancel_sweep', { sweepId: SET_B })).toBe('Cancel IOC sweep 33333333');
  });

  it('never renders snake_case, even with an empty input', () => {
    for (const action of ['sweep', 'import_iocs', 'cancel_sweep']) {
      expect(buildApprovalDescription('ioc_hunt', action, {})).not.toMatch(snake);
      expect(buildApprovalDescription('ioc_hunt', action, sweep({ expectedDeviceCount: 3 }))).not.toMatch(snake);
    }
  });
});
