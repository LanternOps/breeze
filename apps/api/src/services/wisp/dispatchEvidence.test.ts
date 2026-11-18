/**
 * #10427 (W08 Task 1) — dispatch evidence. A dispatch-class tool that answers
 * "success" without any id that proves something was dispatched is rewritten
 * to read as unverified, so the model cannot report it as done; and the turn's
 * tool outcomes are summarised into the evidence the promise linter checks.
 *
 * Every fixture below is the literal success shape its handler returns (file
 * named per entry), so a handler that changes its output shape breaks here.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_EVIDENCE,
  DISPATCH_UNVERIFIED_NOTE,
  normaliseDispatchResult,
  turnEvidenceFrom,
} from './dispatchEvidence';
import type { WispTurnToolOutcome } from './turnRecord';

const ID = '7b0c4a9e-3f51-4c2d-9a8e-1d2f3a4b5c6d';
const DEV = '11111111-2222-4333-8444-555566667777';

type Fixture = {
  input: Record<string, unknown>;
  output: string;
  /** The same output with every evidence key removed; null for text-only tools (never rewritten). */
  stripped: string | null;
};

/** One real success output per DISPATCH_EVIDENCE entry. */
const FIXTURES: Record<string, Fixture> = {
  // aiToolsFleet.ts — manage_patches action 'scan'
  manage_patches: {
    input: { action: 'scan', deviceIds: [DEV] },
    output: JSON.stringify({
      success: true,
      message: 'Patch scan queued for 1 of 1 device(s). An online device runs it now.',
      queued: [{ deviceId: DEV, commandId: ID, delivery: 'sent' }],
      failed: [],
    }),
    stripped: JSON.stringify({
      success: true,
      message: 'Patch scan queued for 1 of 1 device(s). An online device runs it now.',
      queued: [{ deviceId: DEV, delivery: 'sent' }],
      failed: [],
    }),
  },
  // aiToolsScripts.ts — run_script library script
  run_script: {
    input: { scriptId: ID, deviceIds: [DEV] },
    output: JSON.stringify({ results: { [DEV]: { status: 'completed', exitCode: 0, stdout: 'ok', commandId: ID, executionId: ID, runAs: 'system' } } }),
    stripped: JSON.stringify({ results: { [DEV]: { status: 'completed', exitCode: 0, stdout: 'ok', runAs: 'system' } } }),
  },
  // aiToolsScripts.ts — execute_command (CommandResult, commandQueue.ts)
  execute_command: {
    input: { deviceId: DEV, commandType: 'reboot' },
    output: JSON.stringify({ status: 'completed', exitCode: 0, stdout: '', durationMs: 120, commandId: ID }),
    stripped: JSON.stringify({ status: 'completed', exitCode: 0, stdout: '', durationMs: 120 }),
  },
  // aiToolsScripts.ts — manage_services restart (CommandResult)
  manage_services: {
    input: { action: 'restart', deviceId: DEV, serviceName: 'Spooler' },
    output: JSON.stringify({ status: 'completed', exitCode: 0, commandId: ID }),
    stripped: JSON.stringify({ status: 'completed', exitCode: 0 }),
  },
  // aiToolsAiAgentLaunch.ts — run_patch_plan
  run_patch_plan: {
    input: { orgId: ID },
    output: JSON.stringify({ queued: true, runId: ID }),
    stripped: JSON.stringify({ queued: true }),
  },
  // aiToolsWisp.ts render() — launch_specialist (coordinator RequestSpecialistResult)
  launch_specialist: {
    input: { kind: 'analysis', brief: 'look at disk' },
    output: JSON.stringify({ admitted: true, runId: ID }),
    stripped: JSON.stringify({ message: 'ok' }),
  },
  // aiToolsWisp.ts — wisp_specialist_request (the approval carrier's release; same render)
  wisp_specialist_request: {
    input: { kind: 'sweep' },
    output: JSON.stringify({ admitted: true }),
    stripped: JSON.stringify({ message: 'ok' }),
  },
  // wisp/checkInTools.ts — schedule_check_in (text)
  schedule_check_in: {
    input: { delayMinutes: 10, instruction: 'check the scan' },
    output: `Check-in scheduled (ID: ${ID}) for 2026-11-09T12:00:00.000Z. Breeze will notify the user then, and the instruction comes back to you with their next message in this thread.`,
    stripped: null,
  },
  // wisp/concernTools.ts — create_watch (text)
  create_watch: {
    input: { orgId: ID, kind: 'device_offline' },
    output: `Watch created (ID: ${ID}), first check 2026-11-09T12:00:00.000Z.`,
    stripped: null,
  },
  // wisp/concernTools.ts — raise_concern (text)
  raise_concern: {
    input: { orgId: ID, title: 'Disk filling' },
    output: `Concern raised (ID: ${ID}).`,
    stripped: null,
  },
  // wisp/memoryTools.ts — remember (text)
  remember: {
    input: { blockType: 'preference', content: { text: 'short answers' } },
    output: `Remembered as unconfirmed (ID: ${ID}). The owner can confirm or retract it on the Wisp memory page.`,
    stripped: null,
  },
};

