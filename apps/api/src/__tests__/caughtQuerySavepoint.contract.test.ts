/**
 * #11203: a catch that maps a constraint violation to a 4xx, a coded refusal or
 * a retry cannot work on a bare statement inside a held transaction. postgres.js
 * rethrows the failure when the transaction ends, so the mapped answer becomes a
 * 500, and any statement after the failure fails with 25P02. The statement must
 * run in `withDbTransaction`, with the catch outside it
 * (docs/agents/tenancy-rls.md).
 *
 * This sweep flags the shape it can see with confidence: a catch that inspects a
 * constraint SQLSTATE, can continue, and whose try body issues an ambient `db`
 * statement outside anything that isolates it.
 *
 * Known limits. It follows no calls, so a try body that reaches the statement
 * through a helper is invisible. It does not flag a generic `catch (err)`
 * fallback: most of those guard redis, network or agent calls, which an AST
 * cannot tell apart from a catch meant for the query. The degraded-read shape is
 * covered by caughtQueryRequestTransaction.integration.test.ts and the doc rule.
 * `withSystemDbAccessContext` counts as isolating, though it joins a held context,
 * and a callback that takes `tx` is trusted to use it. An allowlist key covers a
 * whole function, so a second catch added inside one is not seen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reviewed hits. Key: `<path>::<enclosing function>`, so unrelated edits do not
 * churn it. Each needs a reason a reader can check. Prefer fixing a new hit over
 * adding it here. A stale entry fails the sweep.
 */
const ALLOWLIST: Record<string, string> = {
  'src/routes/agents/topologyAdjacency.ts::POST /:id/topology/adjacency':
    'Agent route holding no context, so withDbAccessContext opens a top-level transaction and the 55P03 catch sits outside it.',
  'src/services/aiAgents/alertVerdicts.ts::persistAlertVerdict':
    'Worker path with no context held: inSystemDbContext opens its own transaction, the catch is outside it, and the re-read uses a fresh one.',
  'src/services/metricRollupMaintenance.ts::compactLegacyMonth':
    'The 55P03 catch sits outside inMaintenanceStep, which opens its own runOutsideDbContext + system transaction per step.',
  'src/services/monitors/conversion/convert.ts::inCallerTransaction':
    'An isolationLevel forces a new top-level transaction, and the 40001/40P01 retry runs after that whole transaction aborted.',
  'src/services/topology/monitoringScheduler.ts::claimPolicySlot':
    'The 23505 comes from the db.transaction(tx) inside acceptTopologyDiagnosticRun. The bare continuityKey update touches no unique index.',
};

/** Reads cannot raise a constraint violation, so a read beside the catch is not the statement it is for. */
const WRITES = new Set(['insert', 'update', 'delete', 'execute']);
/** Each opens its own transaction, or a savepoint, so a catch outside the call survives. */
const ISOLATING_CALLS = new Set([
  'withDbTransaction',
  'withDbTransactionIfHeld',
  'withSystemDbAccessContext',
  'withSystemDbAccessContextIsolated',
  'withAuthDbAccessContext',
  'runOutsideDbContext',
]);
const CONSTRAINT_CHECK = /\b(isPgUniqueViolation|isPgForeignKeyViolation|pgErrorCode|customFieldWriteConflict|isAssignedContactFkViolation)\b|['"]235(05|03|14)['"]/;

function isCallback(node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function isAmbientDbCall(node: ts.CallExpression, name: (text: string) => boolean): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'db'
    && name(callee.name.text);
}

function tryBodyHasBareStatement(tryBlock: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || ts.isFunctionDeclaration(node)) return;
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && ISOLATING_CALLS.has(node.expression.text)) return;
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'transaction') {
        // `(tx) => tx.insert(...)` is a real savepoint; a callback that ignores
        // its tx leaves the ambient db on the outer scope.
        const callback = node.arguments[0];
        if (isCallback(callback) && callback.parameters.length > 0) return;
      }
      if (isAmbientDbCall(node, (text) => WRITES.has(text) || text === 'transaction')) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tryBlock);
  return found;
}

