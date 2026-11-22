import { describe, expect, it } from 'vitest';
import type { FlowDocumentV1 } from '../../validators/flows';
import { compileFlowForm } from './compile';
import { decodeFlowForm } from './decode';
import { normalizeFlowDocument } from './equality';
import { recognizeFlowForm } from './recognize';
import { CHANNEL, FORM_CASES } from './testCases';

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
