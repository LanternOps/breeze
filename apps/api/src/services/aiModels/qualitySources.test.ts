// apps/api/src/services/aiModels/qualitySources.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiInvocations, aiSessions } from '../../db/schema';
import { detectQualitySources } from './qualitySources';

describe('detectQualitySources', () => {
  it('reports exactly the optional ledger columns this build has', () => {
    const inv = getTableColumns(aiInvocations) as Record<string, unknown>;
    const sess = getTableColumns(aiSessions) as Record<string, unknown>;
    expect(detectQualitySources()).toEqual({
      failover: 'failoverHop' in inv && 'failoverFromOfferingId' in inv,
      continuation: 'continuedFromSessionId' in sess,
    });
  });
});
