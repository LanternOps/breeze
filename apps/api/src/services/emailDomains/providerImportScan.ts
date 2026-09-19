/**
 * The W03 layering contract (spec §2): a ROUTE never talks to the email-domain
 * provider. Request handlers write intent rows and enqueue; the worker is the
 * one place that holds a provider connection, so the account's rate ceiling,
 * retries and outage handling live in exactly one process.
 *
 * This is the machine-checkable half of that rule. It is a pure function over
 * `{ path, source }` — not a regex sprinkled through two suites — so the two
 * route suites assert the SAME contract, a planted-violation control can prove
 * each matcher actually fires, and the multi-line import form
 *
 *     import {
 *       getEmailDomainProvider,
 *     } from '../services/emailDomains/providerRegistry';
 *
 * is caught. The previous per-suite `^import .* from '…'` anchors were
 * single-line only: formatting an offending import across lines (which
 * Prettier does the moment the clause grows) silently disarmed the guard.
 *
 * A `import type` — or an import whose every named binding is `type`-prefixed —
 * is allowed: types are erased and reach no provider at runtime.
 */

export interface ProviderImportViolation {
  /** 1-based line of the statement's first character. */
  line: number;
  /** The module specifier that is forbidden here. */
  specifier: string;
  /** `static`, `dynamic` or `require` — which form was used. */
  form: 'static' | 'dynamic' | 'require';
}

/** Specifiers a route may never pull in at runtime, matched on the path tail. */
const FORBIDDEN = [
  /(^|\/)emailDomains\/providerRegistry$/,
  /(^|\/)emailDomains\/adapters\//,
];

function isForbidden(specifier: string): boolean {
  return FORBIDDEN.some((re) => re.test(specifier));
}

/** True when the import clause erases at compile time and cannot reach a provider. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ') || trimmed === 'type') return true;
  const braces = trimmed.match(/^\{([\s\S]*)\}$/);
  if (!braces) return false;
  const bindings = braces[1]!.split(',').map((b) => b.trim()).filter(Boolean);
  return bindings.length > 0 && bindings.every((b) => /^type\s/.test(b));
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * Every forbidden provider import in `source`. Empty array = the file honours
 * the contract.
 */
export function findProviderImports(file: { path: string; source: string }): ProviderImportViolation[] {
  const { source } = file;
  const found: ProviderImportViolation[] = [];

  // Static `import <clause> from '<specifier>'`, across any number of lines.
  // `[^;]*?` stops the clause from swallowing a later statement, and the
  // non-greedy match ends at the FIRST `from '<spec>'`.
  const staticRe = /\bimport\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(staticRe)) {
    const [, clause, specifier] = m;
    if (!isForbidden(specifier!) || isTypeOnlyClause(clause!)) continue;
    found.push({ line: lineOf(source, m.index), specifier: specifier!, form: 'static' });
  }

  // Side-effect import: `import '<specifier>'` with no clause at all.
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    if (!isForbidden(m[1]!)) continue;
    found.push({ line: lineOf(source, m.index), specifier: m[1]!, form: 'static' });
  }

  // Dynamic `import('<specifier>')` and CommonJS `require('<specifier>')`.
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!isForbidden(m[1]!)) continue;
    found.push({ line: lineOf(source, m.index), specifier: m[1]!, form: 'dynamic' });
  }
  for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!isForbidden(m[1]!)) continue;
    found.push({ line: lineOf(source, m.index), specifier: m[1]!, form: 'require' });
  }

  return found.sort((a, b) => a.line - b.line);
}
