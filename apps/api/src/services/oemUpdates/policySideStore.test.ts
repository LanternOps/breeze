import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OEM_UPDATES_POLICY_DEFAULTS } from '@breeze/shared';

// #11242: the pure half of the policy-side store. The paged refresh against real rows
// and RLS is in __tests__/integration/oemPolicySideRefresh.integration.test.ts.

const h = vi.hoisted(() => ({ open: ['driver'] as string[] }));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./toolManifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./toolManifest')>()),
  openCategoriesForLane: vi.fn(() => h.open),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { classifyOemDevice, oemOccurrenceMemo, oemOfferedLane } from './policySide';
import { computeOemPolicySideRow, oemGatesFingerprint, oemPolicySideMemo, type OemPolicySideFacts } from './policySideStore';
import { pickOemLink, type OemLinkCandidate } from './resolver';

// Third Wednesday of February 2027 is the 17th, and 7 catch-up nights end on the 24th.
const NOW = new Date('2027-03-01T12:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const armedSettings = {
  ...OEM_UPDATES_POLICY_DEFAULTS,
  enabled: true,
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } },
};

function candidate(overrides: Partial<OemLinkCandidate> = {}): OemLinkCandidate {
  return {
    linkId: 'link-org',
    sourcePolicyId: 'policy-org',
    inlineSettings: armedSettings,
    assignedPolicyId: 'policy-org',
    policyOrgId: 'org-1',
    policyPartnerId: null,
    assignmentLevel: 'organization',
    assignmentTargetId: 'org-1',
    assignmentPriority: 0,
    assignmentCreatedAt: LONG_AGO,
    linkUpdatedAt: LONG_AGO,
    roleFilter: null,
    osFilter: null,
    ...overrides,
  };
}

function facts(overrides: Partial<OemPolicySideFacts> = {}): OemPolicySideFacts {
  return {
    deviceId: 'device-1',
    orgId: 'org-1',
    siteId: 'site-1',
    partnerId: 'partner-1',
    groupIds: [],
    osType: 'windows',
    isVirtual: false,
    deviceRole: 'workstation',
    enrolledAt: LONG_AGO,
    manufacturer: 'Dell Inc.',
    model: 'Latitude 7420',
    siteTimezone: 'UTC',
    orgSettings: {},
    partnerTimezone: null,
    partnerSettings: {},
    ...overrides,
  };
}

const row = (f: OemPolicySideFacts, candidates: OemLinkCandidate[], now = NOW) =>
  computeOemPolicySideRow(f, candidates, now, oemPolicySideMemo(now));

beforeEach(() => {
  h.open = ['driver'];
  vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
});

afterEach(() => vi.unstubAllEnvs());

