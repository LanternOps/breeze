import { describe, expect, it } from 'vitest';
import { deviceCountsSuffix, emitCreateAlertStep, emitDeviceItems, emitFailureNoticeSteps, emitFailureSummarySteps, emitRunScriptStep, emitTargetsStep } from './emit';

const base = { approval: 'default', onFailure: 'continue' };

describe('shared step emitters', () => {
  it('emitRunScriptStep pins the script step shape, key order included', () => {
    const s = emitRunScriptStep(2, 'command', { scriptId: 's', whenOffline: 'queue', deviceIds: ['d'] });
    expect(s).toEqual({ ...base, timeoutSec: 3600, id: 'a2_command', tool: 'run_script_on_targets', input: { scriptId: 's', whenOffline: 'queue', deviceIds: ['d'] } });
    expect(Object.keys(s)).toEqual(['approval', 'onFailure', 'timeoutSec', 'id', 'tool', 'input']);
    expect(emitRunScriptStep(0, 'run_script', {}).id).toBe('a0_run_script');
  });

  it('emitTargetsStep stops the flow on failure', () => {
    const s = emitTargetsStep({ target: { type: 'all' } });
    expect(s).toEqual({ ...base, onFailure: 'stop', timeoutSec: 300, id: 'targets', tool: 'resolve_targets', input: { target: { type: 'all' } } });
    expect(Object.keys(s)).toEqual(['approval', 'onFailure', 'timeoutSec', 'id', 'tool', 'input']);
  });

  it('emitDeviceItems adds a targets step, a devices step or nothing', () => {
    const sel = { deviceIds: ['d'] };
    const none = emitDeviceItems(1, null, sel, 'succeeded');
    expect(none.items).toBe('steps.targets.output.devices');
    expect(none.steps.map((s) => s.id)).toEqual(['targets']);
    expect(none.active).toEqual({ stepId: 'targets', kind: 'resolve' });

    const resolved = emitDeviceItems(2, none.active, sel, 'succeeded');
    expect(resolved).toEqual({ steps: [], items: 'steps.targets.output.devices', active: none.active });

    const fleet = { stepId: 'a0_run_script', kind: 'fleet' as const };
    const chained = emitDeviceItems(1, fleet, sel, 'dispatched');
    expect(chained.items).toBe('steps.a1_devices.output.devices');
    expect(chained.steps).toEqual([{ ...base, timeoutSec: 300, id: 'a1_devices', tool: 'resolve_targets', input: { fromStep: { stepId: 'a0_run_script', set: 'dispatched' } } }]);
    expect(chained.active).toBe(fleet);
  });

  it('emitCreateAlertStep pins the alert step', () => {
    const s = emitCreateAlertStep(3, 'steps.targets.output.devices', { severity: 'low', title: 't', message: 'm' });
    expect(s).toEqual({
      ...base, timeoutSec: 300, id: 'a3_alert', tool: 'create_alert',
      forEach: { items: 'steps.targets.output.devices', as: 'item', maxItems: 500, concurrency: 1 },
      input: { deviceId: '{{item.id}}', severity: 'low', title: 't', message: 'm' },
    });
    expect(Object.keys(s)).toEqual(['approval', 'onFailure', 'timeoutSec', 'id', 'tool', 'forEach', 'input']);
  });

  it('emitFailureNoticeSteps pins the failed step and one notice per channel', () => {
    const steps = emitFailureNoticeSteps(1, 'a1_run_script', 'Job', ['c0', 'c1']);
    const when = 'length(steps.a1_run_script.output.failedDeviceIds) > 0';
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ ...base, timeoutSec: 300, id: 'a1_failed', tool: 'resolve_targets', input: { fromStep: { stepId: 'a1_run_script', set: 'failed' } }, when });
    expect(Object.keys(steps[1]!)).toEqual(['approval', 'onFailure', 'timeoutSec', 'id', 'tool', 'when', 'forEach', 'input']);
    expect(steps[2]).toEqual({
      ...base, timeoutSec: 300, id: 'a1_failnotice_1', tool: 'notify', when,
      forEach: { items: 'steps.a1_failed.output.devices', as: 'item', maxItems: 500, concurrency: 1 },
      input: { channelId: 'c1', title: 'Job action failed', message: 'Automation Job action 2 failed on {{item.hostname}}: {{item.failureReason}}', severity: 'warning' },
    });
    expect(emitFailureNoticeSteps(0, 'x', 'Job', [])).toEqual([]);
  });

  it('emitFailureSummarySteps pins one summary notice per channel: no for-each, no failed resolve step', () => {
    const steps = emitFailureSummarySteps(1, 'a1_run_script', 'Job', ['c0', 'c1']);
    const when = 'length(steps.a1_run_script.output.failedDeviceIds) > 0';
    expect(steps.map((s) => s.id)).toEqual(['a1_failsummary_0', 'a1_failsummary_1']);
    expect(steps[1]).toEqual({
      ...base, timeoutSec: 300, id: 'a1_failsummary_1', tool: 'notify', when,
      input: {
        channelId: 'c1',
        title: 'Job action failed',
        message: 'Automation Job action 2 could not be sent to every device.'
          + '\n\nDevices: {{steps.a1_run_script.output.succeededCount}} succeeded, {{steps.a1_run_script.output.failedCount}} failed.',
        severity: 'warning',
      },
    });
    expect(Object.keys(steps[0]!)).toEqual(['approval', 'onFailure', 'timeoutSec', 'id', 'tool', 'when', 'input']);
    for (const s of steps) expect(s.forEach).toBeUndefined();
    expect(emitFailureSummarySteps(0, 'x', 'Job', [])).toEqual([]);
  });

  it('the summary uses the same counts suffix as the one-per-run notify action', () => {
    const [s] = emitFailureSummarySteps(0, 'a0_run_script', 'Job', ['c0']);
    expect(String(s!.input.message).endsWith(deviceCountsSuffix('a0_run_script'))).toBe(true);
  });
});
