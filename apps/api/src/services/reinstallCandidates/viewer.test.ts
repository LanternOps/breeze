import { beforeEach, describe, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  ranked: null as unknown,
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db', () => {
  const chain = (): any => {
    const c: any = {};
    for (const m of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'orderBy']) c[m] = () => c;
    c.limit = async () => []; // the open-intent read: none
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(seam.rows).then(resolve, reject);
    return c;
  };
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./index', () => ({ readRankedReinstallCandidates: vi.fn(async () => seam.ranked) }));
vi.mock('../deviceReattach/targetVersion', () => ({ reattachTargetVersion: vi.fn(() => 'v'.repeat(43)) }));

import { canViewReattachCandidate, canViewReattachSource, readReinstallCandidatesForViewer, type CandidatesViewer } from './viewer';

// #8318 §7.3 "No leaks", §9: who sees a source's reattach candidates.

const PARTNER = 'partner-1';

function viewer(over: Partial<CandidatesViewer> & { orgs?: string[] } = {}): CandidatesViewer {
  const orgs = over.orgs ?? ['org-a', 'org-b'];
  return {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    canAccessOrg: (orgId: string) => orgs.includes(orgId),
    allowedSiteIds: undefined,
    canAccessSite: undefined,
    allowedDeviceIds: undefined,
    ...over,
  } as CandidatesViewer;
}

const realSource = { id: 'dev-src', orgId: 'org-a', siteId: 'site-a', orgType: 'customer', partnerId: PARTNER };
const parkedSource = { id: 'dev-parked', orgId: 'holding', siteId: 'site-h', orgType: 'unassigned_pool', partnerId: PARTNER };
const target = { id: 'dev-old', orgId: 'org-b', siteId: 'site-b' };

describe('canViewReattachSource', () => {
  it('a parked source is seen by a full partner admin of its partner only', () => {
    expect(canViewReattachSource(viewer(), parkedSource)).toBe(true);
    expect(canViewReattachSource(viewer({ partnerId: 'partner-2' }), parkedSource)).toBe(false);
    // A technician limited to selected orgs: not until wave H's switch.
    expect(canViewReattachSource(viewer({ partnerOrgAccess: 'selected' }), parkedSource)).toBe(false);
    // An organization user never sees the holding area.
    expect(canViewReattachSource(viewer({ scope: 'organization', partnerOrgAccess: null }), parkedSource)).toBe(false);
  });

  it('a real source needs its org, its site and (for a device-bound run) the device', () => {
    expect(canViewReattachSource(viewer(), realSource)).toBe(true);
    expect(canViewReattachSource(viewer({ orgs: ['org-b'] }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedSiteIds: ['site-x'] }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedSiteIds: ['site-a'] }), realSource)).toBe(true);
    expect(canViewReattachSource(viewer({ canAccessSite: (s) => s === 'site-x' }), realSource)).toBe(false);
    expect(canViewReattachSource(viewer({ allowedDeviceIds: ['dev-other'] }), realSource)).toBe(false);
  });
});

describe('canViewReattachCandidate', () => {
  it('lists a candidate only to a partner user who reaches its org and site', () => {
    expect(canViewReattachCandidate(viewer(), target)).toBe(true);
    expect(canViewReattachCandidate(viewer({ orgs: ['org-a'] }), target)).toBe(false);
    expect(canViewReattachCandidate(viewer({ allowedSiteIds: ['site-a'] }), target)).toBe(false);
    expect(canViewReattachCandidate(viewer({ allowedDeviceIds: ['dev-src'] }), target)).toBe(false);
  });

  it('never lists a candidate to an organization user, even in their own org', () => {
    expect(canViewReattachCandidate(viewer({ scope: 'organization', partnerOrgAccess: null }), target)).toBe(false);
  });
});

describe('readReinstallCandidatesForViewer — reviewPending', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, hostname: `host-${id}`, displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'offline',
    enrolledAt: null, createdAt: new Date('2026-01-01T00:00:00Z'), lastSeenAt: null, decommissionedAt: null,
    agentId: `agent-${id}`, installIncarnation: 1, rebindProtocolVersion: 1, serialNumber: null, manufacturer: null,
    model: null, systemUuid: null, orgName: 'Org', siteName: 'Site', ...over,
  });
  const candidate = (id: string, orgId: string) => ({
    target: { id, orgId, siteId: 'site-b' }, evidence: 'system_uuid', reason: 'hardware',
  });

  beforeEach(() => {
    seam.ranked = {
      source: { ...realSource, hostname: 'h', osType: 'windows', storedTargetId: null, storedReason: null, enrolledAt: new Date() },
      ranked: [candidate('dev-old', 'org-b'), candidate('dev-other', 'org-c')],
    };
  });

  it('is true when a candidate was hidden by visibility', async () => {
    seam.rows = [row('dev-src'), row('dev-old')];
    const view = await readReinstallCandidatesForViewer({ sourceDeviceId: 'dev-src', viewer: viewer() });
    expect(view!.candidates.map((c) => c.deviceId)).toEqual(['dev-old']);
    expect(view!.reviewPending).toBe(true);
  });

  it('is false when a visible candidate is dropped only for missing data', async () => {
    seam.ranked = { ...(seam.ranked as object), ranked: [candidate('dev-old', 'org-b')] };
    // No comparison row for dev-old: it is dropped, but nothing was hidden.
    seam.rows = [row('dev-src')];
    const view = await readReinstallCandidatesForViewer({ sourceDeviceId: 'dev-src', viewer: viewer() });
    expect(view!.candidates).toEqual([]);
    expect(view!.reviewPending).toBe(false);
  });

  it('never emits the raw agent id or incarnation, only the opaque version', async () => {
    seam.ranked = { ...(seam.ranked as object), ranked: [candidate('dev-old', 'org-b')] };
    seam.rows = [row('dev-src'), row('dev-old')];
    const view = await readReinstallCandidatesForViewer({ sourceDeviceId: 'dev-src', viewer: viewer() });
    expect(view!.candidates[0]!.targetVersion).toBe('v'.repeat(43));
    expect(JSON.stringify(view)).not.toContain('agent-dev-old');
    expect(view!.candidates[0]).not.toHaveProperty('installIncarnation');
  });
});
