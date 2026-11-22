import { compileFlowForm } from './compile';
import { decodeFlowForm } from './decode';
import { normalizeFlowDocument, structurallyEqual } from './equality';
import type { FlowFormValues } from './types';

export type FlowFormRecognition =
  | { formShaped: true; values: FlowFormValues }
  | { formShaped: false; reason: 'invalid_document' | 'not_decodable' | 'differs_after_recompile' };

/**
 * Decides whether a stored document may be edited in the guided form. It is
 * form-shaped only when decoding it and compiling the values again gives the
 * same document (both normalized with the schema, so omitted defaults do not
 * matter and key order does not matter). Anything the form cannot rebuild
 * exactly (a custom timeout, `limits`, `notices`, a hand-written `when`, a
 * per-device converted notice, an `ai` or `http_request` step) therefore opens
 * read-only, with the Document tab as the edit surface: saving from the form
 * can never drop a field.
 */
export function recognizeFlowForm(doc: unknown): FlowFormRecognition {
  const normalized = normalizeFlowDocument(doc);
  if (!normalized) return { formShaped: false, reason: 'invalid_document' };
  const values = decodeFlowForm(normalized);
  if (!values) return { formShaped: false, reason: 'not_decodable' };
  let recompiled: ReturnType<typeof normalizeFlowDocument>;
  try {
    recompiled = normalizeFlowDocument(compileFlowForm(values));
  } catch {
    return { formShaped: false, reason: 'differs_after_recompile' };
  }
  if (!recompiled || !structurallyEqual(normalized, recompiled)) {
    return { formShaped: false, reason: 'differs_after_recompile' };
  }
  return { formShaped: true, values };
}

export { normalizeFlowDocument } from './equality';
