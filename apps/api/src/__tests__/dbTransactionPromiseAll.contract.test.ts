/**
 * #11203 / #11225: a savepoint started beside sibling statements in a
 * `Promise.all` does not isolate. They share one connection, so a failed
 * savepoint waits one round trip for its rollback, a sibling's next statement
 * lands in the aborted transaction, and the commit throws. Two parallel savepoints
 * also fail together. Verified on real Postgres; see docs/agents/tenancy-rls.md.
 *
 * This scan flags the shape it can see with confidence: a savepoint helper called
 * as an element of the array (including behind `&&`, `||`, `??` or a ternary), or
 * anywhere in the body of an inline callback mapped over it.
 *
 * Known limits. It follows no calls, so a helper that opens a savepoint inside
 * itself and is then run in a `Promise.all` is invisible, which is the shape
 * `getBackupHealthSummary` had. No static check here can see that: whether a call
 * reaches a savepoint is a whole-program question. Read a helper before running it
 * in parallel. It also misses an array built in a variable, `.map(namedFunction)`,
 * and an aliased import.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

const SAVEPOINT_HELPERS = new Set([
  'withDbTransaction',
  'withDbTransactionIfHeld',
  'withSystemDbAccessContextIsolated',
]);
const PARALLEL_COMBINATORS = new Set(['all', 'allSettled', 'any', 'race']);

/**
 * `withDbTransaction(...)` with any `.then` / `.catch` chain on it. Parentheses,
 * `await` and casts are unwrapped.
 */
function startsSavepoint(node: ts.Expression): boolean {
  let cur: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)
      || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isConditionalExpression(cur)) return startsSavepoint(cur.whenTrue) || startsSavepoint(cur.whenFalse);
    if (ts.isBinaryExpression(cur)) {
      const op = cur.operatorToken.kind;
      if (op !== ts.SyntaxKind.AmpersandAmpersandToken && op !== ts.SyntaxKind.BarBarToken && op !== ts.SyntaxKind.QuestionQuestionToken) return false;
      return startsSavepoint(cur.left) || startsSavepoint(cur.right);
    }
    if (!ts.isCallExpression(cur)) return false;
    if (ts.isIdentifier(cur.expression)) return SAVEPOINT_HELPERS.has(cur.expression.text);
    if (ts.isPropertyAccessExpression(cur.expression)) {
      if (ts.isIdentifier(cur.expression.expression) && cur.expression.expression.text !== 'Promise'
        && SAVEPOINT_HELPERS.has(cur.expression.name.text)) return true;
      cur = cur.expression.expression;
      continue;
    }
    return false;
  }
}

function callbackStartsSavepoint(callback: ts.Expression | undefined): boolean {
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return false;
  if (!ts.isBlock(callback.body)) return startsSavepoint(callback.body);
  let found = false;
  // Anywhere in the body: each element's savepoints still run beside the others'.
  // A nested function is skipped, unless it is that savepoint's own callback.
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
    if (ts.isCallExpression(node) && startsSavepoint(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return found;
}

function elementsStartSavepoint(argument: ts.Expression): boolean {
  if (ts.isArrayLiteralExpression(argument)) {
    return argument.elements.some((element) =>
      startsSavepoint(ts.isSpreadElement(element) ? element.expression : element)
      || (ts.isSpreadElement(element) && elementsStartSavepoint(element.expression)));
  }
  if (ts.isCallExpression(argument) && ts.isPropertyAccessExpression(argument.expression)
    && argument.expression.name.text === 'map') {
    return callbackStartsSavepoint(argument.arguments[0]);
  }
  return false;
}

export function findSavepointsInPromiseAll(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Promise'
      && PARALLEL_COMBINATORS.has(node.expression.name.text)
      && node.arguments[0]
      && elementsStartSavepoint(node.arguments[0])) {
      hits.push(`${path}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

const check = (body: string) => findSavepointsInPromiseAll('x.ts', `async function f() {\n${body}\n}`);

describe('the scan sees the shapes it claims to', () => {
  it('flags a savepoint as an array element', () => {
    expect(check(`await Promise.all([withDbTransaction(() => q()), other()]);`)).toEqual(['x.ts:2']);
  });
  it('flags every savepoint helper and every combinator', () => {
    expect(check(`await Promise.allSettled([withDbTransactionIfHeld(() => q())]);`)).toHaveLength(1);
    expect(check(`await Promise.race([withSystemDbAccessContextIsolated(() => q())]);`)).toHaveLength(1);
  });
  it('flags a chained catch, the usual reason to write it', () => {
    expect(check(`await Promise.all([withDbTransaction(() => q()).catch(() => null), other()]);`)).toHaveLength(1);
  });
  it('flags a savepoint mapped over a list', () => {
    expect(check(`await Promise.all(ids.map((id) => withDbTransaction(() => q(id))));`)).toHaveLength(1);
    expect(check(`await Promise.all(ids.map(async (id) => { return withDbTransaction(() => q(id)); }));`)).toHaveLength(1);
  });
  it('flags a savepoint anywhere in a mapped block body', () => {
    expect(check(`await Promise.all(ids.map(async (id) => { await withDbTransaction(() => q(id)); }));`)).toHaveLength(1);
    expect(check(`await Promise.all(ids.map(async (id) => { try { await withDbTransaction(() => q(id)); } catch {} }));`)).toHaveLength(1);
  });
  it('flags a savepoint behind a condition', () => {
    expect(check(`await Promise.all([cond && withDbTransaction(() => q()), other()]);`)).toHaveLength(1);
    expect(check(`await Promise.all([cond ? withDbTransaction(() => q()) : null, other()]);`)).toHaveLength(1);
  });
  it('passes a savepoint inside a nested function a mapped body only defines', () => {
    expect(check(`await Promise.all(ids.map(async (id) => { const later = () => withDbTransaction(() => q(id)); return id; }));`)).toEqual([]);
  });
  it('flags a spread of a mapped savepoint', () => {
    expect(check(`await Promise.all([...ids.map((id) => withDbTransaction(() => q(id))), other()]);`)).toHaveLength(1);
  });
  it('passes a Promise.all inside a savepoint: its statements are the ones being isolated', () => {
    expect(check(`await withDbTransaction(() => Promise.all([q(), r()]));`)).toEqual([]);
  });
  it('passes a Promise.all with no savepoint', () => {
    expect(check(`await Promise.all([withSystemDbAccessContext(() => q()), other()]);`)).toEqual([]);
  });
  it('passes a call that hides its savepoint: the documented limit', () => {
    expect(check(`await Promise.all([helperWithASavepointInside(), other()]);`)).toEqual([]);
  });
});

describe('no savepoint is started beside its siblings', () => {
  it('finds none in the API source', () => {
    const hits = sourceFiles(src).flatMap((path) =>
      findSavepointsInPromiseAll(relative(join(src, '..'), path), readFileSync(path, 'utf8')));
    expect(hits, 'run these in sequence: see docs/agents/tenancy-rls.md').toEqual([]);
  }, 30_000); // parses every API source file; ~10 s on a loaded CI runner
});
