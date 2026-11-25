import { describe, expect, it } from 'vitest';
import { flowDocumentV1Schema } from '../../validators/flows';
import { checkFlowStructure } from '../structure';
import { compileFlowForm } from './compile';
import { CHANNEL, CHANNEL_2, FORM_CASES, GROUP, SCRIPT } from './testCases';
import type { FlowFormValues } from './types';

const byLabel = (label: string): FlowFormValues => FORM_CASES.find(([l]) => l === label)![1];
const ids = (v: FlowFormValues) => compileFlowForm(v).steps.map((s) => s.id);

describe('compileFlowForm', () => {
  it('scheduled script on a group compiles to one run_script_on_targets step with timeoutSec 3600', () => {
    const doc = compileFlowForm(byLabel('scheduled script on a group'));
    expect(doc.trigger).toEqual({ type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' });
    expect(doc.inputs).toEqual([]);
    expect(doc.limits).toBeUndefined();
    expect(doc.notices).toBeUndefined();
    expect(doc.steps).toEqual([{
      approval: 'default', onFailure: 'continue', timeoutSec: 3600,
      id: 'a0_run_script', tool: 'run_script_on_targets',
      input: { scriptId: SCRIPT, whenOffline: 'queue', target: { type: 'groups', groupIds: [GROUP] } },
    }]);
  });

  it('event trigger binds the triggering device', () => {
    const doc = compileFlowForm(byLabel('event on the triggering device'));
    expect(doc.steps[0]!.input).toEqual({ scriptId: SCRIPT, whenOffline: 'queue', deviceIds: ['{{trigger.device.id}}'] });
  });

  it('notify after a script is one message with the counts suffix', () => {
    const doc = compileFlowForm(byLabel('manual script then notify (counts suffix)'));
    expect(doc.steps.map((s) => s.id)).toEqual(['a0_run_script', 'a1_notify']);
    const notice = doc.steps[1]!;
    expect(notice.forEach).toBeUndefined();
    expect(notice.input).toEqual({
      channelId: CHANNEL, title: 'Done', severity: 'info',
      message: 'Cleanup finished\n\nDevices: {{steps.a0_run_script.output.succeededCount}} succeeded, {{steps.a0_run_script.output.failedCount}} failed.',
    });
  });

  it('notify first emits no targets step', () => {
    expect(ids(byLabel('schedule with a notify-only action list'))).toEqual(['a0_notify']);
    const doc = compileFlowForm(byLabel('notify first then script'));
    expect(doc.steps.map((s) => s.id)).toEqual(['a0_notify', 'a1_run_script']);
    expect(doc.steps[0]!.input.message).toBe('Cleanup finished'); // no script before it: no suffix
    expect(doc.steps[1]!.input).toHaveProperty('target'); // the script takes the selector itself
  });

  it('alert after a script under continue chains on dispatched', () => {
    const doc = compileFlowForm(byLabel('script then alert under continue'));
    expect(doc.steps.map((s) => s.id)).toEqual(['a0_run_script', 'a1_devices', 'a1_alert']);
    expect(doc.steps[1]!.input).toEqual({ fromStep: { stepId: 'a0_run_script', set: 'dispatched' } });
    expect(doc.steps[2]!.forEach).toEqual({ items: 'steps.a1_devices.output.devices', as: 'item', maxItems: 500, concurrency: 1 });
    expect(doc.steps[2]!.input).toEqual({ deviceId: '{{item.id}}', severity: 'high', title: 'Disk low', message: 'Disk low on {{item.name}}' });
  });

  it('a second script chains on dispatched under continue and on succeeded under stop', () => {
    const cont = compileFlowForm(byLabel('script then script under continue'));
    expect(cont.steps[1]!.input.fromStep).toEqual({ stepId: 'a0_run_script', set: 'dispatched' });
    const stop = compileFlowForm({ ...byLabel('script then script under continue'), onFailure: { mode: 'stop' } });
    expect(stop.steps[1]!.input.fromStep).toEqual({ stepId: 'a0_run_script', set: 'succeeded' });
  });

  it('alert first adds one targets step, shared by a later alert', () => {
    expect(ids(byLabel('alert first then script'))).toEqual(['targets', 'a0_alert', 'a1_run_script']);
    const doc = compileFlowForm(byLabel('alert first then script'));
    expect(doc.steps[0]!).toMatchObject({ id: 'targets', onFailure: 'stop', input: { target: { type: 'groups', groupIds: [GROUP] } } });
    expect(ids(byLabel('alert then notify then alert (shared targets step)'))).toEqual(['targets', 'a0_alert', 'a1_notify', 'a2_alert']);
  });

  it('onFailure notify emits a failed step and one notice per channel', () => {
    const doc = compileFlowForm(byLabel('onFailure notify with two channels over two scripts'));
    expect(doc.steps.map((s) => s.id)).toEqual([
      'a0_run_script', 'a0_failed', 'a0_failnotice_0', 'a0_failnotice_1',
      'a1_run_script', 'a1_failed', 'a1_failnotice_0', 'a1_failnotice_1', 'a2_notify',
    ]);
    const when = 'length(steps.a0_run_script.output.failedDeviceIds) > 0';
    expect(doc.steps[1]).toMatchObject({ tool: 'resolve_targets', when, input: { fromStep: { stepId: 'a0_run_script', set: 'failed' } } });
    expect(doc.steps[3]).toMatchObject({
      tool: 'notify', when,
      forEach: { items: 'steps.a0_failed.output.devices', as: 'item', maxItems: 500, concurrency: 1 },
      input: {
        channelId: CHANNEL_2, title: 'Failure notices action failed', severity: 'warning',
        message: 'Automation Failure notices action 1 failed on {{item.hostname}}: {{item.failureReason}}',
      },
    });
    // The second script chains on the first's succeeded set.
    expect(doc.steps[4]!.input.fromStep).toEqual({ stepId: 'a0_run_script', set: 'succeeded' });
    // The notice after the last script reports that script's counts.
    expect(String(doc.steps[8]!.input.message)).toContain('steps.a1_run_script.output.succeededCount');
  });

  it('onFailure notify as a summary emits one notice per channel per script, with no for-each and no failed step', () => {
    const doc = compileFlowForm(byLabel('onFailure summary with two channels over two scripts'));
    expect(doc.steps.map((s) => s.id)).toEqual([
      'a0_run_script', 'a0_failsummary_0', 'a0_failsummary_1',
      'a1_run_script', 'a1_failsummary_0', 'a1_failsummary_1', 'a2_notify',
    ]);
    const when = 'length(steps.a1_run_script.output.failedDeviceIds) > 0';
    expect(doc.steps[5]).toEqual({
      approval: 'default', onFailure: 'continue', timeoutSec: 300,
      id: 'a1_failsummary_1', tool: 'notify', when,
      input: {
        channelId: CHANNEL_2, title: 'Failure summary action failed', severity: 'warning',
        message: 'Automation Failure summary action 2 could not be sent to every device.'
          + '\n\nDevices: {{steps.a1_run_script.output.succeededCount}} succeeded, {{steps.a1_run_script.output.failedCount}} failed.',
      },
    });
    for (const s of doc.steps) expect(s.forEach).toBeUndefined();
    expect(doc.steps.some((s) => s.tool === 'resolve_targets')).toBe(false);
    // The second script still chains on the first's succeeded set.
    expect(doc.steps[3]!.input.fromStep).toEqual({ stepId: 'a0_run_script', set: 'succeeded' });
  });

  it('the notice shape is the only difference between per-device and summary', () => {
    const summary = byLabel('onFailure summary with two channels over two scripts');
    const perDevice = { ...summary, onFailure: { ...summary.onFailure, notice: 'perDevice' } } as FlowFormValues;
    expect(ids(perDevice)).toEqual([
      'a0_run_script', 'a0_failed', 'a0_failnotice_0', 'a0_failnotice_1',
      'a1_run_script', 'a1_failed', 'a1_failnotice_0', 'a1_failnotice_1', 'a2_notify',
    ]);
  });

  it('description is omitted when empty or whitespace', () => {
    const base = byLabel('scheduled script on a group');
    expect('description' in compileFlowForm({ ...base, description: '   ' })).toBe(false);
    expect('description' in compileFlowForm({ ...base, description: '' })).toBe(false);
    expect(compileFlowForm({ ...base, description: 'Nightly' }).description).toBe('Nightly');
  });

  it('carries a webhook orgResolver as given', () => {
    const doc = compileFlowForm(byLabel('webhook with a resolver (partner-wide)'));
    expect(doc.trigger).toEqual({ type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer.id', system: 'psa' } });
  });

  for (const [label, values] of FORM_CASES) {
    it(`compiled documents pass flowDocumentV1Schema and checkFlowStructure — ${label}`, () => {
      const doc = compileFlowForm(values);
      expect(flowDocumentV1Schema.safeParse(doc).success).toBe(true);
      expect(checkFlowStructure(flowDocumentV1Schema.parse(doc)).filter((i) => i.severity === 'error')).toEqual([]);
    });
  }

  it('compile is deterministic', () => {
    for (const [, values] of FORM_CASES) {
      expect(JSON.stringify(compileFlowForm(values))).toBe(JSON.stringify(compileFlowForm(structuredClone(values))));
    }
  });
});
