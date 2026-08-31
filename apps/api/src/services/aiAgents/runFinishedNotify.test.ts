import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = '00000000-0000-4000-8000-0000000000e1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000e4';
const USER_A = '00000000-0000-4000-8000-0000000000e5';
const USER_B = '00000000-0000-4000-8000-0000000000e6';
const INTENT_ID = '00000000-0000-4000-8000-0000000000e7';

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.test.ts / runService.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  ambientContext: undefined as { scope: string } | undefined,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) throw new Error(`No queued rows for table ${table}`);
  return queue.shift() as unknown[];
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const builder: Record<string, unknown> = {
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: { select: vi.fn(() => makeSelect()) },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = dbMockState.ambientContext;
      dbMockState.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>());
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>());
vi.mock('../userNotifications', () => ({ createNotification }));

import { deliverRunFinishedNotifications } from './runFinishedNotify';

function queueRows(table: string, rows: unknown[]): void {
  dbMockState.rowQueues[table] = dbMockState.rowQueues[table] ?? [];
  dbMockState.rowQueues[table]!.push(rows);
}

const baseRun = {
  id: RUN_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  status: 'completed',
  summary: 'Investigated the disk alert.\nFreed 12GB on C:.',
  outcome: { toolExecutionCount: 2 },
  intentIds: [] as string[],
  policySnapshot: { effective: { recipients: { userIds: [], roleIds: [] } } },
};

const baseAgent = { id: AGENT_ID, orgId: ORG_ID, partnerId: PARTNER_ID, name: 'Front Desk Triage' };

beforeEach(() => {
  dbMockState.rowQueues = {};
  dbMockState.ambientContext = undefined;
  resolveRecipientUserIds.mockReset().mockResolvedValue([]);
  createNotification.mockReset().mockResolvedValue('notification-1');
});

describe('deliverRunFinishedNotifications', () => {
  it('creates one notification per resolved recipient with the structured metadata shape', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls.map(([input]) => (input as { userId: string }).userId))
      .toEqual([USER_A, USER_B]);
    const [firstInput] = createNotification.mock.calls[0]!;
    expect(firstInput).toMatchObject({
      userId: USER_A,
      orgId: ORG_ID,
      type: 'ai',
      title: 'Agent run finished',
      message: 'Front Desk Triage: Investigated the disk alert.',
      link: `/ai-agents/runs/${RUN_ID}`,
      dedupeKey: `agent-run:${RUN_ID}`,
      metadata: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        intentIds: [],
        status: 'completed',
        executedActionCount: 2,
        verdict: null,
      },
    });
  });

  it('links to the run detail page even when the run left intents pending', async () => {
    queueRows('ai_agent_runs', [{ ...baseRun, status: 'awaiting_approval', intentIds: [INTENT_ID] }]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect((input as { link: string | null }).link).toBe(`/ai-agents/runs/${RUN_ID}`);
    expect((input as { metadata: { status: string } }).metadata.status).toBe('awaiting_approval');
  });

  it('resolves recipients from the run policy snapshot, not the agent row', async () => {
    queueRows('ai_agent_runs', [{
      ...baseRun,
      policySnapshot: { effective: { recipients: { userIds: [USER_A, USER_B], roleIds: [] } } },
    }]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      { orgId: ORG_ID, partnerId: PARTNER_ID, recipients: { userIds: [USER_A, USER_B], roleIds: [] } },
      ORG_ID,
    );
  });

  it('is a silent no-op when the run no longer exists', async () => {
    queueRows('ai_agent_runs', []);
    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();
    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the run is not (yet) in a terminal status', async () => {
    queueRows('ai_agent_runs', [{ ...baseRun, status: 'running' }]);
    queueRows('ai_agents', [baseAgent]);

    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();

    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
  });

  it('is a silent no-op when zero recipients resolve', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([]);

    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('THROWS when recipient resolution fails — the caller decides retry policy', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockRejectedValue(new Error('membership lookup failed'));

    await expect(deliverRunFinishedNotifications(RUN_ID)).rejects.toThrow('membership lookup failed');
  });

  it('THROWS when a notification write fails', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    createNotification.mockRejectedValue(new Error('notifications table unavailable'));

    await expect(deliverRunFinishedNotifications(RUN_ID)).rejects.toThrow('notifications table unavailable');
  });
});

