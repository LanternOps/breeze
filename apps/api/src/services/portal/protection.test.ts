import { describe, expect, it } from 'vitest';
import type { securityStatus as securityStatusTable } from '../../db/schema';
import { classifyDeviceProtection } from './protection';

type SecurityProvider = (typeof securityStatusTable.$inferSelect)['provider'];

function status(
  overrides: Partial<{
    provider: SecurityProvider;
    realTimeProtection: boolean | null;
  }> = {},
) {
  return {
    provider: 'windows_defender' as const,
    realTimeProtection: true,
    ...overrides,
  };
}

describe('classifyDeviceProtection', () => {
  it.each([
    {
      name: 'S1 agent takes precedence over an absent status row',
      securityStatus: null,
      hasS1Agent: true,
      hasHuntressAgent: false,
      expected: 'protected',
    },
    {
      name: 'absent row is unknown',
      securityStatus: null,
      hasS1Agent: false,
      hasHuntressAgent: false,
      expected: 'unknown',
    },
    {
      name: 'stale Defender with RTP on remains protected',
      securityStatus: status(),
      hasS1Agent: false,
      hasHuntressAgent: false,
      observedAt: new Date('2026-07-04T12:00:00.000Z'),
      expected: 'protected',
    },
    {
      name: 'fresh provider other is unprotected',
      securityStatus: status({ provider: 'other' }),
      hasS1Agent: false,
      hasHuntressAgent: false,
      observedAt: new Date('2026-09-02T12:00:00.000Z'),
      expected: 'unprotected',
    },
    {
      name: 'RTP null is unprotected',
      securityStatus: status({ realTimeProtection: null }),
      hasS1Agent: false,
      hasHuntressAgent: false,
      expected: 'unprotected',
    },
  ])('$name', ({ expected, securityStatus, hasS1Agent, hasHuntressAgent }) => {
    expect(classifyDeviceProtection({
      securityStatus,
      hasS1Agent,
      hasHuntressAgent,
    })).toBe(expected);
  });

  it.each([
    ['base dev-1 managed Huntress', status(), false, true, 'protected', 'protected'],
    ['base dev-2 other/RTP-off', status({ provider: 'other', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
    ['base dev-3 absent', null, false, false, 'unknown', 'unprotected'],
    ['Elastic Defend RTP-on', status({ provider: 'elastic_defend' }), false, false, 'protected', 'protected'],
    ['fresh Defender', status(), false, false, 'protected', 'protected'],
    ['60-day stale Defender', status(), false, false, 'protected', 'protected'],
    ['10-day Defender under seven-day maximum', status(), false, false, 'protected', 'protected'],
    ['assessed Defender', status(), false, false, 'protected', 'protected'],
    ['assessed-set stale Defender', status(), false, false, 'protected', 'protected'],
    ['assessed-set absent row', null, false, false, 'unknown', 'unprotected'],
    ['exact 30-day cutoff', status(), false, false, 'protected', 'protected'],
    ['31 days past cutoff', status(), false, false, 'protected', 'protected'],
    ['missing updatedAt legacy row', status(), false, false, 'protected', 'protected'],
    ['inventory other/RTP-off', status({ provider: 'other', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
    ['SentinelOne managed row', status({ provider: 'sentinelone' }), true, false, 'protected', 'protected'],
    ['native Defender row', status(), false, false, 'protected', 'protected'],
    ['other provider with RTP on', status({ provider: 'other' }), false, false, 'unprotected', 'unprotected'],
    ['CrowdStrike with RTP off', status({ provider: 'crowdstrike', realTimeProtection: false }), false, false, 'unprotected', 'unprotected'],
    ['coverage dev-1 Defender', status(), false, false, 'protected', 'protected'],
    ['coverage dev-2 Defender', status(), false, false, 'protected', 'protected'],
    ['coverage dev-3 Defender', status(), false, false, 'protected', 'protected'],
    ['coverage dev-4 Defender', status(), false, false, 'protected', 'protected'],
    ['coverage dev-5 managed SentinelOne', status({ provider: 'sentinelone' }), true, false, 'protected', 'protected'],
    ['coverage dev-6 managed SentinelOne/RTP-off', status({ provider: 'sentinelone', realTimeProtection: false }), true, false, 'protected', 'protected'],
  ] as const)(
    'matches report fixture %s and its existing report bucket',
    (_, securityStatus, hasS1Agent, hasHuntressAgent, expected, reportBucket) => {
      const actual = classifyDeviceProtection({
        securityStatus,
        hasS1Agent,
        hasHuntressAgent,
      });

      expect(actual).toBe(expected);
      expect(actual === 'protected' ? 'protected' : 'unprotected')
        .toBe(reportBucket);
    },
  );
});
