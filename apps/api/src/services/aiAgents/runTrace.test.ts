import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS } from '@breeze/shared';
import { buildRunTrace, type RunTraceRunInput } from './runTrace';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';

function baseRun(overrides: Partial<RunTraceRunInput> = {}): RunTraceRunInput {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    alertId: null,
    anomalyIncidentId: null,
    triggerKind: 'manual',
    modeAtStart: 'shadow',
    status: 'completed',
    summary: 'Restarted the print spooler.',
    // Phase 2 wave P2-2 (scheduled sweeps), Task A7 — `null`/`{}` for every
    // non-sweep run; the sweep projection reads the occurrence + kinds off
    // `triggerRef` (see `projectSweep`).
    scheduleId: null,
    triggerRef: {},
    // Phase 2 wave P2-3 (weekly org narrative), Task A7 — the report_runs
    // artifact a narrative run was materialised into; `null` everywhere else.
    reportRunId: null,
    outcome: {},
    // P2-4 (#4191), Task A10 — see RunTraceRunInput.intentIds's docstring.
    // Empty by default; ticketProposal-specific tests below override it.
    intentIds: [],
    turnCount: 3,
    costCents: 12,
    errorCode: null,
    queuedAt: new Date('2026-08-28T10:00:00.000Z'),
    startedAt: new Date('2026-08-28T10:00:01.000Z'),
    finishedAt: new Date('2026-08-28T10:00:30.000Z'),
    ...overrides,
  };
}

const AGENT = { name: 'Triage Agent', kind: 'triage' as const };
const DEVICE = { hostname: 'WKS-042' };

