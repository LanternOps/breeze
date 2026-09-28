import { describe, expect, it } from 'vitest';
import { topologyConfigurationObjectView } from './configurationObjects';

const at = new Date('2026-09-26T12:00:00.000Z');
const ORG = '10000000-0000-4000-8000-000000000001', SITE = '10000000-0000-4000-8000-000000000002', POLICY = '10000000-0000-4000-8000-000000000003';
const definition = {
  kind: 'policy', enabled: true, recipeId: 'gateway_basic', recipeVersion: 1, subject: 'reported_gateway', targetKeys: [], families: ['ipv4'],
  origin: 'original_reporter', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: true, failureThreshold: 3, recoveryThreshold: 2,
} as const;
/** A policy row as M3 stores it: bigint revisions plus the frozen arming authority and runtime alert state. */
const policyRow = {
  id: POLICY, orgId: ORG, siteId: SITE, partnerVersionId: null, orgVersionId: null, configurationDigest: null, key: 'gateway', revision: 7n, enabled: true,
  definition, subjectNodeId: null, subjectRelationshipId: null, requesterId: null, authorityGeneration: 2n, authorityDigest: 'a'.repeat(64),
  activationIntent: true, lastScheduledAt: at, nextScheduledAt: at, blockedReason: null,
  authorityActor: { actor: { user: { id: POLICY }, authEpoch: 3, mfaEpoch: 4 }, permissionVersion: 'v9' }, authorityPermissionVersion: 'v9', armedAt: at,
  routingContexts: [], alertState: { schemaVersion: 1, entries: [] }, alertStateRevision: 5n, deletedAt: null, createdAt: at, updatedAt: at,
};

describe('topology configuration object view', () => {
  it('serializes an armed M3 policy row without bigint failures or its frozen authority', () => {
    const view = topologyConfigurationObjectView(policyRow as never);
    // JSON.stringify throws on any bigint: the list/upsert response must serialize.
    const wire = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
    expect(wire).toMatchObject({ id: POLICY, key: 'gateway', revision: '7', authorityGeneration: '2', enabled: true, activationIntent: true, definition });
    for (const hidden of ['authorityActor', 'authorityPermissionVersion', 'alertState', 'alertStateRevision', 'routingContexts', 'requesterId']) {
      expect(wire).not.toHaveProperty(hidden);
    }
  });
});
