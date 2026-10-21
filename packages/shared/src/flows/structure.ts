import { FLOW_LIMITS, type FlowDocumentV1, type FlowIssue } from '../validators/flows';
import { parseExpr, type FlowPath } from './expr';
import { extractTemplates } from './templates';

/**
 * Rule 3 (spec §6.3) plus whole-document bounds. Pure and browser safe: byte length is
 * measured with TextEncoder, and nothing here recurses over user-controlled nesting.
 */

/** Scalars are depth 0; a container is 1 + its deepest child. Iterative. */
function nestingDepth(root: unknown): number {
  let max = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: root, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    const nd = d + 1;
    if (nd > max) max = nd;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push({ v: child, d: nd });
  }
  return max;
}

const err = (code: FlowIssue['code'], message: string, stepId?: string, pointer?: string): FlowIssue => ({
  code,
  severity: 'error',
  message,
  ...(stepId !== undefined ? { stepId } : {}),
  ...(pointer !== undefined ? { pointer } : {}),
});

export function checkFlowStructure(doc: FlowDocumentV1): FlowIssue[] {
  const steps = Array.isArray(doc.steps) ? doc.steps : [];

  // Whole-document bounds first; when one trips, nothing else is checked.
  const bytes = new TextEncoder().encode(JSON.stringify(doc) ?? '').length;
  if (bytes > FLOW_LIMITS.maxDocumentBytes) {
    return [err('document_too_large', `Flow document is ${bytes} bytes; the limit is ${FLOW_LIMITS.maxDocumentBytes}.`)];
  }
  const bounds: FlowIssue[] = [];
  let templateCount = 0;
  steps.forEach((s, i) => {
    if (nestingDepth(s.input) > FLOW_LIMITS.maxInputDepth) {
      bounds.push(err('input_too_deep', `Step input is nested deeper than ${FLOW_LIMITS.maxInputDepth} levels.`, s.id, `/steps/${i}/input`));
    }
    const { refs, errors } = extractTemplates(s.input);
    templateCount += refs.length + errors.length;
  });
  if (templateCount > FLOW_LIMITS.maxTemplates) {
    bounds.push(err('too_many_templates', `Flow has ${templateCount} templates; the limit is ${FLOW_LIMITS.maxTemplates}.`));
  }
  if (bounds.length > 0) return bounds;

  const issues: FlowIssue[] = [];
  const firstIndex = new Map<string, number>();
  steps.forEach((s, i) => {
    if (firstIndex.has(s.id)) {
      issues.push(err('duplicate_step_id', `Step id '${s.id}' is used more than once.`, s.id, `/steps/${i}/id`));
    } else {
      firstIndex.set(s.id, i);
    }
  });
  const declared = new Set((doc.inputs ?? []).map((i) => i.name));

  const checkPath = (path: FlowPath, i: number, stepId: string, pointer: string, inItems = false): void => {
    // `forEach.items` is evaluated before iteration starts, so `item` is not
    // bound there even on a forEach step.
    const hasForEach = steps[i]!.forEach !== undefined && !inItems;
    if (path.root === 'item') {
      if (!hasForEach) issues.push(err('item_outside_foreach', "'item' can only be used in a step with forEach.", stepId, pointer));
      return;
    }
    if (path.root === 'inputs') {
      const name = path.segments[0];
      if (typeof name === 'string' && !declared.has(name)) {
        issues.push(err('undeclared_input', `Input '${name}' is not declared in inputs.`, stepId, pointer));
      }
      return;
    }
    if (path.root === 'steps') {
      const ref = path.segments[0];
      if (typeof ref !== 'string') {
        issues.push(err('unknown_root', "'steps' must be followed by a step id.", stepId, pointer));
        return;
      }
      const idx = firstIndex.get(ref);
      if (idx === undefined) {
        issues.push(err('unknown_step_reference', `Step '${ref}' does not exist.`, stepId, pointer));
        return;
      }
      if (idx >= i) {
        issues.push(err('forward_reference', `Step '${stepId}' references '${ref}', which does not run before it.`, stepId, pointer));
        return;
      }
      const field = path.segments[1];
      if (field !== 'output' && field !== 'status') {
        issues.push(err('unknown_root', `steps.${ref} can only continue with .output or .status.`, stepId, pointer));
      }
    }
  };

  steps.forEach((s, i) => {
    const base = `/steps/${i}`;
    const { refs, errors } = extractTemplates(s.input);
    for (const e of errors) issues.push(err('template_parse_error', e.error, s.id, `${base}/input${e.pointer}`));
    for (const r of refs) checkPath(r.path, i, s.id, `${base}/input${r.pointer}`);

    const exprs: Array<[string | undefined, string, boolean]> = [
      [s.when, `${base}/when`, false],
      [s.forEach?.items, `${base}/forEach/items`, true],
    ];
    for (const [src, pointer, inItems] of exprs) {
      if (src === undefined) continue;
      const p = parseExpr(src);
      if (!p.ok) {
        issues.push(err('expr_parse_error', `${p.error} (offset ${p.offset})`, s.id, pointer));
        continue;
      }
      for (const path of p.paths) checkPath(path, i, s.id, pointer, inItems);
    }
  });
  return issues;
}