describe('computeOemPolicySideRow', () => {
  it('no offered lane → a row with offeredLane null and linkEnabled false', () => {
    const result = row(facts({ isVirtual: true }), [candidate()]);
    expect(result).toMatchObject({
      deviceId: 'device-1',
      orgId: 'org-1',
      offeredLane: null,
      linkId: null,
      linkEnabled: false,
      rebootMode: null,
      occurrenceKey: null,
      lastNightStart: null,
      pastLastNightAt: null,
      refreshAfter: null,
      managedSince: null,
    });
    expect(result.gatesFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the flag off offers no lane to anyone', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    expect(row(facts(), [candidate()])).toMatchObject({ offeredLane: null, linkEnabled: false });
  });

  it('an armed link stores its occurrence boundaries and managed-since', () => {
    const result = row(facts(), [candidate()]);
    expect(result).toMatchObject({
      offeredLane: 'dell',
      linkId: 'link-org',
      linkEnabled: true,
      rebootMode: 'overnight',
      occurrenceKey: '2027-02',
      managedSince: LONG_AGO,
    });
    // 2027-02-24 01:00 UTC for the default 4 hours; March's third Wednesday is the 17th.
    expect(result.lastNightStart?.toISOString()).toBe('2027-02-24T01:00:00.000Z');
    expect(result.pastLastNightAt?.toISOString()).toBe('2027-02-24T05:00:00.000Z');
    expect(result.refreshAfter?.toISOString()).toBe('2027-03-17T01:00:00.000Z');
  });

  it('kill switch → linkEnabled false, rebootMode kept', () => {
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'dell');
    expect(row(facts(), [candidate({ inlineSettings: { ...armedSettings, reboot: 'never' } })])).toMatchObject({
      offeredLane: 'dell',
      linkId: 'link-org',
      linkEnabled: false,
      rebootMode: 'never',
      occurrenceKey: null,
      refreshAfter: null,
    });
  });

  it('occurrence fields are null when the link is disabled', () => {
    const disabled = candidate({ inlineSettings: { ...armedSettings, enabled: false } });
    expect(row(facts(), [disabled])).toMatchObject({
      linkEnabled: false,
      occurrenceKey: null,
      lastNightStart: null,
      pastLastNightAt: null,
      refreshAfter: null,
      managedSince: null,
    });
    h.open = [];
    expect(row(facts(), [candidate()])).toMatchObject({ linkEnabled: false, occurrenceKey: null, refreshAfter: null });
  });

  it('device-group assignment wins over org assignment', () => {
    const org = candidate();
    const group = candidate({
      linkId: 'link-group',
      sourcePolicyId: 'policy-group',
      assignedPolicyId: 'policy-group',
      assignmentLevel: 'device_group',
      assignmentTargetId: 'group-1',
    });
    expect(row(facts({ groupIds: ['group-1'] }), [org, group]).linkId).toBe('link-group');
    expect(row(facts({ groupIds: [] }), [org, group]).linkId).toBe('link-org');
  });

  it('a partner-only timezone resolves to the partner zone, not UTC', () => {
    // Window opens 01:00 in Sydney: the 2027-02-24 night starts at 14:00 UTC on the 23rd.
    const result = row(facts({ partnerTimezone: 'Australia/Sydney' }), [candidate()]);
    expect(result.lastNightStart?.toISOString()).toBe('2027-02-23T14:00:00.000Z');
    const fromSettings = row(facts({ partnerSettings: { timezone: 'Australia/Sydney' } }), [candidate()]);
    expect(fromSettings.lastNightStart?.toISOString()).toBe('2027-02-23T14:00:00.000Z');
  });

  it('a device that lost its lane gets offeredLane null', () => {
    expect(row(facts(), [candidate()]).offeredLane).toBe('dell');
    expect(row(facts({ manufacturer: 'Acme', model: 'Box' }), [candidate()])).toMatchObject({ offeredLane: null, linkEnabled: false, linkId: null });
  });

  it('managed-since is the latest of link change, assignment and enrolment', () => {
    const armedAt = new Date('2027-02-20T00:00:00.000Z');
    expect(row(facts(), [candidate({ linkUpdatedAt: armedAt })]).managedSince).toEqual(armedAt);
    const enrolled = new Date('2027-02-25T00:00:00.000Z');
    expect(row(facts({ enrolledAt: enrolled }), [candidate({ linkUpdatedAt: armedAt })]).managedSince).toEqual(enrolled);
  });

  it('agrees with classifyOemDevice: the stored row decides the same occurrence the live rule does', () => {
    const f = facts({ partnerTimezone: 'America/New_York' });
    const live = classifyOemDevice({
      facts: { ...f, statusLane: null, applicability: null, lastOutcome: null, occurrenceKey: null, attempts: null, lastSuccessAt: null, rebootPendingSince: null },
      lane: oemOfferedLane(f),
      link: pickOemLink([candidate()], { id: f.deviceId, orgId: f.orgId, siteId: f.siteId, deviceRole: f.deviceRole, osType: f.osType }, f.partnerId, []),
      timezone: 'America/New_York',
      now: NOW,
      occurrenceOf: oemOccurrenceMemo(NOW),
    });
    const stored = row(f, [candidate()]);
    expect(stored.occurrenceKey).toBe(live.side.occurrence?.occurrenceKey);
    expect(stored.linkEnabled).toBe(live.side.linkEnabled);
    expect(stored.managedSince).toEqual(live.side.managedSince);
    expect(stored.lastNightStart).toEqual(live.side.occurrence?.windowStart);
  });

  it('computes one occurrence per link and zone across many devices', () => {
    const memo = oemPolicySideMemo(NOW);
    for (let i = 0; i < 50; i += 1) computeOemPolicySideRow(facts({ deviceId: `device-${i}` }), [candidate()], NOW, memo);
    expect(memo.boundariesComputed()).toBe(1);
    computeOemPolicySideRow(facts({ siteTimezone: 'Europe/Berlin' }), [candidate()], NOW, memo);
    expect(memo.boundariesComputed()).toBe(2);
  });
});

describe('oemGatesFingerprint', () => {
  it('the gates fingerprint changes when a kill switch env var changes', () => {
    const before = oemGatesFingerprint();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    expect(oemGatesFingerprint()).toBe(before);
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', 'hp');
    const killed = oemGatesFingerprint();
    expect(killed).not.toBe(before);
    vi.stubEnv('BREEZE_OEM_UPDATES_DISABLED_LANES', ' HP ');
    expect(oemGatesFingerprint()).toBe(killed);
  });

  it('changes with the master flag, the partner allowlist and the lab devices', () => {
    const base = oemGatesFingerprint();
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'false');
    const off = oemGatesFingerprint();
    expect(off).not.toBe(base);
    vi.stubEnv('BREEZE_OEM_UPDATES_ENABLED', 'true');
    vi.stubEnv('BREEZE_OEM_UPDATES_PARTNER_ALLOWLIST', 'partner-1');
    const allow = oemGatesFingerprint();
    expect(new Set([base, off, allow]).size).toBe(3);
    vi.stubEnv('BREEZE_OEM_UPDATES_LAB_DEVICE_IDS', 'device-1');
    expect(oemGatesFingerprint()).not.toBe(allow);
  });
});
