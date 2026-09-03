import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Multi-currency §11 freeze (Phase C, Task 3 — accountingCurrency.ts:143-186).
 *
 * `AccountingProvider.pushInvoice`/`voidInvoice` must only ever be reached
 * through `accountingInvoicePush.ts`'s guarded coordinator
 * (`pushInvoiceToAccounting` / `voidInvoiceInAccounting`), which runs the
 * currency guard (`assertAccountingInvoicePushCurrency`) and every mapping
 * write BEFORE the provider call. A second call site anywhere else in the
 * image would bypass that guard entirely — this test pins the invariant the
 * same way `stripeCheckoutCallSites.test.ts` pins Stripe's currency mapper: an
 * AST scan, not a grep, because a textual count is satisfied by an unused
 * import and a per-FILE count misses a second call added to a file that
 * already has one.
 *
 * SCOPE: `apps/api/src` is not the whole API image. `ee/` holds first-party
 * extensions compiled into that image and loaded at boot behind an enable
 * flag, so an unguarded call there would bypass the guard exactly like one
 * added under `src/`. Both trees are scanned, paths keyed from the REPO ROOT.
 *
 * Test files are excluded entirely (mirrors the Stripe gate): a mocked
 * provider's `.pushInvoice`/`.voidInvoice` in a unit test is a property access
 * on a mock object, not a call the guard needs to police, and
 * `quickbooksProvider.test.ts` legitimately calls the transport methods
 * directly to test the transport itself.
 *
 * KNOWN LIMITATION: matching is syntactic (an aliased/rebound reference to
 * `provider.pushInvoice` would not be caught) — the same limitation the
 * Stripe gate documents and accepts for the same reason: real alias
 * resolution needs a type-checked program over both trees, disproportionate
 * for a freeze test.
 */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SCAN_ROOTS = ['apps/api/src', 'ee'].map((rel) => join(REPO_ROOT, rel));

/** Repo-root-relative path -> the exact number of permitted call expressions (both methods combined). */
const EXPECTED_CALL_SITES: Record<string, number> = {
  'apps/api/src/services/accounting/accountingInvoicePush.ts': 2, // one pushInvoice, one voidInvoice
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

interface ProviderCall {
  file: string;
  line: number;
  method: 'pushInvoice' | 'voidInvoice';
}

function findProviderCalls(absPath: string): ProviderCall[] {
  const source = readFileSync(absPath, 'utf8');
  // Cheap pre-filter; the AST below is the authority.
  if (!source.includes('.pushInvoice(') && !source.includes('.voidInvoice(')) return [];
  const sf = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);
  const rel = relative(REPO_ROOT, absPath).split('\\').join('/');
  const calls: ProviderCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const text = node.expression.getText(sf);
      if (text.endsWith('.pushInvoice') || text.endsWith('.voidInvoice')) {
        calls.push({
          file: rel,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          method: text.endsWith('.pushInvoice') ? 'pushInvoice' : 'voidInvoice',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

describe('AccountingProvider pushInvoice/voidInvoice call-site contract (Phase C, multi-currency §11)', () => {
  const calls = SCAN_ROOTS.flatMap((root) => listSourceFiles(root)).flatMap(findProviderCalls);

  it('has exactly the known production pushInvoice/voidInvoice CALLS, counted per call', () => {
    const counts: Record<string, number> = {};
    for (const call of calls) counts[call.file] = (counts[call.file] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_CALL_SITES);
    expect(calls).toHaveLength(
      Object.values(EXPECTED_CALL_SITES).reduce((sum, n) => sum + n, 0),
    );
  });

  it('finds both methods called exactly once each, inside the coordinator', () => {
    const byMethod: Record<string, number> = {};
    for (const call of calls) {
      if (call.file !== 'apps/api/src/services/accounting/accountingInvoicePush.ts') continue;
      byMethod[call.method] = (byMethod[call.method] ?? 0) + 1;
    }
    expect(byMethod).toEqual({ pushInvoice: 1, voidInvoice: 1 });
  });
});
