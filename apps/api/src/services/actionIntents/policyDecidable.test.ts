import { describe, it, expect } from 'vitest';
import {
  POLICY_DECIDABLE_TIER3,
  isPolicyDecidableKey,
  validateAuthorizationKeys,
  rejectionReasonFor,
} from './policyDecidable';
import {
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS,
  TIER3_SUPERVISED_TOOLS,
} from '../aiGuardrails';
import { requiresLiveSession } from '../aiTools';

const EXPECTED_KEYS = [
  'manage_services:start',
  'manage_services:stop',
  'manage_services:restart',
  'manage_startup_items:disable',
  'manage_startup_items:enable',
  'manage_scheduled_tasks:run',
  'manage_scheduled_tasks:disable',
  'manage_scheduled_tasks:enable',
  'security_scan:quarantine',
  'security_scan:remove',
  'security_scan:restore',
];

describe('POLICY_DECIDABLE_TIER3 — v1 frozen key set', () => {
  it('is exactly the v1 conservative entry set, no more no less', () => {
    const keys = POLICY_DECIDABLE_TIER3.map((e) => e.key).sort();
    expect(keys).toEqual([...EXPECTED_KEYS].sort());
  });

  it('is frozen (Object.freeze) so nobody mutates it at runtime', () => {
    expect(Object.isFrozen(POLICY_DECIDABLE_TIER3)).toBe(true);
  });

  it('every key matches its own toolName/action pair', () => {
    for (const entry of POLICY_DECIDABLE_TIER3) {
      expect(entry.key).toBe(entry.action ? `${entry.toolName}:${entry.action}` : entry.toolName);
    }
  });

  it('every entry declares maxTargetCardinality 1 and requiresEffectPin true (v1 invariant)', () => {
    for (const entry of POLICY_DECIDABLE_TIER3) {
      expect(entry.maxTargetCardinality).toBe(1);
      expect(entry.requiresEffectPin).toBe(true);
    }
  });

  it('every entry claims headlessCompatible: true, and requiresLiveSession agrees', () => {
    for (const entry of POLICY_DECIDABLE_TIER3) {
      expect(entry.headlessCompatible).toBe(true);
      expect(requiresLiveSession(entry.toolName)).toBe(false);
    }
  });
});

describe('POLICY_DECIDABLE_TIER3 ⊆ TIER3_SUPERVISED', () => {
  it('every (tool, action) entry resolves to the supervised scope, never four_eyes', () => {
    for (const entry of POLICY_DECIDABLE_TIER3) {
      const { toolName, action } = entry;
      const inSupervisedActions = action ? TIER3_SUPERVISED_ACTIONS[toolName]?.includes(action) : false;
      const inSupervisedTool = TIER3_SUPERVISED_TOOLS.has(toolName);
      expect(
        inSupervisedActions || inSupervisedTool,
        `${entry.key} is not classified supervised anywhere in aiGuardrails`,
      ).toBe(true);
    }
  });
});

describe('POLICY_DECIDABLE_TIER3 ∩ TIER3_FOUR_EYES = ∅', () => {
  it('no entry is also classified four_eyes', () => {
    for (const entry of POLICY_DECIDABLE_TIER3) {
      const { toolName, action } = entry;
      const inFourEyesActions = action ? TIER3_FOUR_EYES_ACTIONS[toolName]?.includes(action) : false;
      const inFourEyesTool = TIER3_FOUR_EYES_TOOLS.has(toolName);
      expect(inFourEyesActions, `${entry.key} is listed in TIER3_FOUR_EYES_ACTIONS`).toBeFalsy();
      expect(inFourEyesTool, `${entry.key}'s tool is listed in TIER3_FOUR_EYES_TOOLS`).toBe(false);
    }
  });
});

describe('isPolicyDecidableKey', () => {
  it('true for every registered key', () => {
    for (const key of EXPECTED_KEYS) {
      expect(isPolicyDecidableKey(key)).toBe(true);
    }
  });

  it('false for an unregistered key', () => {
    expect(isPolicyDecidableKey('manage_services:list')).toBe(false);
    expect(isPolicyDecidableKey('run_script')).toBe(false);
    expect(isPolicyDecidableKey('')).toBe(false);
  });
});