describe('buildRunTrace — safe projection (#3828)', () => {
  it('maps a full wave-4/5 outcome into executed, then proposed, then denied trace entries', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          executedActions: [
            {
              tool: 'manage_services',
              action: 'restart',
              executionId: 'exec-1',
              result: 'ok',
              durationMs: 340,
              execution: 'succeeded',
              verification: 'passed',
              verifyDetail: 'service running',
              actOpKey: 'manage_services.restart',
              actTargetName: 'Spooler',
            },
          ],
          proposedActions: [
            {
              tool: 'run_script',
              action: 'invoke',
              args: { scriptId: 'abc', secretParam: 'super-secret-value' },
              intentId: INTENT_ID,
              downgradeReason: 'missing identity field',
            },
          ],
          deniedActions: [{ tool: 'delete_registry_key', reason: 'protected resource' }],
          toolExecutionCount: 2,
          runVerdict: 'partial',
          budgetExceeded: false,
          wallClockExceeded: false,
          maxTurnsExceeded: false,
        },
      }),
      AGENT,
      DEVICE,
      [],
      [],
    );

    expect(detail.schemaVersion).toBe(1);
    expect(detail.runVerdict).toBe('partial');
    expect(detail.agentName).toBe('Triage Agent');
    expect(detail.deviceHostname).toBe('WKS-042');
    expect(detail.trace).toEqual([
      {
        kind: 'executed',
        tool: 'manage_services',
        action: 'restart',
        result: 'ok',
        durationMs: 340,
        execution: 'succeeded',
        verification: 'passed',
        verifyDetail: 'service running',
        actOpKey: 'manage_services.restart',
        actTargetName: 'Spooler',
      },
      {
        kind: 'proposed',
        tool: 'run_script',
        action: 'invoke',
        intentId: INTENT_ID,
        intentError: undefined,
        downgradeReason: 'missing identity field',
      },
      { kind: 'denied', tool: 'delete_registry_key', reason: 'protected resource' },
    ]);
  });

  it('never carries the proposed action\'s raw args onto the trace, even when present on the source outcome', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          proposedActions: [
            {
              tool: 'run_script',
              args: { toolInput: 'ignored-key-name-collision', secret: 'zzz-leak-marker-zzz' },
            },
          ],
        },
      }),
      AGENT,
      null,
      [],
      [],
    );

    const json = JSON.stringify(detail);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(json).not.toContain(`"${forbidden}"`);
    }
    // The nested secret value itself must not have leaked through either.
    expect(json).not.toContain('zzz-leak-marker-zzz');
  });

  it('tolerates a wave-3-era outcome with no runVerdict/execution/verification fields at all', () => {
    const detail = buildRunTrace(
      baseRun({
        outcome: {
          executedActions: [
            { tool: 'get_processes', executionId: 'exec-9', result: 'ok', durationMs: 50 },
          ],
          proposedActions: [],
          deniedActions: [],
          toolExecutionCount: 1,
          // no runVerdict, no budgetExceeded/wallClockExceeded/maxTurnsExceeded
        },
      }),
      AGENT,
      null,
      [],
      [],
    );

    expect(detail.runVerdict).toBeNull();
    expect(detail.budgetExceeded).toBe(false);
    expect(detail.wallClockExceeded).toBe(false);
    expect(detail.maxTurnsExceeded).toBe(false);
    expect(detail.trace).toEqual([
      {
        kind: 'executed',
        tool: 'get_processes',
        action: undefined,
        result: 'ok',
        durationMs: 50,
        execution: undefined,
        verification: undefined,
        verifyDetail: undefined,
        actOpKey: undefined,
        actTargetName: undefined,
      },
    ]);
  });

  it('tolerates a completely empty/malformed outcome object without throwing', () => {
    const detail = buildRunTrace(baseRun({ outcome: {} }), AGENT, null, [], []);
    expect(detail.trace).toEqual([]);
    expect(detail.runVerdict).toBeNull();
    expect(detail.ticketProposal).toBeNull();
  });

  describe('ticketProposal (wave 6 PR 3, #3828, Task 4)', () => {
    it('projects a ticket run\'s ticketProposal verbatim (it is already text-only)', () => {
      const detail = buildRunTrace(
        baseRun({
          triggerKind: 'ticket',
          deviceId: null,
          outcome: {
            findings: [],
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            ticketProposal: {
              version: 1,
              summary: 'The print spooler was stuck; a restart would likely fix it.',
              draftReply: 'Hi — please try restarting your computer; this often clears it.',
              fields: { priority: { value: 'normal', confidence: 0.9 } },
              notes: ['Spooler.exe pegged at 100% CPU'],
            },
          },
        }),
        AGENT,
        null,
        [],
        [],
      );

      expect(detail.ticketProposal).toEqual({
        version: 1,
        summary: 'The print spooler was stuck; a restart would likely fix it.',
        draftReply: 'Hi — please try restarting your computer; this often clears it.',
        fields: { priority: { value: 'normal', confidence: 0.9 } },
        device: undefined,
        draftResolutionNote: undefined,
        notes: ['Spooler.exe pegged at 100% CPU'],
      });
    });

    it('is null for a non-ticket run (no ticketProposal on the outcome at all)', () => {
      const detail = buildRunTrace(baseRun({ outcome: { findings: [] } }), AGENT, DEVICE, [], []);
      expect(detail.ticketProposal).toBeNull();
    });

    describe('intentIds + draftsWritten (P2-4, #4191, Task A10)', () => {
      const PROPOSAL_OUTCOME = {
        ticketProposal: { version: 1, summary: 'Restart the spooler.', notes: [] },
      };

      it('projects the run\'s own intent_ids column as ticketProposal.intentIds', () => {
        const detail = buildRunTrace(
          baseRun({ triggerKind: 'ticket', outcome: PROPOSAL_OUTCOME, intentIds: [INTENT_ID] }),
          AGENT, null, [], [],
        );
        expect(detail.ticketProposal?.intentIds).toEqual([INTENT_ID]);
      });

      it('leaves intentIds undefined (not an empty array) when the run created none', () => {
        const detail = buildRunTrace(
          baseRun({ triggerKind: 'ticket', outcome: PROPOSAL_OUTCOME, intentIds: [] }),
          AGENT, null, [], [],
        );
        expect(detail.ticketProposal?.intentIds).toBeUndefined();
      });

      it('projects the caller\'s live ticket_drafts rows as draftsWritten', () => {
        const draftRows = [{ id: 'draft-1', kind: 'reply' as const }];
        const detail = buildRunTrace(
          baseRun({ triggerKind: 'ticket', outcome: PROPOSAL_OUTCOME, intentIds: [] }),
          AGENT, null, [], [], new Map(), null, draftRows,
        );
        expect(detail.ticketProposal?.draftsWritten).toEqual([{ kind: 'reply', draftId: 'draft-1' }]);
      });

      it('leaves draftsWritten undefined when no draft rows are linked to the run', () => {
        const detail = buildRunTrace(
          baseRun({ triggerKind: 'ticket', outcome: PROPOSAL_OUTCOME, intentIds: [] }),
          AGENT, null, [], [], new Map(), null, [],
        );
        expect(detail.ticketProposal?.draftsWritten).toBeUndefined();
      });

      it('never carries draft content — only id/kind — even if the caller\'s row shape somehow had it', () => {
        const draftRows = [{ id: 'draft-1', kind: 'resolution_note' as const, content: 'leak-marker-zzz' } as never];
        const detail = buildRunTrace(
          baseRun({ triggerKind: 'ticket', outcome: PROPOSAL_OUTCOME, intentIds: [] }),
          AGENT, null, [], [], new Map(), null, draftRows,
        );
        const json = JSON.stringify(detail.ticketProposal);
        expect(json).not.toContain('leak-marker-zzz');
      });
    });

    it('never carries an args/toolInput/toolOutput/arguments key even if a malformed outcome tried to smuggle one in', () => {
      const detail = buildRunTrace(
        baseRun({
          outcome: {
            ticketProposal: {
              summary: 'x',
              notes: [],
              // Deliberately malformed input (not a real `TicketProposalOutcome`
              // field) — proves the mapper picks named fields rather than
              // spreading the source object onto the DTO.
              args: { secret: 'leak-marker' },
            },
          },
        }),
        AGENT,
        null,
        [],
        [],
      );
      const json = JSON.stringify(detail.ticketProposal);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
      expect(json).not.toContain('leak-marker');
    });
  });

  describe('anomalyIncidentId (wave 6 PR 4, #3828 Task 1)', () => {
    it('projects the triggering incident id for an anomaly-triggered run', () => {
      const detail = buildRunTrace(
        baseRun({ triggerKind: 'anomaly', anomalyIncidentId: 'incident-1' }),
        AGENT, DEVICE, [], [],
      );
      expect(detail.anomalyIncidentId).toBe('incident-1');
    });

    it('is null for every other trigger kind', () => {
      const detail = buildRunTrace(baseRun(), AGENT, DEVICE, [], []);
      expect(detail.anomalyIncidentId).toBeNull();
    });
  });

  it('defends against a corrupted non-array outcome field by treating it as empty', () => {
    const detail = buildRunTrace(
      baseRun({ outcome: { executedActions: 'not-an-array', proposedActions: null } }),
      AGENT,
      null,
      [],
      [],
    );
    expect(detail.trace).toEqual([]);
  });

  it('maps ledger rows to the safe projection only (toolName/status/durations/error)', () => {
    const detail = buildRunTrace(
      baseRun(),
      AGENT,
      DEVICE,
      [
        {
          toolName: 'run_script',
          status: 'completed',
          durationMs: 210,
          createdAt: new Date('2026-08-28T10:00:05.000Z'),
          completedAt: new Date('2026-08-28T10:00:06.000Z'),
          errorMessage: null,
        },
      ],
      [],
    );
    expect(detail.ledger).toEqual([
      {
        toolName: 'run_script',
        status: 'completed',
        durationMs: 210,
        createdAt: '2026-08-28T10:00:05.000Z',
        completedAt: '2026-08-28T10:00:06.000Z',
        errorMessage: null,
      },
    ]);
  });

  it('maps intent rows to id/status/actionName/approvalScope/decidedVia only', () => {
    const detail = buildRunTrace(
      baseRun(),
      AGENT,
      DEVICE,
      [],
      [
        {
          id: INTENT_ID,
          status: 'pending_approval',
          actionName: 'manage_services.restart',
          approvalScope: 'four_eyes',
          decidedVia: null,
        },
      ],
    );
    expect(detail.intents).toEqual([
      {
        id: INTENT_ID,
        status: 'pending_approval',
        actionName: 'manage_services.restart',
        approvalScope: 'four_eyes',
        decidedVia: null,
      },
    ]);
  });

  it('is null for deviceHostname when the run has no device', () => {
    const detail = buildRunTrace(baseRun({ deviceId: null }), AGENT, null, [], []);
    expect(detail.deviceId).toBeNull();
    expect(detail.deviceHostname).toBeNull();
  });

  // Review fix (#3828): the route left-joins ai_agents (not innerJoin) because
  // a partner-wide agent's row (#2135) is RLS-invisible to an org-scoped
  // caller even though the run it produced stays visible. `agent: null` is
  // how that shows up here — the run must still produce a full DTO, with
  // agentName/agentKind null rather than the run vanishing (404).
  it('is null for agentName/agentKind when the agent is null (RLS-hidden partner-wide agent)', () => {
    const detail = buildRunTrace(baseRun(), null, DEVICE, [], []);
    expect(detail.agentName).toBeNull();
    expect(detail.agentKind).toBeNull();
    expect(detail.id).toBe(RUN_ID);
  });

  // Phase 2 wave P2-1 (alert verdicts), Task 8: the real `alertVerdict`
  // projection, replacing the unconditional `null` placeholder.
  describe('alertVerdict projection (P2-1, Task 8)', () => {
    it('is null when the outcome carries no alertVerdict (every full-profile run, and a verdict run that has not produced one yet)', () => {
      const detail = buildRunTrace(baseRun({ outcome: {} }), AGENT, DEVICE, [], []);
      expect(detail.alertVerdict).toBeNull();
    });

    it('projects a verdict run\'s outcome (with no intent attempt recorded — disposition defaults not_created), and the whole detail DTO leaks no tripwire key', () => {
      const detail = buildRunTrace(
        baseRun({
          alertId: null,
          outcome: {
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            alertVerdict: {
              classification: 'recurring_pattern',
              confidence: 0.83,
              rationale: 'Same disk alert fires nightly at 02:00; self-heals within the hour.',
              pattern: { kind: 'daily', evidenceAlertIds: ['aaaa1111-1111-4111-8111-111111111111'] },
              suggestedAction: {
                tool: 'manage_alerts', action: 'suppress',
                alertId: 'aaaa1111-1111-4111-8111-111111111111', suppressDuration: 24,
              },
            },
            // No `alertVerdictIntent` on this outcome — projectAlertVerdict
            // must still produce a full `suggestedAction` sub-object rather
            // than throwing on the missing second argument.
          },
        }),
        AGENT,
        DEVICE,
        [],
        [],
      );

      expect(detail.alertVerdict).toEqual({
        classification: 'recurring_pattern',
        confidence: 0.83,
        rationale: 'Same disk alert fires nightly at 02:00; self-heals within the hour.',
        patternKind: 'daily',
        evidenceAlertIds: ['aaaa1111-1111-4111-8111-111111111111'],
        suggestedAction: { tool: 'manage_alerts', action: 'suppress', disposition: 'not_created', reason: null },
      });

      // Leak-tripwire over the WHOLE detail DTO, not just the alertVerdict
      // sub-object — same convention as the proposed-action tripwire test
      // above. `suppressDuration` is on the raw suggestedAction but must
      // not survive the projection either.
      const json = JSON.stringify(detail);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
      expect(json).not.toContain('suppressDuration');
    });

    // Review round 1 (IMPORTANT 2): the disposition/reason of a suggestion's
    // Tier-2 intent attempt must reach the wire alongside the verdict.
    it('projects outcome.alertVerdictIntent onto suggestedAction.disposition/reason', () => {
      const detail = buildRunTrace(
        baseRun({
          alertId: null,
          outcome: {
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            alertVerdict: {
              classification: 'actionable',
              confidence: 0.9,
              rationale: 'Disk at 96% and climbing; safe to suppress while capacity is added.',
              suggestedAction: {
                tool: 'manage_alerts', action: 'suppress',
                alertId: 'aaaa1111-1111-4111-8111-111111111111', suppressDuration: 24,
              },
            },
            alertVerdictIntent: { disposition: 'not_created', reason: 'no_eligible_approvers' },
          },
        }),
        AGENT,
        DEVICE,
        [],
        [],
      );

      expect(detail.alertVerdict?.suggestedAction).toEqual({
        tool: 'manage_alerts', action: 'suppress', disposition: 'not_created', reason: 'no_eligible_approvers',
      });
    });
  });

  // Phase 2 wave P2-2 (scheduled sweeps), Task A7.
  describe('sweep projection (P2-2, Task A7)', () => {
    const SCHEDULE_ID = '66666666-6666-4666-8666-666666666666';

    it('is null for every non-sweep run (no sweepFindings on the outcome)', () => {
      const detail = buildRunTrace(baseRun({ outcome: {} }), AGENT, DEVICE, [], []);
      expect(detail.sweep).toBeNull();
    });

    it('projects a sweep run\'s findings with batched hostnames and leaks no tripwire key', () => {
      const detail = buildRunTrace(
        baseRun({
          deviceId: null,
          triggerKind: 'schedule',
          scheduleId: SCHEDULE_ID,
          triggerRef: {
            scheduleId: SCHEDULE_ID,
            occurrenceKey: '2026-08-29T06:00:00Z',
            sweepKinds: ['service_down'],
          },
          outcome: {
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            sweepFindings: {
              summary: 'One service is down.',
              findings: [{
                kind: 'service_down',
                severity: 'critical',
                deviceId: DEVICE_ID,
                title: 'Spooler is stopped',
                detail: 'Spooler has been stopped for 3 days.',
                evidence: { state: 'stopped' },
                proposedAction: {
                  tool: 'manage_services', action: 'restart',
                  deviceId: DEVICE_ID, serviceName: 'Spooler',
                },
              }],
            },
            sweepProposals: [{
              findingIndex: 0,
              tool: 'manage_services',
              action: 'restart',
              deviceId: DEVICE_ID,
              disposition: 'intent_created',
              intentId: INTENT_ID,
            }],
            sweepEvidenceTruncated: false,
          },
        }),
        AGENT,
        null,
        [],
        [],
        new Map([[DEVICE_ID, 'WS-ACCT-04']]),
      );

      expect(detail.sweep).toEqual({
        scheduleId: SCHEDULE_ID,
        occurrenceKey: '2026-08-29T06:00:00Z',
        kinds: ['service_down'],
        summary: 'One service is down.',
        evidenceTruncated: false,
        findings: [{
          kind: 'service_down',
          severity: 'critical',
          deviceId: DEVICE_ID,
          deviceHostname: 'WS-ACCT-04',
          title: 'Spooler is stopped',
          detail: 'Spooler has been stopped for 3 days.',
          evidence: { state: 'stopped' },
          proposal: {
            tool: 'manage_services',
            action: 'restart',
            disposition: 'intent_created',
            reason: null,
            intentId: INTENT_ID,
          },
        }],
      });

      const json = JSON.stringify(detail);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
      expect(json).not.toContain('proposedAction');
      expect(json).not.toContain('serviceName');
    });

    // #4189 bug fix: a finding that omitted `deviceId` (the model didn't
    // repeat the id it already put on `proposedAction`) must still project a
    // resolved device and hostname — never "—" — via the proposal record.
    it('projects the proposal device and hostname for a finding that omitted its own deviceId', () => {
      const detail = buildRunTrace(
        baseRun({
          deviceId: null,
          triggerKind: 'schedule',
          scheduleId: SCHEDULE_ID,
          triggerRef: { scheduleId: SCHEDULE_ID, sweepKinds: ['service_down'] },
          outcome: {
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            sweepFindings: {
              summary: 'One service is down.',
              findings: [{
                kind: 'service_down',
                severity: 'critical',
                // deviceId intentionally omitted — only the proposal names it.
                title: 'Spooler is stopped',
                detail: 'Spooler has been stopped for 3 days.',
                evidence: { state: 'stopped' },
                proposedAction: {
                  tool: 'manage_services', action: 'restart',
                  deviceId: DEVICE_ID, serviceName: 'Spooler',
                },
              }],
            },
            sweepProposals: [{
              findingIndex: 0,
              tool: 'manage_services',
              action: 'restart',
              deviceId: DEVICE_ID,
              disposition: 'intent_created',
              intentId: INTENT_ID,
            }],
            sweepEvidenceTruncated: false,
          },
        }),
        AGENT,
        null,
        [],
        [],
        new Map([[DEVICE_ID, 'WS-ACCT-04']]),
      );

      expect(detail.sweep?.findings[0]?.deviceId).toBe(DEVICE_ID);
      expect(detail.sweep?.findings[0]?.deviceHostname).toBe('WS-ACCT-04');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 2 wave P2-3 (weekly org narrative), task 6 — leak tripwire.
  //
  // The weekly `NarrativeContext` is a whole organization's activity,
  // assembled under a SYSTEM db context that bypasses RLS. It exists to be
  // rendered into ONE prompt. `buildRunTrace` is a named-field projection, so
  // the guarantee is structural rather than filtered — this case pins it, and
  // pins it against the shape a future task is most likely to reach for
  // (stashing the context on the outcome "so the report can quote it").
  // -------------------------------------------------------------------------
  describe('narrative run projection (P2-3)', () => {
    const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';

    it('never carries the weekly narrative context onto the trace, even when the outcome holds one', () => {
      const detail = buildRunTrace(
        baseRun({
          deviceId: null,
          triggerKind: 'schedule',
          scheduleId: SCHEDULE_ID,
          triggerRef: { scheduleId: SCHEDULE_ID, occurrenceKey: '2026-08-31T07:00:00Z', kind: 'narrative' },
          outcome: {
            executedActions: [],
            proposedActions: [],
            deniedActions: [],
            toolExecutionCount: 0,
            narrative: {
              version: 1,
              headline: 'A quiet week.',
              sections: [{ key: 'overview', title: 'Overview', bullets: ['Nothing needed a person.'] }],
              markdown: '# A quiet week.\n\n## Overview\n- Nothing needed a person.',
            },
            // Not a field of `AgentRunOutcome` — deliberately forged onto the
            // stored jsonb, which is exactly how this would reach the DTO if
            // the projection ever became a spread.
            narrativeContext: {
              org: { name: 'Acme Dental', partnerName: 'zzz-leak-marker-zzz' },
              unavailable: ['alerts.suppressedInWindow'],
              toolInput: { secret: 'zzz-leak-marker-zzz' },
            },
          } as never,
        }),
        AGENT,
        null,
        [],
        [],
      );

      const json = JSON.stringify(detail);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
      for (const forbidden of ['narrativeContext', 'context', 'unavailable', 'partnerName']) {
        expect(json, `trace must not carry "${forbidden}"`).not.toContain(`"${forbidden}"`);
      }
      expect(json).not.toContain('zzz-leak-marker-zzz');
      // Control: the run itself still projected — a trace that dropped
      // everything would pass every assertion above vacuously.
      expect(detail.id).toBe(RUN_ID);
      expect(detail.status).toBe('completed');

      // The narrative IS projected (a run that produced one must render), and
      // still leaks nothing — this is the discriminating half of the tripwire
      // above, which would otherwise pass on a DTO that dropped everything.
      expect(detail.narrative?.headline).toBe('A quiet week.');
      expect(detail.narrative?.sections.map((s) => s.key)).toEqual(['overview']);
    });

    it('projects the artifact linkage a narrative run was materialised into', () => {
      const REPORT_ID = '88888888-8888-4888-8888-888888888888';
      const REPORT_RUN_ID = '99999999-9999-4999-8999-999999999999';

      const detail = buildRunTrace(
        baseRun({
          deviceId: null,
          triggerKind: 'schedule',
          scheduleId: SCHEDULE_ID,
          reportRunId: REPORT_RUN_ID,
          outcome: {
            narrative: {
              version: 1,
              headline: 'A quiet week.',
              sections: [{ key: 'overview', title: 'Overview', bullets: ['Nothing needed a person.'] }],
              markdown: '# A quiet week.',
            },
            narrativeReport: { reportId: REPORT_ID, reportRunId: REPORT_RUN_ID },
          } as never,
        }),
        AGENT,
        null,
        [],
        [],
        new Map(),
        {
          reportId: REPORT_ID,
          periodStart: '2026-08-24T07:00:00+02:00',
          periodEnd: '2026-08-31T07:00:00+02:00',
          contextTruncated: true,
        },
      );

      expect(detail.reportRunId).toBe(REPORT_RUN_ID);
      expect(detail.narrative).toMatchObject({
        reportRunId: REPORT_RUN_ID,
        reportId: REPORT_ID,
        downloadPath: `/api/reports/runs/${REPORT_RUN_ID}/download`,
        periodStart: '2026-08-24T07:00:00+02:00',
        periodEnd: '2026-08-31T07:00:00+02:00',
        contextTruncated: true,
      });
    });

    it('projects null narrative/reportRunId for every non-narrative run', () => {
      const detail = buildRunTrace(baseRun(), AGENT, DEVICE, [], []);

      expect(detail.narrative).toBeNull();
      expect(detail.reportRunId).toBeNull();
    });
  });
});
