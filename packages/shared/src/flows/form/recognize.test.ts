import { describe, expect, it } from 'vitest';
import type { FlowDocumentV1 } from '../../validators/flows';
import { compileFlowForm } from './compile';
import { decodeFlowForm } from './decode';
import { normalizeFlowDocument } from './equality';
import { recognizeFlowForm } from './recognize';
import { CHANNEL, CHANNEL_2, FORM_CASES } from './testCases';

const doc = (label: string): FlowDocumentV1 => compileFlowForm(FORM_CASES.find(([l]) => l === label)![1]);
const clone = <T,>(v: T): T => structuredClone(v);
const notFormShaped = (d: unknown, reason?: string) => {
  const r = recognizeFlowForm(d);
  expect(r.formShaped).toBe(false);
  if (reason && !r.formShaped) expect(r.reason).toBe(reason);
};
const step = (id: string, tool: string, input: Record<string, unknown>) =>
  ({ approval: 'default', onFailure: 'continue', timeoutSec: 300, id, tool, input }) as FlowDocumentV1['steps'][number];

describe('recognizeFlowForm', () => {
  it('every form-built document is recognized and round-trips its values', () => {
    for (const [label, values] of FORM_CASES) {
      const r = recognizeFlowForm(compileFlowForm(values));
      expect(r.formShaped, label).toBe(true);
      if (r.formShaped) expect(r.values, label).toEqual(values);
    }
  });

  it('a stored document missing defaulted step fields is still recognized', () => {
    const d = clone(doc('scheduled script on a group')) as { steps: Array<Record<string, unknown>> };
    for (const s of d.steps) delete s.approval;
    expect(recognizeFlowForm(d).formShaped).toBe(true);
  });

  it('custom timeoutSec is not form-shaped', () => {
    const d = clone(doc('scheduled script on a group'));
    d.steps[0]!.timeoutSec = 600;
    notFormShaped(d, 'differs_after_recompile');
  });

  it('limits or notices are not form-shaped', () => {
    const withLimits = { ...clone(doc('scheduled script on a group')), limits: { monthlyRuns: 10 } };
    notFormShaped(withLimits, 'differs_after_recompile');
    const withNotices = { ...clone(doc('scheduled script on a group')), notices: { channelId: CHANNEL } };
    notFormShaped(withNotices, 'differs_after_recompile');
    // decode alone ignores them; the recompile comparison is what catches the loss.
    expect(decodeFlowForm(normalizeFlowDocument(withLimits)!)).not.toBeNull();
  });

  it('a when expression the form did not emit is not form-shaped', () => {
    const d = clone(doc('scheduled script on a group'));
    d.steps[0]!.when = 'trigger.hour > 3';
    notFormShaped(d, 'differs_after_recompile');
    const failureDoc = clone(doc('onFailure notify with two channels over two scripts'));
    failureDoc.steps[1]!.when = 'true';
    notFormShaped(failureDoc, 'differs_after_recompile');
  });

  it('converted per-device notice is not form-shaped', () => {
    const d = clone(doc('script then alert under continue'));
    d.steps.push({
      ...step('a2_notify', 'notify', { channelId: CHANNEL, title: 'x', message: 'Automation x executed on {{item.hostname}}', severity: 'info' }),
      forEach: { items: 'steps.a1_devices.output.devices', as: 'item', maxItems: 500, concurrency: 1 },
    });
    notFormShaped(d, 'not_decodable');
  });

  it('a per-device on-failure notice reopens as perDevice and a summary as summary', () => {
    const perDevice = recognizeFlowForm(doc('onFailure notify with two channels over two scripts'));
    expect(perDevice.formShaped && perDevice.values.onFailure).toEqual({ mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'perDevice' });
    const summary = recognizeFlowForm(doc('onFailure summary with two channels over two scripts'));
    expect(summary.formShaped && summary.values.onFailure).toEqual({ mode: 'notify', channelIds: [CHANNEL, CHANNEL_2], notice: 'summary' });
  });

  it('a document mixing the per-device and summary notice for one action is not form-shaped', () => {
    const d = clone(doc('onFailure notify with two channels over two scripts'));
    // a0: failed + failnotice_0 + failnotice_1; swap the second notice for a summary.
    const summaryStep = doc('onFailure summary with two channels over two scripts').steps.find((s) => s.id === 'a0_failsummary_1')!;
    d.steps.splice(3, 1, clone(summaryStep));
    expect(d.steps.map((s) => s.id).slice(0, 4)).toEqual(['a0_run_script', 'a0_failed', 'a0_failnotice_0', 'a0_failsummary_1']);
    notFormShaped(d, 'not_decodable');
  });

  it('a document with a per-device notice on one script and a summary on another is not form-shaped', () => {
    const perDevice = doc('onFailure notify with two channels over two scripts');
    const summary = doc('onFailure summary with two channels over two scripts');
    const mixed = clone(summary);
    const a0Block = perDevice.steps.filter((s) => s.id.startsWith('a0_'));
    mixed.steps = [...clone(a0Block), ...clone(summary.steps.filter((s) => !s.id.startsWith('a0_')))];
    expect(mixed.steps.map((s) => s.id)).toEqual([
      'a0_run_script', 'a0_failed', 'a0_failnotice_0', 'a0_failnotice_1',
      'a1_run_script', 'a1_failsummary_0', 'a1_failsummary_1', 'a2_notify',
    ]);
    notFormShaped(mixed, 'not_decodable');
  });

  it('a summary notice carrying a for-each or a different when is not form-shaped', () => {
    const withForEach = clone(doc('onFailure summary with two channels over two scripts'));
    withForEach.steps[1]!.forEach = { items: 'steps.targets.output.devices', as: 'item', maxItems: 500, concurrency: 1 };
    notFormShaped(withForEach, 'differs_after_recompile');
    const otherWhen = clone(doc('onFailure summary with two channels over two scripts'));
    otherWhen.steps[1]!.when = 'steps.a0_run_script.output.failedCount > 0';
    notFormShaped(otherWhen, 'differs_after_recompile');
  });

  it('a summary notice that is not a notify step is not form-shaped', () => {
    const d = clone(doc('onFailure summary with two channels over two scripts'));
    d.steps[1]!.tool = 'create_alert';
    notFormShaped(d, 'not_decodable');
  });

  it('legacy conditions arrays are not form-shaped', () => {
    const d = clone(doc('scheduled script on a group'));
    d.steps[0]!.input = { scriptId: d.steps[0]!.input.scriptId, whenOffline: 'queue', conditions: [{ type: 'tag', operator: 'is', value: 'prod' }] };
    notFormShaped(d, 'not_decodable');
  });

  it('an ai, http_request, wait or set step is not form-shaped', () => {
    for (const [tool, input] of [
      ['ai', { prompt: 'p', output: {} }],
      ['http_request', { method: 'GET', url: 'https://example.com/x' }],
      ['wait', { minutes: 5 }],
      ['set', { values: { a: 1 } }],
    ] as const) {
      const named = clone(doc('scheduled script on a group'));
      named.steps.push(step('extra', tool, { ...input }));
      notFormShaped(named, 'not_decodable');
      // Even under a form-looking id the tool is wrong.
      const disguised = clone(doc('scheduled script on a group'));
      disguised.steps.push(step('a1_notify', tool, { ...input }));
      notFormShaped(disguised);
    }
  });

  it('a hand-edited counts suffix is not form-shaped', () => {
    const d = clone(doc('manual script then notify (counts suffix)'));
    d.steps[1]!.input.message = 'Done. {{steps.a0_run_script.output.succeededCount}} ok';
    notFormShaped(d, 'differs_after_recompile');
  });

  it('a pre-approved step is not form-shaped', () => {
    const d = clone(doc('scheduled script on a group'));
    d.steps[0]!.approval = 'pre_approved';
    notFormShaped(d, 'differs_after_recompile');
  });

  it('declared inputs are not form-shaped', () => {
    const d = { ...clone(doc('scheduled script on a group')), inputs: [{ name: 'x', type: 'string' as const, required: false }] };
    notFormShaped(d, 'differs_after_recompile');
  });

  it('a target the picker cannot show is not form-shaped', () => {
    const d = clone(doc('scheduled script on a group'));
    d.steps[0]!.input = { scriptId: d.steps[0]!.input.scriptId, whenOffline: 'queue', target: { type: 'nonsense', siteIds: ['x'] } };
    notFormShaped(d, 'not_decodable');
    const stray = clone(doc('scheduled script on a group'));
    (stray.steps[0]!.input.target as Record<string, unknown>).siteIds = ['x'];
    notFormShaped(stray); // an unknown key would be dropped on save
  });

  it('the triggering device is only a form target for an event trigger', () => {
    const d = clone(doc('event on the triggering device'));
    d.trigger = { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' };
    notFormShaped(d, 'not_decodable');
  });

  it('different form values that compile to one document reopen as the document says', () => {
    // continue and stop differ only when a later step chains; a lone script is the same document either way.
    const lone = FORM_CASES.find(([l]) => l === 'scheduled script on a group')![1];
    const asContinue = { ...lone, onFailure: { mode: 'continue' as const } };
    expect(compileFlowForm(asContinue)).toEqual(compileFlowForm(lone));
    const r = recognizeFlowForm(compileFlowForm(asContinue));
    expect(r.formShaped && r.values.onFailure).toEqual({ mode: 'stop' });
    // A notify-only list names no selector, so the target is the trigger's default (the editor must make the person choose on adding a device action).
    const noticeOnly = { ...lone, actions: [FORM_CASES.find(([l]) => l === 'schedule with a notify-only action list')![1].actions[0]!] };
    const r2 = recognizeFlowForm(compileFlowForm(noticeOnly));
    expect(r2.formShaped && r2.values.target).toEqual({ kind: 'target', target: { type: 'all' } });
  });

  it('an invalid document is invalid_document', () => {
    notFormShaped(null, 'invalid_document');
    notFormShaped({ version: 1, name: 'x' }, 'invalid_document');
    notFormShaped({ ...doc('scheduled script on a group'), steps: [] }, 'invalid_document');
  });

  it('key order does not matter', () => {
    const d = doc('script then alert under continue');
    const reordered = JSON.parse(JSON.stringify(d), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).reverse()) : v));
    expect(recognizeFlowForm(reordered).formShaped).toBe(true);
  });
});
