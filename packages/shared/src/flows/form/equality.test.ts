import { describe, expect, it } from 'vitest';
import { compileFlowForm } from './compile';
import { normalizeFlowDocument, sameFlowDocument, structurallyEqual } from './equality';
import { FORM_CASES } from './testCases';

describe('structurallyEqual', () => {
  it('structurallyEqual ignores key order and respects array order', () => {
    expect(structurallyEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    expect(structurallyEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(structurallyEqual([1], [1, 2])).toBe(false);
    expect(structurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });
  it('treats primitives strictly and an undefined key as absent', () => {
    expect(structurallyEqual(1, '1')).toBe(false);
    expect(structurallyEqual(null, undefined)).toBe(false);
    expect(structurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(structurallyEqual({ a: {} }, { a: [] })).toBe(false);
  });
});

describe('sameFlowDocument', () => {
  const doc = compileFlowForm(FORM_CASES[0]![1]);
  it('sameFlowDocument treats a missing defaulted step field as equal to its default', () => {
    const trimmed = structuredClone(doc) as { steps: Array<Record<string, unknown>> };
    delete trimmed.steps[0]!.approval;
    expect(sameFlowDocument(doc, trimmed)).toBe(true);
    // The schema default for onFailure is stop, not the converter's continue: dropping it changes the document.
    const changed = structuredClone(doc) as { steps: Array<Record<string, unknown>> };
    delete changed.steps[0]!.onFailure;
    expect(sameFlowDocument(doc, changed)).toBe(false);
  });
  it('sameFlowDocument is false for an invalid document', () => {
    expect(sameFlowDocument(doc, { nope: true })).toBe(false);
    expect(sameFlowDocument({ nope: true }, { nope: true })).toBe(false);
    expect(normalizeFlowDocument('x')).toBeNull();
  });
});
