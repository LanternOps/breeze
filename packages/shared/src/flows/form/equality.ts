import { flowDocumentV1Schema, type FlowDocumentV1 } from '../../validators/flows';

/**
 * A stored document that fails the schema is not a document; the form and the
 * recognizer treat it as absent. `safeParse` also fills step defaults
 * (`approval`, `onFailure`, `timeoutSec`, `forEach.as`, ...), so two documents
 * that differ only in omitted defaults normalize to the same value.
 */
export function normalizeFlowDocument(doc: unknown): FlowDocumentV1 | null {
  const parsed = flowDocumentV1Schema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Deep equality for JSON values: plain objects compare key-order-insensitively
 * (a key whose value is `undefined` counts as absent), arrays compare in order,
 * primitives with `===`. Browser safe by construction: it does not use the
 * shared canonicalizer, which pulls in `node:crypto`.
 */
export function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => structurallyEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((k) => Object.hasOwn(b, k) && structurallyEqual(a[k], b[k]));
  }
  return false;
}

/** Both sides normalized with the document schema, then structurally compared. False when either is not a valid document. */
export function sameFlowDocument(a: unknown, b: unknown): boolean {
  const na = normalizeFlowDocument(a);
  const nb = normalizeFlowDocument(b);
  return na !== null && nb !== null && structurallyEqual(na, nb);
}