function outcome(toolName: string, input: Record<string, unknown>, output: string, isError = false): WispTurnToolOutcome {
  return { toolName, input, output, isError };
}

describe('DISPATCH_EVIDENCE', () => {
  it('has a recorded real-output fixture for every entry, and no fixture without an entry', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(DISPATCH_EVIDENCE).sort());
  });

  it('covers the dispatch-class tools the plan names', () => {
    for (const name of ['manage_patches', 'run_script', 'execute_command', 'manage_services', 'run_patch_plan',
      'launch_specialist', 'schedule_check_in', 'create_watch', 'raise_concern', 'remember']) {
      expect(DISPATCH_EVIDENCE).toHaveProperty(name);
    }
    expect(DISPATCH_EVIDENCE.manage_patches!.actions).toEqual(['scan', 'install']);
    expect(DISPATCH_EVIDENCE.manage_services!.actions).toEqual(['start', 'stop', 'restart']);
  });
});

describe('normaliseDispatchResult', () => {
  for (const [tool, fx] of Object.entries(FIXTURES)) {
    it(`${tool}: the real success output is left unchanged`, () => {
      expect(normaliseDispatchResult(tool, fx.input, fx.output)).toEqual({ output: fx.output, unverified: false });
    });

    if (fx.stripped !== null) {
      const stripped = fx.stripped;
      it(`${tool}: the same output with its evidence keys removed reads as unverified`, () => {
        const res = normaliseDispatchResult(tool, fx.input, stripped);
        expect(res.unverified).toBe(true);
        const parsed = JSON.parse(res.output);
        expect(parsed).toMatchObject({ success: false, dispatchUnverified: true, note: DISPATCH_UNVERIFIED_NOTE });
        // The handler's own words stay visible, under the note.
        expect(parsed.result).toEqual(JSON.parse(stripped));
      });
    }
  }

  it('pins the note: "unverified", never "nothing dispatched", so the model does not re-run it', () => {
    expect(DISPATCH_UNVERIFIED_NOTE).toBe(
      'dispatch unverified: no job, command or intent id came back; do not report it as done and do not retry without checking',
    );
  });

  it('manage_patches install: a job id is the evidence; a missing one reads as unverified', () => {
    const input = { action: 'install', patchIds: [ID], deviceIds: [DEV] };
    const real = JSON.stringify({ success: true, jobId: ID, patchCount: 1, deviceCount: 1 });
    expect(normaliseDispatchResult('manage_patches', input, real).unverified).toBe(false);
    // `jobId: job?.id` serialises to nothing when the insert returned no row.
    const noJob = JSON.stringify({ success: true, jobId: undefined, patchCount: 1, deviceCount: 1 });
    expect(normaliseDispatchResult('manage_patches', input, noJob).unverified).toBe(true);
  });

  it('manage_patches list is never touched', () => {
    const list = JSON.stringify({ patches: [], showing: 0, limit: 50, offset: 0, hasMore: false, scope: 'device' });
    expect(normaliseDispatchResult('manage_patches', { action: 'list', deviceId: DEV }, list)).toEqual({ output: list, unverified: false });
  });

  it('manage_services list is never touched', () => {
    const list = JSON.stringify({ status: 'completed', stdout: 'Spooler running' });
    expect(normaliseDispatchResult('manage_services', { action: 'list', deviceId: DEV }, list).unverified).toBe(false);
  });

  it('a tool not in the map is never touched', () => {
    const out = JSON.stringify({ success: true });
    expect(normaliseDispatchResult('query_devices', {}, out)).toEqual({ output: out, unverified: false });
  });

  it('non-JSON output is untouched', () => {
    expect(normaliseDispatchResult('run_script', {}, 'queued ok')).toEqual({ output: 'queued ok', unverified: false });
    expect(normaliseDispatchResult('schedule_check_in', {}, 'Check-in scheduled.')).toEqual({ output: 'Check-in scheduled.', unverified: false });
  });

  it('success: false is untouched', () => {
    const out = JSON.stringify({ success: false, message: 'refused' });
    expect(normaliseDispatchResult('manage_patches', { action: 'scan' }, out).unverified).toBe(false);
  });

  it('an error result is untouched', () => {
    const out = JSON.stringify({ status: 'failed', error: 'Device is offline' });
    expect(normaliseDispatchResult('execute_command', {}, out)).toEqual({ output: out, unverified: false });
  });

  it('an oversized-result capture envelope is untouched', () => {
    const out = JSON.stringify({ artifact: { id: ID }, compacted: '{"results":{}}' });
    expect(normaliseDispatchResult('run_script', {}, out).unverified).toBe(false);
  });

  it('an empty-string or null evidence value is not evidence', () => {
    expect(normaliseDispatchResult('run_patch_plan', {}, JSON.stringify({ queued: true, runId: '' })).unverified).toBe(true);
    expect(normaliseDispatchResult('run_patch_plan', {}, JSON.stringify({ queued: true, runId: null })).unverified).toBe(true);
  });

  it('a run_script whose every device was suppressed by a maintenance window reads as unverified', () => {
    const out = JSON.stringify({ results: { [DEV]: { status: 'suppressed', suppressedBy: 'maintenance_window', message: 'In a maintenance window' } } });
    const res = normaliseDispatchResult('run_script', { deviceIds: [DEV] }, out);
    expect(res.unverified).toBe(true);
    expect(JSON.parse(res.output).result.results[DEV].suppressedBy).toBe('maintenance_window');
  });
});