function catchCanContinue(clause: ts.CatchClause): boolean {
  const last = clause.block.statements[clause.block.statements.length - 1];
  if (!last || !ts.isThrowStatement(last)) return true;
  let returns = false;
  const visit = (node: ts.Node): void => {
    if (isCallback(node) || ts.isFunctionDeclaration(node)) return;
    if (ts.isReturnStatement(node)) returns = true;
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  return returns;
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (isCallback(cur) && ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
    if (isCallback(cur) && ts.isCallExpression(cur.parent) && ts.isPropertyAccessExpression(cur.parent.expression)) {
      const path = cur.parent.arguments[0];
      if (path && ts.isStringLiteralLike(path)) return `${cur.parent.expression.name.text.toUpperCase()} ${path.text}`;
    }
  }
  return '<module>';
}

export function findUnisolatedConstraintCatches(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause
      && CONSTRAINT_CHECK.test(node.catchClause.getText(sf))
      && catchCanContinue(node.catchClause)
      && tryBodyHasBareStatement(node.tryBlock)) {
      hits.push(`${path}::${enclosingName(node)}`);
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

const check = (body: string) => findUnisolatedConstraintCatches('x.ts', `async function route(c) {\n${body}\n}`);

describe('the sweep sees the shapes it claims to', () => {
  const MAPPED = `catch (err) { if (isPgUniqueViolation(err)) return c.json({}, 409); throw err; }`;

  it('flags a mapped constraint violation on a bare statement', () => {
    expect(check(`try { await db.insert(t).values({}); } ${MAPPED}`)).toEqual(['x.ts::route']);
  });
  it('flags a SQLSTATE literal', () => {
    expect(check(`try { await db.delete(t); } catch (err) { if (err.cause?.code === '23503') return 1; throw err; }`)).toEqual(['x.ts::route']);
  });
  it('names a route handler by its method and path', () => {
    expect(findUnisolatedConstraintCatches('x.ts', `routes.post('/a/:id', auth, async (c) => { try { await db.insert(t); } ${MAPPED} });`)).toEqual(['x.ts::POST /a/:id']);
  });
  it('passes a read: it cannot raise a constraint', () => {
    expect(check(`try { await db.select().from(t); } ${MAPPED}`)).toEqual([]);
  });
  it('flags a transaction whose callback ignores tx: the ambient db stays on the outer scope', () => {
    expect(check(`try { await db.transaction(async () => { await db.insert(t).values({}); }); } ${MAPPED}`)).toEqual(['x.ts::route']);
  });
  it('flags a statement beside an isolated one', () => {
    expect(check(`try { await withDbTransaction(() => db.insert(t)); await db.update(t).set({}); } ${MAPPED}`)).toEqual(['x.ts::route']);
  });
  it('passes withDbTransaction with the catch outside', () => {
    expect(check(`try { await withDbTransaction(async () => db.insert(t).values({})); } ${MAPPED}`)).toEqual([]);
  });
  it('passes a real nested transaction', () => {
    expect(check(`try { await db.transaction(async (tx) => { await tx.insert(t).values({}); }); } ${MAPPED}`)).toEqual([]);
  });
  it('passes a catch that only rethrows', () => {
    expect(check(`try { await db.insert(t).values({}); } catch (err) { if (isPgUniqueViolation(err)) log(err); throw err; }`)).toEqual([]);
  });
  it('passes a catch that inspects no constraint', () => {
    expect(check(`try { await db.insert(t).values({}); } catch (err) { return c.json({}, 500); }`)).toEqual([]);
  });
});

describe('a catch that maps a constraint violation has a savepoint to survive in', () => {
  const root = join(src, '..');
  const scanned = ['routes', 'services'].flatMap((dir) => sourceFiles(join(src, dir)));
  const hits = scanned.flatMap((file) => findUnisolatedConstraintCatches(relative(root, file), readFileSync(file, 'utf8')));

  it('scans the real tree', () => {
    expect(scanned.length).toBeGreaterThan(500);
  });

  it('has no unreviewed bare statement under a constraint catch', () => {
    expect(hits.filter((hit) => !(hit in ALLOWLIST))).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    expect(Object.keys(ALLOWLIST).filter((key) => !hits.includes(key))).toEqual([]);
  });

  it('gives every allowlist entry a reason', () => {
    expect(Object.entries(ALLOWLIST).filter(([, reason]) => reason.trim().length < 20)).toEqual([]);
  });
});
