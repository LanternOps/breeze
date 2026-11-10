/**
 * Shared, invented tenancy for the replay fixtures. Nothing here comes from a
 * production transcript: the partner, orgs, devices and people are made up,
 * and the session shapes only follow the defect classes filed from the
 * 2026-10-28 review (#10383–#10418).
 */
import type { GrantCeiling } from '../../../services/wisp/grantAuthority';
import type { StandingStateFacts } from '../../../services/wisp/standingLoop';
import type { ReplayInventory } from '../score';

export const PARTNER_ID = '10101010-1111-4111-8111-111111111111';
export const GRANTOR_ID = '20202020-2222-4222-8222-222222222222';
export const GRANT_ID = '30303030-3333-4333-8333-333333333333';
export const REVISION_ID = '40404040-4444-4444-8444-444444444444';

export const ORG_HARBOR = '50505050-5555-4555-8555-555555555555';
export const ORG_JUNIPER = '60606060-6666-4666-8666-666666666666';
export const ORG_NORTHFIELD = '70707070-7777-4777-8777-777777777777';

export const DEV = {
  PC01: 'aaaaaaaa-0001-4aaa-8aaa-aaaaaaaaaaaa',
  PC02: 'aaaaaaaa-0002-4aaa-8aaa-aaaaaaaaaaaa',
  PC03: 'aaaaaaaa-0003-4aaa-8aaa-aaaaaaaaaaaa',
  PC04: 'aaaaaaaa-0004-4aaa-8aaa-aaaaaaaaaaaa',
  PC05: 'aaaaaaaa-0005-4aaa-8aaa-aaaaaaaaaaaa',
  FS01: 'bbbbbbbb-0001-4bbb-8bbb-bbbbbbbbbbbb',
  PC07: 'bbbbbbbb-0007-4bbb-8bbb-bbbbbbbbbbbb',
} as const;

/** Ids the recorded tool outputs carry as their evidence. */
export const COMMAND_ID = 'cccccccc-0001-4ccc-8ccc-cccccccccccc';
export const CHECK_IN_ID = 'cccccccc-0002-4ccc-8ccc-cccccccccccc';
export const JOB_ID = 'cccccccc-0003-4ccc-8ccc-cccccccccccc';

export const INVENTORY: ReplayInventory = {
  orgs: [
    { id: ORG_HARBOR, name: 'Harbor Dental' },
    { id: ORG_JUNIPER, name: 'Juniper Legal' },
    { id: ORG_NORTHFIELD, name: 'Northfield Clinic' },
  ],
  devices: [
    { id: DEV.PC01, name: 'PC-01', orgId: ORG_HARBOR },
    { id: DEV.PC02, name: 'PC-02', orgId: ORG_HARBOR },
    { id: DEV.PC03, name: 'PC-03', orgId: ORG_HARBOR },
    { id: DEV.PC04, name: 'PC-04', orgId: ORG_HARBOR },
    { id: DEV.PC05, name: 'PC-05', orgId: ORG_NORTHFIELD },
    { id: DEV.FS01, name: 'FS-01', orgId: ORG_HARBOR },
    { id: DEV.PC07, name: 'PC-07', orgId: ORG_JUNIPER },
  ],
};

/** A partner-wide, active grant over the three orgs, grantor = the technician chatting. */
export function replayCeiling(over: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: GRANT_ID,
    revisionId: REVISION_ID,
    partnerId: PARTNER_ID,
    grantorUserId: GRANTOR_ID,
    scopeOrgId: null,
    partnerWide: true,
    orgIds: new Set(INVENTORY.orgs.map((o) => o.id)),
    siteIds: null,
    permissionKeys: new Set(['*']),
    toolAllowlist: null,
    deniedTools: new Set(),
    orgTerms: new Map(),
    status: 'active',
    ...over,
  };
}

const minutesFromNow = (m: number): Date => new Date(Date.now() + m * 60_000);

/** The standing facts W02 reads for a busy partner: loop active, a first look under way, a few open concerns. */
export function standingFacts(over: Partial<StandingStateFacts> = {}): StandingStateFacts {
  return {
    status: 'active',
    floorTickMinutes: 30,
    lastFloorTickAt: minutesFromNow(-10),
    firstLook: { assessedOrgs: 2, settledOrgs: 2, inFlight: 1, totalOrgs: 3 },
    brief: { timeLocal: '07:30', timezone: 'America/Chicago' },
    scope: { partnerWide: true, orgCount: 3, focusOrgName: null },
    nextTickAt: minutesFromNow(20),
    expiresAt: null,
    concerns: { high: 0, medium: 0, low: 0, top: [] },
    watches: { active: 1 },
    checkIns: { scheduled: 0, nextDueAt: null },
    spend: { backgroundCents: 40, chatCents: 12, totalCents: 52, budgetCentsPerDay: 500 },
    alerts: { critical: 0, high: 0 },
    recentAssessments: [{ orgName: 'Harbor Dental', at: minutesFromNow(-25) }],
    pictureUpdatedAt: minutesFromNow(-5),
    ...over,
  };
}

/** The line of a standing-state block that starts with `prefix`, or null. */
export function standingLine(block: string | null, prefix: string): string | null {
  if (!block) return null;
  return block.split('\n').find((line) => line.startsWith(prefix)) ?? null;
}
