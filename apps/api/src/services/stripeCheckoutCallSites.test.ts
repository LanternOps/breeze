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
 *
 * SCOPE: `apps/api/src` is not the whole API image. `ee/` holds first-party
 * extensions that are compiled into that image and load at boot behind an enable
 * flag, so an unguarded `checkout.sessions.create` added there ships a raw Stripe
 * error to a payer exactly like one added under `src/`. Both trees are scanned,
 * and paths are keyed from the REPO ROOT so an ee/ call site has to be declared
 * in EXPECTED_CALL_SITES explicitly — it can never inherit an apps/api entry.
 *
 * KNOWN LIMITATION: matching is syntactic. A call reached through an alias
 * (`const create = stripe.checkout.sessions.create; await create(...)`) is not a
 * `checkout.sessions.create` call expression and is not counted as one. Closing
 * that with real alias resolution needs a type-checked program over both trees,
 * which is disproportionate here; instead the third test below rejects any
 * *mention* of `checkout.sessions.create` that is not directly invoked, so the
 * aliasing pattern fails the freeze rather than slipping past it silently.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SCAN_ROOTS = ['apps/api/src', 'ee'].map((rel) => join(REPO_ROOT, rel));

/** Repo-root-relative path -> the exact number of permitted call expressions. */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'apps/api/src/services/invoiceCheckout.ts': 1,
  'apps/api/src/routes/portal/invoices.ts': 1,
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
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

/** A `checkout.sessions.create` reference that is NOT the callee of a call. */
interface CheckoutAlias {
  file: string;
  line: number;
}

const found: { calls: CheckoutCall[]; aliases: CheckoutAlias[] } = { calls: [], aliases: [] };

function findCheckoutCalls(absPath: string): CheckoutCall[] {
  const source = readFileSync(absPath, 'utf8');
  // Cheap pre-filter; the AST below is the authority.
  if (!source.includes('checkout.sessions.create')) return [];
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const rel = relative(REPO_ROOT, absPath).split('\\').join('/');
  const calls: CheckoutCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('checkout.sessions.create')) {
      calls.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        guarded: isGuardedByMapper(node, sf),
      });
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.getText(sf).endsWith('checkout.sessions.create') &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      // Captured rather than invoked: an alias, a `.bind`, a callback argument.
      found.aliases.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe('Stripe checkout call-site contract (multi-currency §10)', () => {
  const calls = SCAN_ROOTS.flatMap((root) => listSourceFiles(root)).flatMap(findCheckoutCalls);
  found.calls = calls;

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

  it('rejects capturing checkout.sessions.create as a value, which would evade the call matcher', () => {
    const captured = found.aliases.map((alias) => `${alias.file}:${alias.line}`);
    expect(
      captured,
      'checkout.sessions.create referenced without being invoked — alias it and the freeze above stops counting it',
    ).toEqual([]);
  });

  it('keeps the customer-safe currency message on the shared mapper', async () => {
    const mod = await import('./stripeCheckoutErrors');
    expect(typeof mod.mapStripeCheckoutError).toBe('function');
    expect(mod.CUSTOMER_SAFE_CURRENCY_UNSUPPORTED_MESSAGE).toBeTruthy();
  });
});
