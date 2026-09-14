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

  // #5022 W01: this used to pass with NO aiOrigin, because actorType was read
  // off `source.proposal.authorKind` -- i.e. off AUTHORSHIP. That was the
  // defect: it also stamped 'ai_agent' on a HUMAN-invoked run of the same
  // proposal. actorType now derives from the authenticated PRINCIPAL, so an
  // autonomous run has to say it is one.
  it('uses actorType ai_agent for an autonomous agent-run proposal', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'proposal',
        proposal: proposal({ id: 'proposal-2', authorKind: 'agent_run', sessionId: null, agentRunId: 'run-1' }),
        snapshot: snapshotFor('proposal-2'),
      },
      aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
      principalActorId: 'agent-7',
      provenance: {
        approvalMethod: 'unattended_reviewer_gated',
        reviewRiskTier: 'low',
        reviewSummary: 'Clears the DNS cache.',
      },
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'ai_agent', actorId: 'agent-7' }),
    );
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

// ============================================================================
// #5022 W01 Task 9 — the actor mismatch defect.
//
// The previous emission read `actorType` off `source.proposal.authorKind`
// while `actorId` came from the INVOKER, so an AI-AUTHORED script hand-run by
// a human wrote actor_type='ai_agent' against a HUMAN user id: an audit row
// that misattributes a human action to an AI. Authorship, initiation and
// authenticated principal are three different things.
// ============================================================================
const HUMAN_USER_ID = 'human-1';
const AGENT_ID = 'agent-7';

describe('ai.script.executed derives its actor from the PRINCIPAL, not authorship (#5022 W01)', () => {
  beforeEach(() => {
    // These cases pass a real `createdBy`, which runs the users-FK probe the
    // other cases in this file never reach.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: HUMAN_USER_ID }]) }),
      }),
    } as never);
  });

  it('audits a human hand-running an AI-authored proposal as the human', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'proposal',
        proposal: proposal({ authorKind: 'agent_run', agentRunId: 'run-1' }),
        snapshot: snapshotFor('proposal-1'),
      },
      triggeredBy: HUMAN_USER_ID,
      createdBy: HUMAN_USER_ID,
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai.script.executed',
        actorType: 'user',
        actorId: HUMAN_USER_ID,
        details: expect.objectContaining({ authorKind: 'agent_run' }),
      }),
    );
  });

  it('audits an agent-initiated proposal run as the agent principal', async () => {
    await dispatchScriptToDevice({
      device: device(),
      source: {
        kind: 'proposal',
        proposal: proposal({ authorKind: 'agent_run', agentRunId: 'run-1' }),
        snapshot: snapshotFor('proposal-1'),
      },
      triggeredBy: null,
      createdBy: null,
      aiOrigin: { kind: 'ai_agent', agentRunId: 'run-1' },
      principalActorId: AGENT_ID,
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'ai_agent', actorId: AGENT_ID }),
    );
  });

  it("writes an ai.script.executed row for an AI-run LIBRARY script (Todd's Kit case)", async () => {
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
      triggeredBy: HUMAN_USER_ID,
      createdBy: HUMAN_USER_ID,
      aiOrigin: { kind: 'ai_assistant', sessionId: 'sess-1' },
    } as never);

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai.script.executed',
        actorType: 'user',
        actorId: HUMAN_USER_ID,
        resourceType: 'device',
        resourceId: 'device-1',
        initiatedBy: 'ai',
        details: expect.objectContaining({
          sourceKind: 'library',
          deviceId: 'device-1',
          aiInitiatorKind: 'ai_assistant',
          aiSessionId: 'sess-1',
          aiAgentRunId: null,
        }),
      }),
    );
  });
});