describe('validateAuthorizationKeys', () => {
  it('accepts every registered v1 key', () => {
    const { ok, rejected } = validateAuthorizationKeys(EXPECTED_KEYS);
    expect(ok.sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(rejected).toEqual([]);
  });

  it('rejects a key not present in the registry', () => {
    const { ok, rejected } = validateAuthorizationKeys(['manage_services:list']);
    expect(ok).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.key).toBe('manage_services:list');
    expect(rejected[0]?.reason).toMatch(/not registered/);
  });

  it('rejects a four_eyes tool/action pair even if hypothetically registered', () => {
    // manage_invoices:issue is a real TIER3_FOUR_EYES_ACTIONS member and is
    // NOT in POLICY_DECIDABLE_TIER3, so it is caught by the "not registered"
    // branch — this proves the registry itself never smuggled one in, which
    // is what the containment describe block above pins directly.
    const { rejected } = validateAuthorizationKeys(['manage_invoices:issue']);
    expect(rejected[0]?.reason).toMatch(/not registered/);
  });

  it('rejects a Tier 4 / blocked tool key', () => {
    const { rejected } = validateAuthorizationKeys(['delete_tenant']);
    expect(rejected[0]?.reason).toMatch(/not registered/);
  });

  it('rejects a secret-bearing tool key', () => {
    const { rejected } = validateAuthorizationKeys(['m365_reset_password']);
    expect(rejected[0]?.reason).toMatch(/not registered/);
  });

  it('rejects a bare-tool key for a multiplexed tool', () => {
    const { rejected } = validateAuthorizationKeys(['manage_services']);
    expect(rejected[0]?.reason).toMatch(/not registered/);
  });

  it('mixed input partitions correctly and preserves input order within each bucket', () => {
    const { ok, rejected } = validateAuthorizationKeys([
      'manage_services:start',
      'not_a_real_key',
      'security_scan:quarantine',
      'manage_invoices:issue',
    ]);
    expect(ok).toEqual(['manage_services:start', 'security_scan:quarantine']);
    expect(rejected.map((r) => r.key)).toEqual(['not_a_real_key', 'manage_invoices:issue']);
  });

  it('empty input yields empty output', () => {
    expect(validateAuthorizationKeys([])).toEqual({ ok: [], rejected: [] });
  });
});

describe('rejectionReasonFor — structural headlessCompatible enforcement (review fix, #3827)', () => {
  // Every REAL entry in POLICY_DECIDABLE_TIER3 already declares
  // `headlessCompatible: true` (pinned by the "every entry claims
  // headlessCompatible: true" test above), so `validateAuthorizationKeys`
  // can never exercise this branch through the public API today — this is
  // exactly why it's a defense-in-depth structural check, not a live gate,
  // and why it has to be tested against a synthetic entry directly.
  it('rejects a synthetic entry that claims headlessCompatible: false', () => {
    const fakeEntry = {
      key: 'not_a_real_tool:not_a_real_action',
      toolName: 'not_a_real_tool',
      action: 'not_a_real_action',
      headlessCompatible: false,
      maxTargetCardinality: 1 as const,
      requiresEffectPin: true,
      note: 'synthetic test fixture only — never in the real registry',
    };
    expect(rejectionReasonFor(fakeEntry)).toBe('not headless-compatible');
  });

  it('passes a synthetic entry through to the LATER checks when headlessCompatible: true (does not falsely reject)', () => {
    const fakeEntry = {
      key: 'not_a_real_tool:not_a_real_action',
      toolName: 'not_a_real_tool',
      action: 'not_a_real_action',
      headlessCompatible: true,
      maxTargetCardinality: 1 as const,
      requiresEffectPin: true,
      note: 'synthetic test fixture only — never in the real registry',
    };
    expect(rejectionReasonFor(fakeEntry)).toBeNull();
  });
});
