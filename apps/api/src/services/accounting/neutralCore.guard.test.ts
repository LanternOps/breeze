/**
 * Xero W01 neutral-core guard (spec "Mechanical guard"). The accounting core
 * (services/accounting, jobs, routes/accounting) must not name QuickBooks in code:
 * no 'quickbooks' literal and no import of QuickBooks internals. Provider code
 * lives in *Provider.ts / quickbooksFault.ts / providerRegistry.ts.
 *
 * AST-based (like accountingInvoicePushCallSites.test.ts) so comments and
 * template text that merely MENTION QuickBooks never trip it, and a literal
 * hidden in a template or a computed key always does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '..', '..');
const ROOTS = ['services/accounting', 'jobs', 'routes/accounting'].map((p) => join(SRC, p));
const EXEMPT = (rel: string) => /Provider\.ts$/.test(rel) || rel.endsWith('/quickbooksFault.ts') || rel.endsWith('/providerRegistry.ts');
/** Repo-src-relative path -> reason (≥ 20 chars). The core push/pull/mapping services may never be added. */
const ALLOWLIST: Record<string, string> = {
  'services/accounting/types.ts':
    'declares ACCOUNTING_PROVIDER_IDS, the provider id enum: the one place the id must be spelled out',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

export function findViolations(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'quickbooks') {
      out.push(`literal 'quickbooks' at ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (/quickbooksFault|quickbooksProvider/.test(spec)) out.push(`imports ${spec}`);
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (/^(qbo|Qbo|QBO_)/.test(imported)) out.push(`imports symbol ${imported} from ${spec}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('neutral accounting core (Xero W01)', () => {
  it('the guard catches what it claims to (controls)', () => {
    expect(findViolations(`const p = 'quickbooks';`, 'x.ts')).toHaveLength(1);
    expect(findViolations('const p = `quickbooks`;', 'x.ts')).toHaveLength(1);
    expect(findViolations(`import { qboFaultOf } from './quickbooksFault';`, 'x.ts')).toHaveLength(2);
    expect(findViolations(`import { QBO_CLIENT_ID } from '../../config/env';`, 'x.ts')).toHaveLength(1);
    expect(findViolations(`// talks to QuickBooks\nconst label = 'QuickBooks';`, 'x.ts')).toHaveLength(0);
    expect(findViolations(`const s = 'quickbooks_import';`, 'x.ts')).toHaveLength(0);
    // The dead alias 'quickbooks_error' (accountingInvoicePushErrors.ts) is permitted by rule:
    // only the exact provider id 'quickbooks' is flagged, not a longer string that contains it.
    expect(findViolations(`const c = 'quickbooks_error';`, 'x.ts')).toHaveLength(0);
  });

  it('no core file names QuickBooks in code', () => {
    const files = ROOTS.flatMap(walk);
    // Guard against a vacuous pass: if ROOTS ever resolves to an empty/near-empty
    // file list (e.g. a bad path after a directory move), the loop below would
    // trivially succeed with zero failures. ~191 files exist today.
    expect(files.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const file of files) {
      const rel = relative(SRC, file);
      if (EXEMPT(rel) || ALLOWLIST[rel]) continue;
      for (const v of findViolations(readFileSync(file, 'utf8'), file)) failures.push(`${rel}: ${v}`);
    }
    expect(failures, `Move QuickBooks specifics behind AccountingProvider (see docs/superpowers/plans/billing/2026-09-26-xero-w01-core-neutralization.md):\n${failures.join('\n')}`).toEqual([]);
  });

  it('allowlist entries are justified and not stale', () => {
    for (const [rel, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.length, `${rel}: reason too short`).toBeGreaterThanOrEqual(20);
      expect(findViolations(readFileSync(join(SRC, rel), 'utf8'), rel).length, `${rel}: stale allowlist entry`).toBeGreaterThan(0);
    }
  });
});
