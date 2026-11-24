/**
 * Pure state for the manual flow editor (flows completion W01e, #12438).
 *
 * The document JSON text is what gets saved, from either tab. The form holds
 * its own values while it is the active surface, and the text is compiled
 * from them on every change. A Document-tab edit leaves the form values alone
 * until the person switches back; then the form is re-derived from the text
 * with `recognizeFlowForm`, and is locked (read-only) when the text is not a
 * document the form can rebuild exactly. Saving from the form can therefore
 * never drop a field that only the Document tab can express.
 */
import {
  compileFlowForm,
  recognizeFlowForm,
  type FlowFormRecognition,
  type FlowFormValues,
  type FlowStatus,
} from '@breeze/shared';

export type EditorTab = 'form' | 'document';
export const EDITOR_TABS: readonly EditorTab[] = ['form', 'document'];

export type FormLockReason = Extract<FlowFormRecognition, { formShaped: false }>['reason'];

export interface EditorState {
  /** The document as JSON text: what Save sends, after a parse. */
  text: string;
  /** Editable form values, or null when the form is locked. */
  formValues: FlowFormValues | null;
  formLocked: FormLockReason | null;
  /** The text the form last produced; a different `text` means the Document tab edited it. */
  formText: string | null;
}

/** The API's editable statuses (`EDITABLE_STATUSES` in services/flows/service.ts). */
export function isEditableStatus(status: FlowStatus): boolean {
  return status === 'draft' || status === 'disabled' || status === 'paused';
}

export function documentToText(doc: unknown): string {
  return JSON.stringify(doc, null, 2);
}

export type ParsedText = { ok: true; value: unknown } | { ok: false; error: string };

/** JSON.parse with the engine's message on failure (empty text fails too). */
export function parseDocumentText(text: string): ParsedText {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error && err.message ? err.message : String(err) };
  }
}

/** What a new flow starts as: a nightly script on all devices, stop on failure. */
export function newFlowValues(timezone: string): FlowFormValues {
  return {
    name: '',
    trigger: { type: 'schedule', cron: '0 2 * * *', timezone },
    target: { kind: 'target', target: { type: 'all' } },
    actions: [{ type: 'run_script', scriptId: '', whenOffline: 'queue' }],
    onFailure: { mode: 'stop' },
  };
}

export function editorFromValues(values: FlowFormValues): EditorState {
  const text = documentToText(compileFlowForm(values));
  return { text, formValues: values, formLocked: null, formText: text };
}

export function editorFromDocument(doc: unknown): EditorState {
  const text = documentToText(doc);
  const recognized = recognizeFlowForm(doc);
  return recognized.formShaped
    ? { text, formValues: recognized.values, formLocked: null, formText: text }
    : { text, formValues: null, formLocked: recognized.reason, formText: null };
}

export function withFormValues(state: EditorState, values: FlowFormValues): EditorState {
  const text = documentToText(compileFlowForm(values));
  return { ...state, text, formValues: values, formLocked: null, formText: text };
}

export function withText(state: EditorState, text: string): EditorState {
  return { ...state, text };
}

/** Called when the Form tab becomes active: re-derive it if the Document tab changed the text. */
export function withTabSwitch(state: EditorState): EditorState {
  if (state.formText !== null && state.text === state.formText) return state;
  const parsed = parseDocumentText(state.text);
  if (!parsed.ok) return { ...state, formValues: null, formLocked: 'invalid_document', formText: null };
  const recognized = recognizeFlowForm(parsed.value);
  return recognized.formShaped
    ? { ...state, formValues: recognized.values, formLocked: null, formText: state.text }
    : { ...state, formValues: null, formLocked: recognized.reason, formText: null };
}
