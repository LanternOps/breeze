import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  applicableCandidates,
  candidatesWithLink,
  DevicePolicySetMismatchError,
  groupPolicySetRows,
  policySetFor,
  sqlRoleOsMatch,
  withPolicySet,
  type PolicySetRow,
} from './devicePolicySet';
import type { DeviceHierarchy } from './deviceHierarchy';

const DEVICE = 'dev-1';
const ORG = 'org-1';
const PARTNER = 'partner-1';
const hierarchy = (over: Partial<DeviceHierarchy> = {}): DeviceHierarchy => ({
  deviceId: DEVICE, orgId: ORG, siteId: 'site-1', deviceRole: 'workstation', osType: 'windows',
  org: { partnerId: PARTNER, type: 'customer' }, site: null, groupIds: ['g-1'], ...over,
});

let seq = 0;
function row(over: Partial<PolicySetRow> = {}): PolicySetRow {
  seq += 1;
  return {
    assignmentId: `a-${seq}`, level: 'organization', targetId: ORG, priority: 0,
    roleFilter: null, osFilter: null, assignmentCreatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
    policyId: `p-${seq}`, policyName: `policy ${seq}`, policyOrgId: ORG, policyPartnerId: null, parentPolicyId: null,
    linkId: null, featureType: null, featurePolicyId: null, inlineSettings: null,
    eventLog: null, hardwareMonitoring: null, patch: null, timeSync: null, onedrive: null,
    ...over,
  };
}

describe('groupPolicySetRows', () => {
  it('groups link rows by assignment, keeps the SQL order, and keeps link-less assignments', () => {
    const a = row({ assignmentId: 'a-x', linkId: 'l-1', featureType: 'helper', inlineSettings: { enabled: true } });
    const a2 = { ...a, linkId: 'l-2', featureType: 'pam' as const, inlineSettings: { uacInterceptionEnabled: true } };
    const b = row({ assignmentId: 'a-y' });
    const set = groupPolicySetRows(hierarchy(), [a, a2, b]);
    expect(set.candidates.map((c) => c.assignmentId)).toEqual(['a-x', 'a-y']);
    expect(Object.keys(set.candidates[0]!.links).sort()).toEqual(['helper', 'pam']);
    expect(set.candidates[1]!.links).toEqual({});
  });

  it('keeps the same link id under two assignments (the view reuses a parent link id for every child)', () => {
    const shared = { linkId: 'parent-link', featureType: 'time_sync' as const };
    const set = groupPolicySetRows(hierarchy(), [row({ assignmentId: 'child-1', ...shared }), row({ assignmentId: 'child-2', ...shared })]);
    expect(set.candidates.map((c) => c.links.time_sync?.id)).toEqual(['parent-link', 'parent-link']);
  });

  it('a link whose settings row is absent carries null settings (a presence sentinel, never defaults)', () => {
    const set = groupPolicySetRows(hierarchy(), [row({ linkId: 'l-ev', featureType: 'event_log', eventLog: null })]);
    expect(set.candidates[0]!.links.event_log?.eventLog).toBeNull();
  });

  it('refuses two effective links of one type for one assignment', () => {
    const r = row({ assignmentId: 'dup', linkId: 'l-a', featureType: 'pam' });
    expect(() => groupPolicySetRows(hierarchy(), [r, { ...r, linkId: 'l-b' }])).toThrow(/two effective pam links/);
  });
});

