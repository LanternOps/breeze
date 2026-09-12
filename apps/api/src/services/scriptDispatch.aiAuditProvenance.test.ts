import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks mirror scriptDispatch.acknowledgement.test.ts exactly, plus a mock
// of auditService so this file can assert on the new audit write without a
// real DB.
vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./commandQueue', async () => {
  const { CommandTypes } = await import('./commandTypes');
  return { CommandTypes, queueCommand: vi.fn() };
});
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn().mockResolvedValue(null),
  releaseClaimedCommandDelivery: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./sensitiveCommandPayload', () => ({
  encryptSensitivePayloadFields: vi.fn((_t: string, p: unknown) => p),
  decryptCommandForDelivery: vi.fn((c: unknown) => c),
  toAgentCommandFrame: vi.fn((c: { id: string; type: string; payload: unknown }) => ({
    id: c.id,
    type: c.type,
    payload: c.payload,
  })),
}));
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: vi.fn().mockReturnValue(false) }));
vi.mock('./scriptSecretDelivery', () => ({
  AGENT_UPGRADE_REQUIRED_MESSAGE: 'Agent upgrade required: mocked message',
  SECRET_GATE_UNAVAILABLE_MESSAGE: 'Secret gate unavailable: mocked message',
  secretDeliveryPreflight: vi.fn().mockResolvedValue({ ok: true }),
  failClaimedSecretCommandsForUnsupportedAgent: vi.fn((claimed: unknown[]) => Promise.resolve(claimed)),
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptMaintenanceGate', () => ({
  checkScriptMaintenanceSuppression: vi.fn().mockResolvedValue({ suppressed: false }),
}));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));

import { db } from '../db';
import { queueCommand } from './commandQueue';
import { createAuditLogAsync } from './auditService';
import { dispatchScriptToDevice } from './scriptDispatch';

const device = (o = {}) =>
  ({
    id: 'device-1',
    orgId: 'org-a',
    osType: 'linux',
    status: 'online',
    agentId: null,
    hostname: 'host-1',
    siteId: 'site-1',
    customFields: {},
    ...o,
  }) as never;

const proposal = (o = {}) =>
  ({ id: 'proposal-1', orgId: 'org-a', authorKind: 'chat_session', sessionId: 'session-1', agentRunId: null, ...o }) as never;

const snapshotFor = (proposalId: string) =>
  ({
    proposalId,
    contentDigest: 'a'.repeat(64),
    language: 'powershell',
    runAs: 'system',
    timeoutSeconds: 120,
    deviceIds: ['device-1'],
    scannerVersion: '2026-09-11.1',
  }) as never;

const insertReturning = (rows: unknown[]) => ({
  values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.insert).mockReturnValue(insertReturning([{ id: 'exec-1' }]) as never);
  vi.mocked(queueCommand).mockResolvedValue({ id: 'cmd-1', payload: {} } as never);
});

describe('dispatchScriptToDevice — AI-authored audit provenance (#5022, W05)', () => {
  it('writes an ai.script.executed row from the dispatch-time provenance, with zero extra DB reads', async () => {
    const result = await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'proposal', proposal: proposal(), snapshot: snapshotFor('proposal-1') },
      provenance: {
        approvedBy: 'user-1',
        approvalMethod: 'supervised_self',
        reviewRiskTier: 'low',
        reviewSummary: 'Restarts the print spooler service.',
      },
    } as never);

    expect(result.ok).toBe(true);
    // db.select is never called by this branch — the audit write reads only
    // input.provenance and source.proposal, both already in scope.
    expect(db.select).not.toHaveBeenCalled();
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-a',
        actorType: 'user',
        action: 'ai.script.executed',
        resourceType: 'device',
        resourceId: 'device-1',
        resourceName: 'host-1',
        initiatedBy: 'ai',
        details: expect.objectContaining({
          proposalId: 'proposal-1',
          sourceKind: 'proposal',
          approvalMethod: 'supervised_self',
          reviewRiskTier: 'low',
          reviewSummary: 'Restarts the print spooler service.',
        }),
      }),
    );
  });

  it('uses actorType ai_agent for an autonomous agent-run proposal', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'proposal',
        proposal: proposal({ id: 'proposal-2', authorKind: 'agent_run', sessionId: null, agentRunId: 'run-1' }),
        snapshot: snapshotFor('proposal-2'),
      },
      provenance: {
        approvalMethod: 'unattended_reviewer_gated',
        reviewRiskTier: 'low',
        reviewSummary: 'Clears the DNS cache.',
      },
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'ai_agent' }));
  });

  it('writes null provenance fields when the caller supplied none', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: { kind: 'proposal', proposal: proposal({ id: 'proposal-3' }), snapshot: snapshotFor('proposal-3') },
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          proposalId: 'proposal-3',
          approvalMethod: null,
          reviewRiskTier: null,
          reviewSummary: null,
        }),
      }),
    );
  });

  it('does not write an AI audit row for an ordinary human (saved-script) dispatch', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'saved',
        script: {
          id: 'script-1', orgId: 'org-a', partnerId: null, isSystem: false, osTypes: ['linux'],
          language: 'bash', content: 'echo hi', timeoutSeconds: 60, runAs: 'system', deletedAt: null,
          acknowledgedSecurityPatterns: [],
        },
      },
    } as never);

    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
});
