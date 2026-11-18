/**
 * #9641: recommendation status is per (org, recommendation); a completion
 * reopens when the problem is observed again afterwards; dismissals are
 * permanent per org until an explicit reopen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../../services/commandQueue', () => ({ CommandTypes: {}, queueCommand: vi.fn() }));
vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
}));

import { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { listLatestSecurityPosture } from '../../services/securityPosture';
import {
  buildBe9Recommendations,
  getRecommendationStatusMap,
  resolveRecommendationStatus,
  type AffectedOrgBreakdown,
  type RecommendationActionMap,
} from './helpers';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const REC = 'rec-enable-firewall';

const auth = {
  scope: 'partner',
  orgId: null,
  accessibleOrgIds: [ORG_A, ORG_B],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

const T0 = new Date('2026-10-01T00:00:00Z');
const T1 = new Date('2026-10-02T00:00:00Z');
const T2 = new Date('2026-10-03T00:00:00Z');

function affected(entries: Record<string, number>): AffectedOrgBreakdown {
  return new Map(
    Object.entries(entries).map(([org, ms]) => [org, { affectedDevices: 1, latestObservedMs: ms }]),
  );
}
function actions(entries: Record<string, { status: 'completed' | 'dismissed' | 'reopened'; at: Date }>): RecommendationActionMap {
  return new Map([[REC, new Map(Object.entries(entries))]]);
}

describe('resolveRecommendationStatus', () => {
  it('completed stays completed while no newer observation exists', () => {
    expect(
      resolveRecommendationStatus(REC, affected({ [ORG_A]: T0.getTime() }), actions({ [ORG_A]: { status: 'completed', at: T1 } })),
    ).toBe('completed');
  });

  it('completed reopens when the problem is observed after completion', () => {
    expect(
      resolveRecommendationStatus(REC, affected({ [ORG_A]: T2.getTime() }), actions({ [ORG_A]: { status: 'completed', at: T1 } })),
    ).toBe('open');
  });

  it('dismissal is permanent per org even with newer observations', () => {
    expect(
      resolveRecommendationStatus(REC, affected({ [ORG_A]: T2.getTime() }), actions({ [ORG_A]: { status: 'dismissed', at: T1 } })),
    ).toBe('dismissed');
  });

  it('an explicit reopen makes it open', () => {
    expect(
      resolveRecommendationStatus(REC, affected({ [ORG_A]: T0.getTime() }), actions({ [ORG_A]: { status: 'reopened', at: T1 } })),
    ).toBe('open');
  });

  it('org A completing does not close it for org B (all-orgs view)', () => {
    const a = affected({ [ORG_A]: T0.getTime(), [ORG_B]: T0.getTime() });
    expect(resolveRecommendationStatus(REC, a, actions({ [ORG_A]: { status: 'completed', at: T1 } }))).toBe('open');
    expect(
      resolveRecommendationStatus(
        REC,
        a,
        actions({ [ORG_A]: { status: 'completed', at: T1 }, [ORG_B]: { status: 'dismissed', at: T1 } }),
      ),
    ).toBe('completed');
  });

  it('an action by an org without the problem is ignored', () => {
    expect(
      resolveRecommendationStatus(REC, affected({ [ORG_B]: T0.getTime() }), actions({ [ORG_A]: { status: 'dismissed', at: T1 } })),
    ).toBe('open');
  });
});

describe('getRecommendationStatusMap', () => {
  it('keys the newest action by org and recommendation', async () => {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () =>
            Promise.resolve([
              { action: 'security.recommendation.reopen', orgId: ORG_A, resourceName: REC, details: null, timestamp: T2 },
              { action: 'security.recommendation.complete', orgId: ORG_A, resourceName: REC, details: null, timestamp: T1 },
              { action: 'security.recommendation.dismiss', orgId: ORG_B, resourceName: REC, details: null, timestamp: T0 },
            ]),
        }),
      }),
    } as never);
    const map = await getRecommendationStatusMap(auth);
    expect(map.get(REC)?.get(ORG_A)).toEqual({ status: 'reopened', at: T2 });
    expect(map.get(REC)?.get(ORG_B)).toEqual({ status: 'dismissed', at: T0 });
  });
});

describe('buildBe9Recommendations affectedByOrg', () => {
  beforeEach(() => vi.clearAllMocks());

  it('breaks affected devices and latest observation down per org', async () => {
    const factors = (firewall: number) => ({
      av_health: { score: 100 }, firewall: { score: firewall }, encryption: { score: 100 },
      password_policy: { score: 100 }, admin_exposure: { score: 100 }, patch_compliance: { score: 100 },
      open_ports: { score: 100 }, os_currency: { score: 100 },
    });
    vi.mocked(listLatestSecurityPosture).mockResolvedValue([
      { orgId: ORG_A, deviceId: 'd1', capturedAt: T0.toISOString(), factors: factors(10) },
      { orgId: ORG_A, deviceId: 'd2', capturedAt: T2.toISOString(), factors: factors(10) },
      { orgId: ORG_B, deviceId: 'd3', capturedAt: T1.toISOString(), factors: factors(100) },
    ] as never);
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) }),
    } as never);

    const result = await buildBe9Recommendations({ ...auth, orgCondition: () => eq as never } as never);
    const byOrg = result.affectedByOrg?.get(REC);
    expect(byOrg?.get(ORG_A)).toEqual({ affectedDevices: 2, latestObservedMs: T2.getTime() });
    expect(byOrg?.has(ORG_B)).toBe(false);
  });
});