describe('applicableCandidates', () => {
  const build = (h: DeviceHierarchy, rows: PolicySetRow[]) => groupPolicySetRows(h, rows);
  const partnerWideAtPartner = () => row({ level: 'partner', targetId: PARTNER, policyOrgId: null, policyPartnerId: PARTNER });

  it('raw partner: admits a partner-wide policy assigned at partner level', () => {
    const set = build(hierarchy(), [partnerWideAtPartner()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });

  it('orgOnly ownership drops a partner-wide policy even when it targets the org', () => {
    const set = build(hierarchy(), [row({ policyOrgId: null, policyPartnerId: PARTNER })]);
    expect(applicableCandidates(set, { ownership: 'orgOnly', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(0);
  });

  it('unassigned_pool: patch rule drops partner ownership and partner target; raw rule keeps them', () => {
    const set = build(hierarchy({ org: { partnerId: PARTNER, type: 'unassigned_pool' } }), [partnerWideAtPartner()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartnerUnlessUnassignedPool', partnerTarget: 'partnerUnlessUnassignedPool', roleOs: 'sql' })).toHaveLength(0);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });

  it('quick_support: monitors rule drops the partner-level target but keeps partner-wide ownership at org level', () => {
    const h = hierarchy({ org: { partnerId: PARTNER, type: 'quick_support' } });
    const set = build(h, [partnerWideAtPartner(), row({ level: 'organization', targetId: ORG, policyOrgId: null, policyPartnerId: PARTNER })]);
    const kept = applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partnerUnlessQuickSupportOrUnassignedPool', roleOs: 'sql' });
    expect(kept.map((c) => c.level)).toEqual(['organization']);
  });

  it('targets: a sibling device, a foreign group and a foreign site never match', () => {
    const set = build(hierarchy(), [
      row({ level: 'device', targetId: 'dev-2' }),
      row({ level: 'device_group', targetId: 'g-other' }),
      row({ level: 'site', targetId: 'site-other' }),
      row({ level: 'device_group', targetId: 'g-1' }),
    ]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' }).map((c) => c.targetId)).toEqual(['g-1']);
  });

  it('no org row: ownership is org-only and no partner target applies', () => {
    const set = build(hierarchy({ org: null }), [partnerWideAtPartner(), row()]);
    expect(applicableCandidates(set, { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })).toHaveLength(1);
  });
});

describe('sqlRoleOsMatch', () => {
  it('mirrors (filter IS NULL OR $v = ANY(filter)), including the empty-string role SQL admits', () => {
    expect(sqlRoleOsMatch({ roleFilter: null, osFilter: null }, { deviceRole: 'x', osType: 'y' })).toBe(true);
    expect(sqlRoleOsMatch({ roleFilter: [], osFilter: null }, { deviceRole: 'x', osType: 'y' })).toBe(false);
    expect(sqlRoleOsMatch({ roleFilter: ['printer'], osFilter: null }, { deviceRole: 'workstation', osType: 'y' })).toBe(false);
    expect(sqlRoleOsMatch({ roleFilter: [''], osFilter: null }, { deviceRole: '', osType: 'y' })).toBe(true);
    expect(sqlRoleOsMatch({ roleFilter: null, osFilter: ['linux'] }, { deviceRole: 'x', osType: 'windows' })).toBe(false);
  });
});

describe('candidatesWithLink', () => {
  it('returns applicable candidates that carry an effective link of the type, in candidate order', () => {
    const set = groupPolicySetRows(hierarchy(), [
      row({ assignmentId: 'first', linkId: 'l1', featureType: 'pam' }),
      row({ assignmentId: 'nolink' }),
      row({ assignmentId: 'second', linkId: 'l2', featureType: 'pam' }),
    ]);
    expect(candidatesWithLink(set, 'pam', { ownership: 'orgOrPartner', partnerTarget: 'partner', roleOs: 'none' })
      .map(({ candidate }) => candidate.assignmentId)).toEqual(['first', 'second']);
  });
});

describe('policySetFor / withPolicySet', () => {
  it('returns the set for its own device and refuses another device\'s set', () => {
    const set = groupPolicySetRows(hierarchy(), []);
    expect(policySetFor(DEVICE, withPolicySet(set, null))).toBe(set);
    expect(() => policySetFor('dev-2', withPolicySet(set, null))).toThrow(DevicePolicySetMismatchError);
  });

  it('refuses a set paired with a different hierarchy object', () => {
    const set = groupPolicySetRows(hierarchy(), []);
    expect(() => policySetFor(DEVICE, { hierarchy: hierarchy(), policySet: set })).toThrow(DevicePolicySetMismatchError);
  });

  it('withPolicySet(null, h) passes the hierarchy alone; (null, null) passes nothing', () => {
    const h = hierarchy();
    expect(withPolicySet(null, h)).toEqual({ hierarchy: h });
    expect(withPolicySet(null, null)).toBeUndefined();
  });
});
