import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Multi-currency §10 freeze (#3780).
 *
 * Spec §10 requires that a Stripe Checkout currency failure reaches the customer
 * as a friendly, actionable message — never the raw Stripe error. That is
 * implemented by `mapStripeCheckoutError` (services/stripeCheckoutErrors.ts) and
 * wired into BOTH production `checkout.sessions.create` call sites. This test
 * pins the invariant: a THIRD call site that forgets the mapping fails here
 * instead of shipping a raw Stripe string to a payer.
 *
 * It parses the AST rather than grepping, because both cheap textual checks are
 * false-negative prone: counting FILES misses a second call added to a file that
 * already has one, and asserting the mapper's NAME appears in the file is
 * satisfied by an unused import.
 *
 * Wave 8 adds no Stripe behaviour; §10 was completed in waves 5-6.
 */
const SRC_ROOT = join(__dirname, '..');

/** Source-relative path -> the exact number of permitted call expressions. */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'services/invoiceCheckout.ts': 1,
  'routes/portal/invoices.ts': 1,
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** True when SOME enclosing try statement's catch clause CALLS mapStripeCheckoutError. */
function isGuardedByMapper(node: ts.Node, sf: ts.SourceFile): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (!ts.isTryStatement(cur) || !cur.catchClause) continue;
    let callsMapper = false;
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText(sf) === 'mapStripeCheckoutError') callsMapper = true;
      ts.forEachChild(n, walk);
    };
    walk(cur.catchClause);
    if (callsMapper) return true;
  }
  return false;
}

interface CheckoutCall {
  file: string;
  line: number;
  guarded: boolean;
}

function findCheckoutCalls(absPath: string): CheckoutCall[] {
  const source = readFileSync(absPath, 'utf8');
  // Cheap pre-filter; the AST below is the authority.
  if (!source.includes('checkout.sessions.create')) return [];
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const rel = relative(SRC_ROOT, absPath).split('\\').join('/');
  const calls: CheckoutCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('checkout.sessions.create')) {
      calls.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        guarded: isGuardedByMapper(node, sf),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe('Stripe checkout call-site contract (multi-currency §10)', () => {
  const calls = listSourceFiles(SRC_ROOT).flatMap(findCheckoutCalls);

  it('has exactly the known production checkout.sessions.create CALLS, counted per call', () => {
    const counts: Record<string, number> = {};
    for (const call of calls) counts[call.file] = (counts[call.file] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_CALL_SITES);
    expect(calls).toHaveLength(
      Object.values(EXPECTED_CALL_SITES).reduce((sum, n) => sum + n, 0),
    );
  });

  it('encloses every call in an error path that CALLS mapStripeCheckoutError', () => {
    const unguarded = calls.filter((call) => !call.guarded).map((call) => `${call.file}:${call.line}`);
    expect(unguarded, 'checkout.sessions.create without a catch that calls mapStripeCheckoutError').toEqual([]);
  });

  it('keeps the customer-safe currency message on the shared mapper', async () => {
    const mod = await import('./stripeCheckoutErrors');
    expect(typeof mod.mapStripeCheckoutError).toBe('function');
    expect(mod.CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE).toBeTruthy();
  });
});
