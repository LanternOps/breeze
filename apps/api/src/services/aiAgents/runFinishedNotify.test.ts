import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// #4248 W03 — the narrative EMAIL pass, mocked at the module boundary (its own
// suite is reportNarrativeDelivery.test.ts). `contextAtEmailPass` records the
// ambient DB context at the moment it is called: it must be undefined.
const contextAtEmailPass = vi.hoisted(() => [] as Array<{ scope: string } | undefined>);
const deliverNarrativeEmails = vi.hoisted(() =>
  vi.fn<(reportRunId: string, ctx: { orgId: string }) => Promise<Record<string, number>>>());
vi.mock('../reportNarrativeDelivery', () => ({
  deliverNarrativeEmails: (reportRunId: string, ctx: { orgId: string }) => {
    contextAtEmailPass.push(dbMockState.ambientContext);
    return deliverNarrativeEmails(reportRunId, ctx);
  },
}));

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
  contextAtEmailPass.length = 0;
  deliverNarrativeEmails.mockReset().mockResolvedValue({
    total: 1, sent: 1, failed: 0, unknown: 0, pending: 0, refused: 0, transient: 0,
  });
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

  // #4248 W03 (Task 7): the email pass runs AFTER the in-app notification
  // loop's system context closes, and independently of it.
  it('runs the narrative email delivery pass after the in-app notifications, outside the notification context', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(deliverNarrativeEmails).toHaveBeenCalledTimes(1);
    expect(deliverNarrativeEmails).toHaveBeenCalledWith(REPORT_RUN_ID, { orgId: ORG_ID });
    expect(createNotification.mock.invocationCallOrder[0]!)
      .toBeLessThan(deliverNarrativeEmails.mock.invocationCallOrder[0]!);
    expect(contextAtEmailPass).toEqual([undefined]);
  });

  it('leaves the in-app notification untouched for a recipient the email gate refuses', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    deliverNarrativeEmails.mockResolvedValueOnce({
      total: 1, sent: 0, failed: 1, unknown: 0, pending: 0, refused: 1, transient: 0,
    });

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_A }));
  });

  it('runs the email pass even when the run has ZERO in-app recipients — the delivery rows are the source of truth', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).not.toHaveBeenCalled();
    expect(deliverNarrativeEmails).toHaveBeenCalledWith(REPORT_RUN_ID, { orgId: ORG_ID });
    // Same invariant as the sibling test above, asserted on THIS branch too:
    // the early return must not call the email pass from inside a still-open
    // DB context. `deliverNarrativeEmails` is module-mocked here, so without
    // this line a regression on this branch alone would only surface at
    // runtime, via the real function's own guard.
    expect(contextAtEmailPass).toEqual([undefined]);
  });

  it('does not run the email pass for a narrative run without an artifact', async () => {
    queueRows('ai_agent_runs', [narrativeRun({
      outcome: { toolExecutionCount: 0, narrative: { version: 1, headline: 'h', sections: [], markdown: '' } },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(deliverNarrativeEmails).not.toHaveBeenCalled();
  });

  it('propagates an email-pass failure so the durable notify retry lane re-runs it (idempotent claims)', async () => {
    queueRows('ai_agent_runs', [narrativeRun()]);
    queueRows('ai_agents', [baseAgent]);
    queueRows('organizations', [{ name: 'Acme Dental' }]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    deliverNarrativeEmails.mockRejectedValueOnce(new Error('pg down'));

    await expect(deliverRunFinishedNotifications(RUN_ID)).rejects.toThrow('pg down');
    expect(createNotification).toHaveBeenCalledTimes(1);
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
// Fleet Designer W01 (#5651), Task 9 — the design-run notification. Same
// "the whole payload is a pointer at a stored document" posture as the
// narrative digest above, but links to the Fleet Design page (keyed by the
// linked report_runs id), not `/reports`, and carries no headline.
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — fleet design (W01)', () => {
  const REPORT_ID = '00000000-0000-4000-8000-0000000000f5';
  const REPORT_RUN_ID = '00000000-0000-4000-8000-0000000000f6';

  function designRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'design',
      summary: 'Fleet design complete.',
      outcome: {
        toolExecutionCount: 0,
        fleetDesign: { schemaVersion: 1 },
        fleetDesignReport: { reportId: REPORT_ID, reportRunId: REPORT_RUN_ID },
      },
      ...overrides,
    };
  }

  it('titles with the org name, links to the fleet design page, and carries no priority', async () => {
    queueRows('ai_agent_runs', [designRun()]);
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
      title: 'Fleet Design ready — Acme Dental',
      link: `/ai-agents/fleet-design#${REPORT_RUN_ID}`,
      dedupeKey: `agent-run:${RUN_ID}`,
    });
    expect((input as { priority?: string }).priority).toBeUndefined();
    expect((input as { metadata: Record<string, unknown> }).metadata.fleetDesign)
      .toEqual({ reportRunId: REPORT_RUN_ID, reportId: REPORT_ID });
  });

  it('falls back to the unconditional run link when persistence produced no artifact', async () => {
    queueRows('ai_agent_runs', [designRun({
      outcome: { toolExecutionCount: 0, fleetDesign: { schemaVersion: 1 } },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect(input).toMatchObject({ title: 'Agent run finished', link: `/ai-agents/runs/${RUN_ID}` });
    expect((input as { metadata: Record<string, unknown> }).metadata.fleetDesign).toBeUndefined();
  });

  it('never applies the fleet design copy to another profile, even with a fleetDesignReport on the outcome', async () => {
    queueRows('ai_agent_runs', [designRun({ profile: 'full' })]);
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

// ---------------------------------------------------------------------------
// AI patch agent W01 (#5747), Task 11 — the patch-run digest. Same shape as
// the sweep digest above: counts in the title, the plan summary's first line
// as the message, and the ordinary run link (W01 renders the plan on the run
// detail page, and mints no intents of its own).
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — patch plan (W01)', () => {
  function patchRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'patch',
      summary: 'Run finished.',
      outcome: {
        toolExecutionCount: 0,
        patchPlan: {
          schemaVersion: 1,
          summary: 'Two servers are behind on critical updates.\nDetail follows.',
          posture: 'behind',
          items: [
            { class: 'install', severity: 'critical' },
            { class: 'install', severity: 'warning' },
            { class: 'reboot_plan', severity: 'critical' },
          ],
          dispositions: [],
          evidenceTruncated: false,
          generatedAt: '2026-09-14T02:00:00.000Z',
        },
      },
      ...overrides,
    };
  }

  it('titles a patch run with the plan counts and uses the plan summary as the message', async () => {
    queueRows('ai_agent_runs', [patchRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Patch plan ready: 3 item(s) (2 critical) — Front Desk Triage');
    expect(input.message).toBe('Two servers are behind on critical updates.');
    expect(input.link).toBe(`/ai-agents/runs/${RUN_ID}`);
  });

  it('escalates a plan carrying a critical item and leaves a clean plan at the default priority', async () => {
    queueRows('ai_agent_runs', [patchRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    expect((createNotification.mock.calls[0]![0] as { priority?: string }).priority).toBe('high');

    createNotification.mockClear();
    queueRows('ai_agent_runs', [patchRun({
      outcome: {
        toolExecutionCount: 0,
        patchPlan: {
          schemaVersion: 1,
          summary: 'Everything is current.',
          posture: 'current',
          items: [{ class: 'install', severity: 'info' }],
          dispositions: [],
          evidenceTruncated: false,
          generatedAt: '2026-09-14T02:00:00.000Z',
        },
      },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    expect((createNotification.mock.calls[0]![0] as { priority?: string }).priority).toBeUndefined();
  });

  it('sends to the EFFECTIVE policy snapshot recipients, not the agent row column', async () => {
    queueRows('ai_agent_runs', [patchRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    // A regression pin, not a fix: an org override's added recipient reaches
    // the digest only because the RUN's snapshot is the input here.
    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: baseRun.policySnapshot.effective.recipients }),
      ORG_ID,
    );
  });

  it('falls back to the generic verdict-aware title when the run produced no plan', async () => {
    queueRows('ai_agent_runs', [patchRun({ outcome: { toolExecutionCount: 0 } })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Agent run finished');
  });

  // ---- W03 (#5749): escalation delivery ---------------------------------------
  function chaseRun(extra: Record<string, unknown> = {}) {
    return patchRun({
      outcome: {
        toolExecutionCount: 0,
        patchPlan: {
          schemaVersion: 1,
          summary: 'Three installs failed; two are worth a retry.',
          posture: 'behind',
          items: [
            { class: 'install', severity: 'high' },
            { class: 'chase', severity: 'high', failureClass: 'transient', attemptCount: 1 },
            { class: 'chase', severity: 'high', failureClass: 'disk_space', attemptCount: 1 },
            { class: 'escalation', severity: 'critical', failureClass: 'permanent', attemptCount: 2 },
            { class: 'escalation', severity: 'high', failureClass: 'unknown', attemptCount: 3 },
          ],
          dispositions: [
            { index: 0, class: 'install', disposition: 'intent_created' },
            { index: 1, class: 'chase', disposition: 'intent_created' },
            { index: 2, class: 'chase', disposition: 'refused', reason: 'no_eligible_patches' },
            { index: 3, class: 'escalation', disposition: 'recorded' },
            { index: 4, class: 'escalation', disposition: 'recorded' },
          ],
          evidenceTruncated: false,
          generatedAt: '2026-09-14T02:00:00.000Z',
          ...extra,
        },
      },
    });
  }

  it('names failures and escalations in the patch digest title (W03)', async () => {
    queueRows('ai_agent_runs', [chaseRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Patch plan ready: 5 item(s), 2 escalation(s) (1 critical) — Front Desk Triage');
    // The message keeps the summary first, then the failure breakdown by class.
    expect(input.message).toMatch(/^Three installs failed; two are worth a retry\./);
    expect(input.message).toContain('2 retry proposal(s)');
    expect(input.message).toContain('2 escalation(s)');
    expect(input.message).toMatch(/disk_space 1/);
    expect(input.message).toMatch(/permanent 1/);
    expect(input.message).toMatch(/transient 1/);
    expect(input.message).toMatch(/unknown 1/);
  });

  it('states the queued-offline coverage note when there is one — not silence (W03)', async () => {
    queueRows('ai_agent_runs', [chaseRun({ queuedOffline: 4 })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.message).toContain('4 install(s) waiting for offline devices');

    createNotification.mockClear();
    queueRows('ai_agent_runs', [chaseRun({ queuedOffline: 0 })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    expect((createNotification.mock.calls[0]![0] as { message: string }).message).not.toContain('offline');
  });

  it('a plan with no chase or escalation keeps the W01 title verbatim (W03)', async () => {
    queueRows('ai_agent_runs', [patchRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Patch plan ready: 3 item(s) (2 critical) — Front Desk Triage');
    expect(input.message).toBe('Two servers are behind on critical updates.');
  });

  it('an escalation goes to the EFFECTIVE policy snapshot recipients (W03 regression pin)', async () => {
    queueRows('ai_agent_runs', [chaseRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    await deliverRunFinishedNotifications(RUN_ID);
    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: baseRun.policySnapshot.effective.recipients }),
      ORG_ID,
    );
  });

  it('opens no ticket for an escalation (OD-7 A) — asserted on the source', () => {
    const src = readFileSync(join(__dirname, 'runFinishedNotify.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/createTicket|ticketService|insert\(tickets\)/);
  });

  it('never applies the patch copy to another profile, even with a patchPlan on the outcome', async () => {
    queueRows('ai_agent_runs', [patchRun({ profile: 'full' })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]! as [Record<string, unknown>];
    expect(input.title).toBe('Agent run finished');
  });
});

// ---------------------------------------------------------------------------
// #6908 — suppress the "Agent run finished" notification for an
// alert-triggered `full`-profile run that ended `no_action` with nothing
// proposed. Same rationale `runLoop.ts` already applies to VERDICT-profile
// runs (their finished surface is the alert badge, not a bell item); this is
// the equivalent decision for a full-profile run, made here because only
// this module reads the run's own `runVerdict`.
// ---------------------------------------------------------------------------
describe('deliverRunFinishedNotifications — alert-triggered no-action suppression (#6908)', () => {
  function alertNoActionRun(overrides: Record<string, unknown> = {}) {
    return {
      ...baseRun,
      profile: 'full',
      triggerKind: 'alert',
      status: 'completed',
      intentIds: [] as string[],
      outcome: { toolExecutionCount: 1, runVerdict: 'no_action' },
      ...overrides,
    };
  }

  it('suppresses: alert-triggered full run, completed, no_action, zero intents', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun()]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).not.toHaveBeenCalled();
    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('no notification'),
      expect.objectContaining({ runId: RUN_ID }),
    );
    infoSpy.mockRestore();
  });

  it('does NOT suppress the same run when it carries one intent', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun({
      intentIds: [INTENT_ID],
      status: 'awaiting_approval',
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress the same run when the verdict is needs_attention', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun({
      outcome: { toolExecutionCount: 1, runVerdict: 'needs_attention' },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress the same run when the verdict is acted (remediated)', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun({
      outcome: { toolExecutionCount: 1, runVerdict: 'remediated' },
    })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress a sweep run with the same no_action shape (P2-2 rule unchanged)', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun({ profile: 'sweep' })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT suppress a manual-triggered full run with the same no_action shape', async () => {
    queueRows('ai_agent_runs', [alertNoActionRun({ triggerKind: 'manual' })]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
