import { describe, expect, it } from 'vitest';
import { compileFlowForm, sameFlowDocument, type FlowFormValues } from '@breeze/shared';
import {
  documentToText,
  editorFromDocument,
  editorFromValues,
  isEditableStatus,
  newFlowValues,
  parseDocumentText,
  withFormValues,
  withTabSwitch,
  withText,
} from './editorState';

const SCRIPT = '33333333-3333-4333-8333-333333333333';
const formValues: FlowFormValues = {
  name: 'Nightly cleanup',
  trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
  target: { kind: 'target', target: { type: 'all' } },
  actions: [{ type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' }],
  onFailure: { mode: 'stop' },
};

describe('editorState', () => {
  it('a form-built document opens with editable form values', () => {
    const s = editorFromDocument(compileFlowForm(formValues));
    expect(s.formValues).toEqual(formValues);
    expect(s.formLocked).toBeNull();
    expect(JSON.parse(s.text)).toEqual(compileFlowForm(formValues));
  });

  it('a document with limits opens with the form locked', () => {
    const doc = { ...compileFlowForm(formValues), limits: { monthlyRuns: 5 } };
    const s = editorFromDocument(doc);
    expect(s.formValues).toBeNull();
    expect(s.formLocked).toBe('differs_after_recompile');
    // The text keeps every field: nothing is dropped.
    expect(JSON.parse(s.text).limits).toEqual({ monthlyRuns: 5 });
  });

  it('a form change recompiles the document text', () => {
    const s = withFormValues(editorFromValues(formValues), { ...formValues, name: 'Renamed' });
    expect(JSON.parse(s.text).name).toBe('Renamed');
    expect(s.formValues?.name).toBe('Renamed');
  });

  it('an in-progress form value that makes the document invalid keeps the form editable', () => {
    const s = withTabSwitch(withFormValues(editorFromValues(formValues), { ...formValues, name: '' }));
    expect(s.formValues?.name).toBe('');
    expect(s.formLocked).toBeNull();
  });

  it('a Document-tab edit that makes the document non-form locks the form on the next switch, and keeps the text', () => {
    const start = editorFromValues(formValues);
    const doc = JSON.parse(start.text);
    doc.steps[0].timeoutSec = 600;
    const edited = withText(start, documentToText(doc));
    const back = withTabSwitch(edited);
    expect(back.formValues).toBeNull();
    expect(back.formLocked).toBe('differs_after_recompile');
    expect(JSON.parse(back.text).steps[0].timeoutSec).toBe(600);
  });

  it('a Document-tab edit that stays form-shaped re-derives the form values', () => {
    const start = editorFromValues(formValues);
    const doc = JSON.parse(start.text);
    doc.name = 'Edited in JSON';
    const back = withTabSwitch(withText(start, documentToText(doc)));
    expect(back.formValues?.name).toBe('Edited in JSON');
  });

  it('a parse error locks the form as invalid_document', () => {
    const back = withTabSwitch(withText(editorFromValues(formValues), '{ nope'));
    expect(back.formValues).toBeNull();
    expect(back.formLocked).toBe('invalid_document');
  });

  it('a single script under continue reopens as stop, and that is not an unsaved change', () => {
    const asContinue = compileFlowForm({ ...formValues, onFailure: { mode: 'continue' } });
    const reopened = editorFromDocument(asContinue);
    expect(reopened.formValues?.onFailure).toEqual({ mode: 'stop' });
    expect(sameFlowDocument(JSON.parse(reopened.text), asContinue)).toBe(true);
    // The form's own recompile of the reopened values is the same document too.
    expect(sameFlowDocument(compileFlowForm(reopened.formValues as FlowFormValues), asContinue)).toBe(true);
  });

  it('parseDocumentText reports an error for empty or malformed text', () => {
    expect(parseDocumentText('').ok).toBe(false);
    expect(parseDocumentText('{').ok).toBe(false);
    expect(parseDocumentText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('draft, disabled and paused are editable; enabled is not', () => {
    expect(isEditableStatus('draft')).toBe(true);
    expect(isEditableStatus('disabled')).toBe(true);
    expect(isEditableStatus('paused')).toBe(true);
    expect(isEditableStatus('enabled')).toBe(false);
  });

  it('a new flow starts as a scheduled script on all devices with an empty name', () => {
    const v = newFlowValues('Europe/Berlin');
    expect(v.name).toBe('');
    expect(v.trigger).toEqual({ type: 'schedule', cron: '0 2 * * *', timezone: 'Europe/Berlin' });
    expect(v.target).toEqual({ kind: 'target', target: { type: 'all' } });
    expect(v.actions).toEqual([{ type: 'run_script', scriptId: '', whenOffline: 'queue' }]);
    expect(v.onFailure).toEqual({ mode: 'stop' });
  });
});
