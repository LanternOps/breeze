import { describe, expect, it } from 'vitest';
import { CATALOG_BY_ID, MAX_ENROLLMENT_TTL_MINUTES } from '@breeze/shared';
import { classifyOrg, fieldInForce, fieldPartnerSet } from './classify';

const entry = (id: string) => {
  const found = CATALOG_BY_ID[id];
  if (!found) throw new Error(`no catalog entry ${id}`);
  return found;
};

describe('classifyOrg (one row per §5.4 kind)', () => {
  it('locks set + org has its own value → shadowed, not in effect', () => {
    const result = classifyOrg(entry('security.requireMfa'), { security: { requireMfa: true } }, false);
    expect(result).toMatchObject({ ownValue: true, shadowed: true, inEffect: false, overrides: false });
  });

  it('locks blank + org has its own value → in effect, not shadowed', () => {
    const result = classifyOrg(entry('security.requireMfa'), {}, false);
    expect(result).toMatchObject({ ownValue: true, shadowed: false, inEffect: true, overrides: false });
  });

  it('overridable set + org differs → overrides', () => {
    const result = classifyOrg(entry('defaults.agentVersionPins.agent'), { defaults: { agentVersionPins: { agent: '0.90.0' } } }, '0.91.0');
    expect(result).toMatchObject({ ownValue: true, overrides: true, shadowed: false, inEffect: true });
  });

  it('overridable set + org equal → own value in effect, not an override', () => {
    const result = classifyOrg(entry('defaults.agentVersionPins.agent'), { defaults: { agentVersionPins: { agent: '0.90.0' } } }, '0.90.0');
    expect(result).toMatchObject({ ownValue: true, overrides: false, shadowed: false, inEffect: true });
  });

  it('overridable blank + org set → ownValue && inEffect', () => {
    const result = classifyOrg(entry('defaults.defaultEnrollmentDeviceCount'), {}, 7);
    expect(result).toMatchObject({ ownValue: true, inEffect: true, overrides: false, shadowed: false });
  });

  it('cap: org above the ceiling → clamped', () => {
    const partner = { defaults: { defaultEnrollmentTtlMinutes: 60, maxEnrollmentLinkTtlMinutes: 120 } };
    expect(classifyOrg(entry('defaults.defaultEnrollmentTtlMinutes'), partner, 600)).toMatchObject({ ownValue: true, inEffect: true, clamped: true, overrides: true });
    expect(classifyOrg(entry('defaults.defaultEnrollmentTtlMinutes'), partner, 90)).toMatchObject({ ownValue: true, clamped: false });
    // No partner cap: the platform maximum is the ceiling.
    expect(classifyOrg(entry('defaults.defaultEnrollmentTtlMinutes'), {}, MAX_ENROLLMENT_TTL_MINUTES + 1).clamped).toBe(true);
  });

  it('conditional event logs, partner enabled without URL → not in force; the org destination is in effect', () => {
    const partner = { eventLogs: { enabled: true } };
    const orgDestination = { enabled: true, elasticsearchUrl: 'https://org.example' };
    expect(fieldInForce(entry('eventLogs'), partner)).toBe(false);
    expect(fieldPartnerSet(entry('eventLogs'), partner)).toBe(true);
    expect(classifyOrg(entry('eventLogs'), partner, orgDestination)).toMatchObject({ ownValue: true, inEffect: true, shadowed: false });
  });

  it('conditional event logs, partner in force → the org destination is shadowed', () => {
    const partner = { eventLogs: { enabled: true, elasticsearchUrl: 'https://partner.example' } };
    expect(fieldInForce(entry('eventLogs'), partner)).toBe(true);
    const result = classifyOrg(entry('eventLogs'), partner, { enabled: true, elasticsearchUrl: 'https://org.example' });
    expect(result).toMatchObject({ ownValue: true, inEffect: false, shadowed: true, overrides: null });
  });

  it('a disabled org destination is not an own value', () => {
    const result = classifyOrg(entry('eventLogs'), {}, { enabled: false, elasticsearchUrl: 'https://org.example' });
    expect(result).toMatchObject({ ownValue: false, inEffect: false, shadowed: false });
  });

  it('a blank org value counts as not set', () => {
    expect(classifyOrg(entry('notifications.pushoverAppToken'), {}, [{ value: '  ' }]).ownValue).toBe(false);
    expect(classifyOrg(entry('aiBudgets.maxTurnsPerSession'), {}, null).ownValue).toBe(false);
    expect(classifyOrg(entry('defaults.agentUpdatePolicy'), {}, undefined).ownValue).toBe(false);
  });

  it('an AI budget column the partner locks is shadowed; a partner null still locks', () => {
    expect(classifyOrg(entry('aiBudgets.maxTurnsPerSession'), { aiBudgets: { maxTurnsPerSession: 9 } }, 12)).toMatchObject({ ownValue: true, shadowed: true, inEffect: false });
    expect(classifyOrg(entry('aiBudgets.monthlyBudgetCents'), { aiBudgets: { monthlyBudgetCents: null } }, 500)).toMatchObject({ ownValue: true, shadowed: true, inEffect: false });
    expect(classifyOrg(entry('aiBudgets.monthlyBudgetCents'), { aiBudgets: {} }, 500)).toMatchObject({ ownValue: true, shadowed: false, inEffect: true });
  });

  it('a pushover org with two channels is one org; any channel with its own value counts', () => {
    const partner = { notifications: { pushoverDefaultSound: 'siren' } };
    const result = classifyOrg(entry('notifications.pushoverDefaultSound'), partner, [{ value: undefined }, { value: 'bike' }]);
    expect(result).toMatchObject({ ownValue: true, inEffect: true, overrides: true, shadowed: false });
    expect(classifyOrg(entry('notifications.pushoverDefaultSound'), partner, [{ value: undefined }, { value: undefined }]).ownValue).toBe(false);
  });

  it('secret fields report overrides as null', () => {
    const partner = { notifications: { pushoverAppToken: 'p' } };
    expect(classifyOrg(entry('notifications.pushoverAppToken'), partner, [{ value: 'o' }]).overrides).toBeNull();
  });

  it('entries without an org source never classify an org', () => {
    for (const id of ['regional.dateFormat', 'security.minLength', 'networkProxy.dedicatedTunnelOrigin']) {
      expect(classifyOrg(entry(id), {}, 'x')).toMatchObject({ ownValue: false, inEffect: false, shadowed: false });
    }
  });

  it('an invalid AI approval timeout falls through to the partner', () => {
    const partner = { aiApprovals: { interactiveTimeoutMinutes: 15 } };
    expect(classifyOrg(entry('aiApprovals.interactiveTimeoutMinutes'), partner, 3)).toMatchObject({ ownValue: false, inEffect: false });
    expect(classifyOrg(entry('aiApprovals.interactiveTimeoutMinutes'), partner, 20)).toMatchObject({ ownValue: true, inEffect: true, overrides: true });
  });
});

describe('fieldInForce / fieldPartnerSet', () => {
  it('locks are in force exactly when set', () => {
    expect(fieldInForce(entry('defaults.agentUpdatePolicy'), { defaults: { agentUpdatePolicy: 'auto' } })).toBe(true);
    expect(fieldInForce(entry('defaults.agentUpdatePolicy'), { defaults: {} })).toBe(false);
  });

  it('a blank partner pushover credential is not set', () => {
    expect(fieldPartnerSet(entry('notifications.pushoverAppToken'), { notifications: { pushoverAppToken: ' ' } })).toBe(false);
    expect(fieldPartnerSet(entry('notifications.pushoverDefaultPriority'), { notifications: { pushoverDefaultPriority: 0 } })).toBe(true);
  });

  it('partner-only fields are set when any covered path is present', () => {
    expect(fieldPartnerSet(entry('networkProxy.dedicatedTunnelOrigin'), { networkProxy: { dedicatedTunnelOrigin: false } })).toBe(true);
    expect(fieldPartnerSet(entry('regional.businessHours'), { businessHours: { preset: 'standard' } })).toBe(true);
    expect(fieldPartnerSet(entry('regional.businessHours'), {})).toBe(false);
  });
});