describe('turnEvidenceFrom', () => {
  const empty = {
    checkInScheduled: false,
    watchCreated: false,
    specialistLaunched: false,
    dispatched: [],
    pendingApprovals: 0,
    assessmentQueued: false,
    concernChanged: false,
    toolCalls: 0,
    dispatchAttempted: false,
  };

  it('no tool calls, no evidence', () => {
    expect(turnEvidenceFrom([])).toEqual(empty);
  });

  it('reads each real success output as its evidence', () => {
    const outcomes = Object.entries(FIXTURES).map(([tool, fx]) => outcome(tool, fx.input, fx.output));
    const ev = turnEvidenceFrom(outcomes);
    expect(ev.checkInScheduled).toBe(true);
    expect(ev.watchCreated).toBe(true);
    expect(ev.specialistLaunched).toBe(true);
    expect(ev.concernChanged).toBe(true);
    expect(ev.dispatched.sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  it('accepts the MCP-qualified tool name', () => {
    expect(turnEvidenceFrom([outcome('mcp__breeze__schedule_check_in', {}, FIXTURES.schedule_check_in!.output)]).checkInScheduled).toBe(true);
  });

  it('an unverified, failed or errored dispatch is not evidence', () => {
    const unverified = normaliseDispatchResult('run_patch_plan', {}, JSON.stringify({ queued: true })).output;
    const ev = turnEvidenceFrom([
      outcome('run_patch_plan', {}, unverified),
      outcome('execute_command', {}, JSON.stringify({ status: 'failed', error: 'Device is offline' }), true),
      outcome('schedule_check_in', {}, JSON.stringify({ error: 'check_in_limit_reached' }), true),
      outcome('manage_patches', { action: 'scan' }, JSON.stringify({ success: false, error: 'No patch scan was queued', queued: [], failed: [{ deviceId: DEV, error: 'offline' }] })),
    ]);
    // Attempted, but nothing proven.
    expect(ev).toEqual({ ...empty, toolCalls: 4, dispatchAttempted: true });
  });

  it('counts every tool call, and a read is not a dispatch attempt', () => {
    const ev = turnEvidenceFrom([
      outcome('query_devices', {}, JSON.stringify({ devices: [] })),
      outcome('manage_patches', { action: 'list' }, JSON.stringify({ patches: [] })),
    ]);
    expect(ev).toEqual({ ...empty, toolCalls: 2 });
  });

  it('a partly refused scan still dispatched to the devices that took it', () => {
    const out = JSON.stringify({ success: false, message: 'Patch scan queued for 1 of 2 device(s)', queued: [{ deviceId: DEV, commandId: ID }], failed: [{ deviceId: ID, error: 'offline' }] });
    expect(turnEvidenceFrom([outcome('manage_patches', { action: 'scan' }, out)]).dispatched).toEqual(['manage_patches']);
  });

  it('a list action is not a dispatch', () => {
    const out = JSON.stringify({ patches: [{ id: ID, commandId: ID }], hasMore: false });
    expect(turnEvidenceFrom([outcome('manage_patches', { action: 'list' }, out)]).dispatched).toEqual([]);
  });

  it('dispatched names are listed once', () => {
    const fx = FIXTURES.execute_command!;
    expect(turnEvidenceFrom([outcome('execute_command', fx.input, fx.output), outcome('execute_command', fx.input, fx.output)]).dispatched).toEqual(['execute_command']);
  });

  describe('pending approvals', () => {
    it('an approved handoff the worker is carrying out counts', () => {
      const out = JSON.stringify({ status: 'approved_executing', message: 'Approved. This action is authorized and is being carried out by the approval worker now.' });
      expect(turnEvidenceFrom([outcome('run_script', {}, out)]).pendingApprovals).toBe(1);
    });

    it('a completed handoff counts', () => {
      const out = JSON.stringify({ status: 'approved_completed', message: 'Done.' });
      expect(turnEvidenceFrom([outcome('manage_services', { action: 'restart' }, out)]).pendingApprovals).toBe(1);
    });

    it('a failed handoff does not', () => {
      const out = JSON.stringify({ status: 'approved_failed', message: 'It failed.' });
      expect(turnEvidenceFrom([outcome('run_script', {}, out, true)]).pendingApprovals).toBe(0);
    });

    it('"approval still pending" counts, though the call reads as an error', () => {
      const out = JSON.stringify({ error: 'Approval still pending; this action will complete once approved.' });
      expect(turnEvidenceFrom([outcome('run_script', {}, out, true)]).pendingApprovals).toBe(1);
    });

    it('a step that waited for approval (#10416 approvalWaitSeconds) counts', () => {
      const out = JSON.stringify({ status: 'completed', commandId: ID, approvalWaitSeconds: 42 });
      expect(turnEvidenceFrom([outcome('execute_command', {}, out)]).pendingApprovals).toBe(1);
    });

    it('a specialist that needs approval counts', () => {
      const out = JSON.stringify({ needsApproval: true, intentId: ID });
      const ev = turnEvidenceFrom([outcome('launch_specialist', { kind: 'remediation_research' }, out)]);
      expect(ev.pendingApprovals).toBe(1);
    });

    it('a rejected or expired approval does not', () => {
      const out = JSON.stringify({ error: 'Tool execution was rejected, cancelled, or expired' });
      expect(turnEvidenceFrom([outcome('run_script', {}, out, true)]).pendingApprovals).toBe(0);
    });
  });

  describe('assessments', () => {
    const report = (outcomeName: string) => JSON.stringify({
      admitted: true,
      report: { orgs: [{ orgId: ID, orgName: 'Acme', outcome: outcomeName }] },
      message: 'Queued a Wisp assessment for Acme. Results land in this thread.',
    });

    it.each(['queued', 'coalesced', 'upgraded'])('an assessment %s this turn counts', (o) => {
      expect(turnEvidenceFrom([outcome('launch_specialist', { kind: 'assessment' }, report(o))]).assessmentQueued).toBe(true);
    });

    it('an assessment skipped for every org does not', () => {
      expect(turnEvidenceFrom([outcome('launch_specialist', { kind: 'assessment' }, report('skipped'))]).assessmentQueued).toBe(false);
    });
  });

  describe('check-ins, watches and concerns', () => {
    it('an existing check-in returned by list_check_ins counts', () => {
      const out = `<untrusted_data source="wisp_check_ins">\n${ID} | pending | due 2026-11-09T12:00:00.000Z | check the scan\n</untrusted_data>`;
      expect(turnEvidenceFrom([outcome('list_check_ins', {}, out)]).checkInScheduled).toBe(true);
    });

    it('an empty list_check_ins does not', () => {
      expect(turnEvidenceFrom([outcome('list_check_ins', {}, 'No check-ins are pending on this thread.')]).checkInScheduled).toBe(false);
    });

    it('an event check-in that fired at once counts as scheduled', () => {
      const out = `The device is already offline, so check-in ${ID} fired now: Breeze notified the user.`;
      expect(turnEvidenceFrom([outcome('schedule_check_in', {}, out)]).checkInScheduled).toBe(true);
    });

    it('a concern already on the radar is not a change', () => {
      const out = `Already on Wisp's radar (ID: ${ID}) — use resolve_concern or snooze_concern.`;
      expect(turnEvidenceFrom([outcome('raise_concern', {}, out)]).concernChanged).toBe(false);
    });

    it.each([
      ['resolve_concern', `Concern ${ID} resolved; the outcome is remembered for next time.`],
      ['snooze_concern', `Concern ${ID} snoozed for you until 2026-11-10T00:00:00.000Z.`],
    ])('%s changes a concern', (tool, out) => {
      expect(turnEvidenceFrom([outcome(tool, { concernId: ID }, out)]).concernChanged).toBe(true);
    });

    it('a concern tool error is not a change', () => {
      expect(turnEvidenceFrom([outcome('resolve_concern', {}, JSON.stringify({ error: 'concern_not_found' }), true)]).concernChanged).toBe(false);
    });
  });
});
