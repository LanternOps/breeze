import type { FlowDocumentV1 } from '../validators/flows';
import type { FlowValue } from './expr';

export type CoerceFlowInputsResult =
  | { ok: true; inputs: Record<string, FlowValue> }
  | { ok: false; issues: Array<{ name: string; message: string }> };

const MAX_STRING_LENGTH = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Coerce manual-run inputs against a flow's declared inputs. Absent or null
 * optional inputs become `null` (spec §6.2); undeclared keys and missing
 * required inputs are issues. Collects every issue rather than stopping early.
 */
export function coerceFlowInputs(
  decls: FlowDocumentV1['inputs'],
  raw: Record<string, unknown>,
): CoerceFlowInputsResult {
  const issues: Array<{ name: string; message: string }> = [];
  const inputs: Record<string, FlowValue> = {};
  const declared = new Set(decls.map((d) => d.name));

  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) issues.push({ name: key, message: 'Unknown input' });
  }

  for (const decl of decls) {
    const v = raw[decl.name];
    if (v === undefined || v === null) {
      if (decl.required) issues.push({ name: decl.name, message: 'Required input is missing' });
      else inputs[decl.name] = null;
      continue;
    }
    switch (decl.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (Number.isFinite(n)) inputs[decl.name] = n;
        else issues.push({ name: decl.name, message: 'Expected a finite number' });
        break;
      }
      case 'boolean': {
        if (typeof v === 'boolean') inputs[decl.name] = v;
        else if (v === 'true') inputs[decl.name] = true;
        else if (v === 'false') inputs[decl.name] = false;
        else issues.push({ name: decl.name, message: 'Expected a boolean' });
        break;
      }
      case 'uuid': {
        const u = typeof v === 'string' ? v.toLowerCase() : '';
        if (UUID_RE.test(u)) inputs[decl.name] = u;
        else issues.push({ name: decl.name, message: 'Expected a UUID' });
        break;
      }
      case 'string': {
        if (typeof v !== 'string') issues.push({ name: decl.name, message: 'Expected a string' });
        else if (v.length > MAX_STRING_LENGTH) {
          issues.push({ name: decl.name, message: `String exceeds ${MAX_STRING_LENGTH} characters` });
        } else inputs[decl.name] = v;
        break;
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, inputs };
}