// ---------------------------------------------------------------------------
// Phase 2 wave P2-2 (scheduled sweeps), Task A7 — the sweep digest.
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — sweep digest (P2-2)', () => {
  function sweepFinding(severity: string, kind = 'service_down') {
    return {
      kind,
      severity,
      deviceId: null,
      title: `${kind} finding`,
      detail: 'detail',
      evidence: {},
    };
  }

  function sweepRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'sweep',
      summary: 'Sweep complete.',
      outcome: {
        toolExecutionCount: 0,
        sweepFindings: {
          summary: 'Two machines need attention.\nSee the run detail for the list.',
          findings: [sweepFinding('critical'), sweepFinding('high', 'disk_pressure')],
        },
      },
      ...overrides,
    };
  }

  it('titles the digest with the finding + critical counts and escalates priority when anything is critical', async () => {
    queueRows('ai_agent_runs', [sweepRun({ intentIds: [INTENT_ID] })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect(input).toMatchObject({
      title: 'Sweep finished: 2 finding(s) (1 critical) — Front Desk Triage',
      // The FIRST line of the sweep summary, not the run summary.
      message: 'Two machines need attention.',
      priority: 'high',
      link: `/ai-agents/runs/${RUN_ID}`,
      metadata: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        status: 'completed',
        sweep: {
          findings: 2,
          critical: 1,
          proposals: 1,
          kinds: ['disk_pressure', 'service_down'],
        },
      },
    });
  });

  it('omits the critical clause and keeps the default priority when nothing is critical', async () => {
    queueRows('ai_agent_runs', [sweepRun({
      outcome: {
        toolExecutionCount: 0,
        sweepFindings: { summary: 'All quiet.', findings: [sweepFinding('low', 'stale_agents')] },
      },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Sweep finished: 1 finding(s) — Front Desk Triage');
    expect(input.priority).toBeUndefined();
    expect((input.metadata as { sweep: unknown }).sweep).toEqual({
      findings: 1, critical: 0, proposals: 0, kinds: ['stale_agents'],
    });
  });

  // Final-review fix (#4189, item 2). A sweep is a RECURRING, unattended job:
  // a daily 06:00 baseline on a 40-org partner that finds nothing still
  // manufactures 40 notifications every morning, per recipient. Notification
  // fatigue is the failure mode that makes the ONE morning with a critical
  // finding invisible, so a clean sweep is silent by design. The run itself
  // still exists and is still readable on the run-detail page — the digest is
  // suppressed, not the record.
  it('writes NO notification for a zero-finding sweep', async () => {
    queueRows('ai_agent_runs', [sweepRun({
      outcome: { toolExecutionCount: 0, sweepFindings: { summary: 'Nothing found.', findings: [] } },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('sweep found nothing'),
      expect.objectContaining({ runId: RUN_ID }),
    );
    infoSpy.mockRestore();
  });

  it('CONTROL: a ONE-finding sweep still notifies', async () => {
    queueRows('ai_agent_runs', [sweepRun({
      outcome: {
        toolExecutionCount: 0,
        sweepFindings: { summary: 'One machine needs attention.', findings: [sweepFinding('low')] },
      },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Sweep finished: 1 finding(s) — Front Desk Triage');
  });

  it('a NON-sweep run with an empty sweepFindings outcome still notifies', async () => {
    // The suppression is keyed on the run's own profile, never on the shape
    // of a jsonb column another profile could carry.
    queueRows('ai_agent_runs', [sweepRun({
      profile: 'full',
      outcome: { toolExecutionCount: 0, sweepFindings: { summary: 'Nothing found.', findings: [] } },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('falls back to the generic title for a sweep run that never produced findings', async () => {
    queueRows('ai_agent_runs', [sweepRun({ outcome: { toolExecutionCount: 0 } })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Agent run finished');
    expect((input.metadata as Record<string, unknown>).sweep).toBeUndefined();
  });

  it('never applies the sweep digest to a non-sweep run, even with sweep findings on the outcome', async () => {
    queueRows('ai_agent_runs', [sweepRun({ profile: 'full' })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Agent run finished');
    expect((input.metadata as Record<string, unknown>).sweep).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 2 wave P2-3 (weekly org narrative), Task A7 — the narrative
// notification. Unlike every other run-finished notification, this one does
// NOT link to the run: the deliverable is the stored report artifact, and the
// person receiving it wants the document, not the agent's trace.
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — narrative (P2-3)', () => {
  const REPORT_ID = '00000000-0000-4000-8000-0000000000f1';
  const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000f2';

  function narrativeRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'narrative',
      summary: 'Weekly narrative written.',
      outcome: {
        toolExecutionCount: 0,
        narrative: {
          version: 1,
          headline: 'A quiet week: alert volume down, one backup still failing.',
          sections: [{ key: 'overview', title: 'Overview', bullets: ['zzz-section-marker-zzz'] }],
          markdown: '# A quiet week.',
        },
        narrativeReport: { reportId: REPORT_ID, reportRunId: REPORT_RUN_ID },
      },
      ...overrides,
    };
  }

  it('titles with the org name, carries the headline as the message, and links to /reports', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [input] = createNotification.mock.calls[0]!;
    expect(input).toMatchObject({
      userId: USER_A,
      orgId: ORG_ID,
      type: 'ai',
      title: 'Weekly narrative ready — Acme Dental',
      message: 'A quiet week: alert volume down, one backup still failing.',
      link: '/reports',
      dedupeKey: `agent-run:${RUN_ID}`,
    });
    expect((input as { metadata: Record<string, unknown> }).metadata.narrative)
      .toEqual({ reportRunId: REPORT_RUN_ID, reportId: REPORT_ID });
  });

  it('carries NO narrative content in the metadata — two ids and nothing else', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const serialized = JSON.stringify(createNotification.mock.calls[0]![0]);
    for (const forbidden of ['sections', 'bullets', 'markdown', 'narrativeContext', 'context']) {
      expect(serialized, `notification must not carry "${forbidden}"`).not.toContain(`"${forbidden}"`);
    }
    expect(serialized).not.toContain('zzz-section-marker-zzz');
  });

  it('flattens a control-character-bearing org name into the title', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme\nDental   ##' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect((createNotification.mock.calls[0]![0] as { title: string }).title)
      .toBe('Weekly narrative ready — Acme Dental ##');
  });

  it('drops the suffix rather than rendering an empty one when the org row is unreadable', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', []);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect((createNotification.mock.calls[0]![0] as { title: string }).title)
      .toBe('Weekly narrative ready');
  });

  /**
   * The whole payload is a pointer at the artifact. A narrative run whose
   * persistence failed (`narrative_persist_failed`/`_conflict`) has nothing to
   * point at, so it keeps the generic run-finished copy — which DOES link to
   * the run, where the reviewer can see the error code.
   */
  it('falls back to the generic copy when the run produced no artifact', async () => {
    queueRows('ai_agent_runs', [narrativeRun({
      outcome: { toolExecutionCount: 0, narrative: { version: 1, headline: 'h', sections: [], markdown: '' } },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect(input).toMatchObject({ title: 'Agent run finished', link: `/ai-agents/runs/${RUN_ID}` });
    expect((input as { metadata: Record<string, unknown> }).metadata.narrative).toBeUndefined();
  });

  it('never applies the narrative copy to another profile, even with a narrativeReport on the outcome', async () => {
    queueRows('ai_agent_runs', [narrativeRun({ profile: 'full' })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect(input).toMatchObject({ title: 'Agent run finished', link: `/ai-agents/runs/${RUN_ID}` });
  });
});

// ---------------------------------------------------------------------------
// Phase 2 wave P2-4 (ticket triage), Task 9 (#4191) — the triage
// notification branch: suppress-if-nothing-minted, ticket-NUMBER-only
// titling, /tickets/<id> linking, and the "executed automatically" autonomy
// note.
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — triage (P2-4)', () => {
  const TICKET_ID = '00000000-0000-4000-8000-0000000000f3';
  const OTHER_INTENT_ID = '00000000-0000-4000-8000-0000000000f4';

  function triageRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'triage',
      ticketId: TICKET_ID,
      summary: 'Triaged the ticket: likely a driver conflict.',
      outcome: {
        toolExecutionCount: 0,
        ticketProposal: { summary: 'Likely a driver conflict.', confidence: 0.9 },
      },
      ...overrides,
    };
  }

  it('suppresses entirely when the run minted zero intents and zero drafts', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [] })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('ticket_drafts', []); // zero drafts materialized for this run
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('minted nothing'),
      expect.objectContaining({ runId: RUN_ID }),
    );
    infoSpy.mockRestore();
  });

  it('does NOT suppress when the run minted zero intents but a draft already exists', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [] })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('ticket_drafts', [{ id: 'draft-1' }]);
    queueRows('tickets', [{ ticketNumber: '00042' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT query ticket_drafts (and does not suppress) when the run has a live intent', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [OTHER_INTENT_ID], status: 'awaiting_approval' })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('tickets', [{ ticketNumber: '00042' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('titles with the ticket NUMBER, never the subject, and links to /tickets/<id>', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [OTHER_INTENT_ID], status: 'awaiting_approval' })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('tickets', [{ ticketNumber: 'T-2026-00042' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Ticket #T-2026-00042 triaged — Front Desk Triage');
    expect(input.link).toBe(`/tickets/${TICKET_ID}`);
    expect(input.title).not.toContain('subject');
  });

  it('a human-decision-pending run (awaiting_approval) does NOT carry the autonomy note', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [OTHER_INTENT_ID], status: 'awaiting_approval' })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('tickets', [{ ticketNumber: '00042' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.message).not.toContain('executed automatically');
  });

  it('an autonomous run (completed, every intent auto-decided) notes "executed automatically" in the message', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [OTHER_INTENT_ID], status: 'completed' })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('tickets', [{ ticketNumber: '00042' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.message).toContain('Executed automatically');
  });

  it('falls back to a short id label when the ticket row is unreadable', async () => {
    queueRows('ai_agent_runs', [triageRun({ intentIds: [OTHER_INTENT_ID], status: 'completed' })]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('tickets', []); // ticket moved/deleted between finish and notify
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe(`Ticket #${TICKET_ID.slice(0, 8)} triaged — Front Desk Triage`);
  });

  it('never applies the triage copy to another profile, even with a ticketId on the run row', async () => {
    queueRows('ai_agent_runs', [triageRun({ profile: 'full', intentIds: [OTHER_INTENT_ID] })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Agent run finished');
    expect(input.link).toBe(`/ai-agents/runs/${RUN_ID}`);
  });
});
