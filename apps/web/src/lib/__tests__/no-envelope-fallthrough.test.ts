/**
 * Guard: no *list-producing* `??` chain may mix `payload.<key>` with a bare
 * `payload` fallback.
 *
 * The idiom this bans looked harmless and was pasted into ~50 components:
 *
 *     const list = data.data ?? data.sites ?? data ?? [];
 *
 * `??` only falls through on null/undefined, so when the response keys don't
 * match — an error body returned with HTTP 200, a renamed field, a wrong URL
 * that 404s into a JSON error — the chain lands on the bare `data` term and
 * stores the **envelope object** in React state. The next render calls
 * `list.map(...)`, throws `X.map is not a function`, and React unmounts the
 * island. The page goes blank with nothing in the UI explaining why, and no
 * test catches it because the happy path never exercises the fallback.
 *
 * `/devices/groups` shipped that way and was blank from day one.
 *
 * The sanctioned replacement is `asList(payload, 'sites')` from
 * `src/lib/asList.ts`, which fails closed to `[]`.
 *
 * AST-based (TypeScript compiler API), modeled on `no-hash-in-usestate.test.ts`
 * so multi-line chains and reformatting can't slip past a regex. Legitimate
 * exceptions must carry an explicit `// aslist-exempt: <reason>` marker on the
 * enclosing statement.
 *
 * Known blind spot, accepted deliberately: the list-context heuristic can't see
 * a chain handed straight to a state setter (`setRows(data.data ?? data)`)
 * whose value is `.map()`ed elsewhere — flagging every setter would false-
 * positive on legitimate object unwraps (`setScript(data.script ?? data)`).
 * So this guard proves nobody wrote the *spelled-out* idiom, not that an
 * envelope can never reach list state. Reviewers: prefer asList() for anything
 * a component will iterate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

type Violation = { line: number; snippet: string };

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;

const isNullishChain = (node: ts.Node): node is ts.BinaryExpression =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;

/** Flatten `a ?? b ?? c` into [a, b, c]. */
function chainOperands(node: ts.BinaryExpression): ts.Expression[] {
  const left = unwrap(node.left);
  const leftParts = isNullishChain(left) ? chainOperands(left) : [left];
  return [...leftParts, unwrap(node.right)];
}

/** The identifier an access chain is rooted at: `a?.b.c` -> `a`. */
function rootIdentifier(node: ts.Expression): string | null {
  let cur: ts.Expression = unwrap(node);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    cur = unwrap(cur.expression);
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

const isAccess = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);

const ARRAY_METHODS = new Set([
  'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every',
  'slice', 'sort', 'reduce', 'flatMap', 'flat', 'concat', 'includes', 'join',
]);

/**
 * Restrict the rule to LIST contexts.
 *
 * `data.script ?? data` unwrapping a single object is a different (and
 * survivable) pattern — it yields an object either way and never throws
 * `.map is not a function`. Only chains that are meant to produce an array can
 * blank an island, so flag one only when it terminates in `[]` / an
 * `Array.isArray` guard, or is immediately consumed by an array method.
 */
function isListContext(chain: ts.BinaryExpression, operands: ts.Expression[]): boolean {
  const terminal = operands[operands.length - 1];
  if (ts.isArrayLiteralExpression(terminal) && terminal.elements.length === 0) return true;
  if (
    ts.isConditionalExpression(terminal) &&
    /^Array\.isArray\(/.test(terminal.condition.getText())
  ) {
    return true;
  }
  let parent: ts.Node | undefined = chain.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return Boolean(
    parent &&
      ts.isPropertyAccessExpression(parent) &&
      ARRAY_METHODS.has(parent.name.text),
  );
}

function enclosingStatementStart(node: ts.Node): number {
  let cur: ts.Node = node;
  while (
    cur.parent &&
    !ts.isBlock(cur.parent) &&
    !ts.isSourceFile(cur.parent) &&
    !ts.isModuleBlock(cur.parent)
  ) {
    cur = cur.parent;
  }
  return cur.getFullStart();
}

function isExempt(src: string, node: ts.Node): boolean {
  return /aslist-exempt/i.test(src.slice(enclosingStatementStart(node), node.getStart()));
}

export function findViolations(src: string, label = 'sample.tsx'): Violation[] {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    // Only inspect the outermost `??` of a chain; `a ?? b ?? c` parses
    // left-associatively, so the top node carries every operand.
    if (isNullishChain(node) && !(node.parent && isNullishChain(node.parent))) {
      const operands = chainOperands(node);
      const bareRoots = new Set(
        operands.filter(ts.isIdentifier).map((operand) => operand.text),
      );
      const offending =
        isListContext(node, operands) &&
        operands.some((operand) => {
          if (!isAccess(operand)) return false;
          const root = rootIdentifier(operand);
          return root !== null && bareRoots.has(root);
        });
      if (offending && !isExempt(src, node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        violations.push({
          line: line + 1,
          snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return violations;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'locales') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no envelope-fallthrough in ?? chains', () => {
  it('flags the banned idiom', () => {
    expect(findViolations('const x = data.data ?? data.sites ?? data ?? [];')).toHaveLength(1);
    expect(findViolations('const x = payload?.data ?? payload ?? [];')).toHaveLength(1);
    expect(findViolations('const x = (d.sites ?? d).map(f);')).toHaveLength(1);
    // Multi-line chains must not escape the check.
    expect(
      findViolations('const x =\n  payload.data ??\n  payload.versions ??\n  payload ??\n  [];'),
    ).toHaveLength(1);
  });

  it('allows the sanctioned replacement and unrelated ?? use', () => {
    expect(findViolations("const x = asList(data, 'sites');")).toEqual([]);
    expect(findViolations('const x = data.data ?? [];')).toEqual([]);
    // Already safe: the explicit Array.isArray guard is what asList does
    // internally, so it never stores the envelope. Callers were normalised onto
    // asList for consistency, but the rule has no reason to reject this.
    expect(
      findViolations('const x = d.data ?? d.sites ?? (Array.isArray(d) ? d : []);'),
    ).toEqual([]);
    expect(findViolations('const name = user.name ?? fallback ?? "anon";')).toEqual([]);
    expect(findViolations('const n = a.count ?? b.count ?? 0;')).toEqual([]);
  });

  it('leaves single-object unwrapping alone (different, non-crashing pattern)', () => {
    // These yield an object either way — they can't throw `.map is not a
    // function`, so they are out of scope for this rule.
    expect(findViolations('const script = data.script ?? data;')).toEqual([]);
    expect(findViolations('const s = data.data ?? data ?? {};')).toEqual([]);
    expect(findViolations('setSettings(normalizeSettings(data.data ?? data));')).toEqual([]);
  });

  it('honours an explicit exemption marker', () => {
    expect(
      findViolations('// aslist-exempt: legacy shape\nconst x = data.data ?? data ?? [];'),
    ).toEqual([]);
  });

  it('no source file in apps/web/src uses the idiom', () => {
    const offenders = walk(SRC_ROOT)
      .map((file) => ({ file, violations: findViolations(readFileSync(file, 'utf8'), file) }))
      .filter((entry) => entry.violations.length > 0)
      .map(
        (entry) =>
          `${entry.file.split(`src${sep}`)[1]}:${entry.violations[0].line}  ${entry.violations[0].snippet}`,
      );

    expect(
      offenders,
      `Use asList() from src/lib/asList.ts instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
