import { describe, expect, it } from 'vitest';

import {
  topologyDiagnosticCancelPayload,
  validateTopologyCommandAuthority,
} from './diagnosticDispatch';

const runId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const commandId = '00000000-0000-4000-8000-000000000003';
const deviceId = '00000000-0000-4000-8000-000000000004';

const row = { id: commandId, type: 'network_diagnostic', deviceId, payload: null };

/** Any DB read here means a malformed payload reached live-row authority. */
const forbiddenReader = {
  select: () => {
    throw new Error('delivery authority must reject a malformed payload before reading rows');
  },
} as never;

describe('validateTopologyCommandAuthority payload gate', () => {
  it('denies a payload that is not a diagnostic command at all', async () => {
    await expect(
      validateTopologyCommandAuthority(row, { type: 'script' }, { reader: forbiddenReader }),
    ).resolves.toEqual({ allow: false, reason: 'scope_changed' });
  });

  it('denies a payload whose commandId is not the row being delivered', async () => {
    const payload = { ...basePayload(), commandId: '00000000-0000-4000-8000-0000000000ff' };
    await expect(
      validateTopologyCommandAuthority(row, payload, { reader: forbiddenReader }),
    ).resolves.toEqual({ allow: false, reason: 'scope_changed' });
  });

  it('denies a plan whose absolute deadline has passed', async () => {
    await expect(
      validateTopologyCommandAuthority(row, basePayload(), {
        reader: forbiddenReader,
        now: new Date('2026-01-01T00:05:00.000Z'),
      }),
    ).resolves.toEqual({ allow: false, reason: 'expired' });
  });
});

describe('topologyDiagnosticCancelPayload', () => {
  it('carries exactly the four identity fields the agent handler accepts', () => {
    const payload = topologyDiagnosticCancelPayload({ id: runId, attemptId, commandId });
    expect(payload).toEqual({ version: 1, runId, attemptId, commandId });
    expect(Object.keys(payload)).toHaveLength(4);
  });
});

function basePayload() {
  const acceptedAt = new Date('2026-01-01T00:00:00.000Z');
  const plan = {
    version: 1,
    recipeId: 'gateway_basic',
    recipeVersion: 1,
    scope: { orgId: deviceId, siteId: runId },
    subject: { kind: 'node', id: runId },
    origin: {
      deviceId,
      agentId: 'agent-1',
      nodeId: runId,
      bindingId: attemptId,
      siteId: runId,
      contextKey: 'default',
      interfaceId: null,
      interfaceEpoch: null,
      interfaceKey: null,
      sourceId: commandId,
      producerEpoch: 'epoch-1',
      sequence: '1',
    },
    family: 'ipv4',
    graphRevision: '0',
    settingsRevision: '0',
    contextRevision: '1',
    templateVersions: { partner: null, org: null, defaults: 1, resolver: 1 },
    destinations: [],
    steps: [],
    limits: {
      maxConcurrentSteps: 2,
      maxTargetAddresses: 4,
      maxResolvers: 2,
      queueTimeoutSeconds: 30,
      executionTimeoutSeconds: 90,
      lifetimeSeconds: 120,
    },
    acceptedAt: acceptedAt.toISOString(),
    queueDeadline: new Date(acceptedAt.getTime() + 30_000).toISOString(),
    deadline: new Date(acceptedAt.getTime() + 120_000).toISOString(),
    digest: 'a'.repeat(64),
    reasons: [],
  };
  return {
    type: 'network_diagnostic',
    version: 1,
    runId,
    attemptId,
    commandId,
    plan,
    planDigest: plan.digest,
    expiresAt: plan.deadline,
  };
}
