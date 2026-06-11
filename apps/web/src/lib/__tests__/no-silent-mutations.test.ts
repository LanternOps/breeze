/**
 * Guard: in the targeted set, every *mutating* fetchWithAuth call site must be
 * lexically wrapped by `runAction(...)` OR carry an explicit, reasoned
 * `// runaction-exempt:` marker (for the legitimate aggregate / inline-feedback
 * handlers). Whole-file allowlist entries (typed service layers, transport
 * stores) are still skipped via RUN_ACTION_ALLOWLIST.
 *
 * This is an AST check (TypeScript compiler API), not a regex/substring scan.
 * The previous version asserted only that the *file* contained the string
 * "runAction" somewhere — so a new bare mutation added next to existing
 * runAction usage passed unconditionally, and `{ method: opts.method }` /
 * `{ method }` / parenthesised URL args were never matched at all. It had no
 * teeth for the realistic regression. This one is call-local and conservative:
 * a non-literal `method` is treated as potentially-mutating.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { RUN_ACTION_ALLOWLIST, RUN_ACTION_MIGRATION_BACKLOG } from '../runActionAllowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src
const WEB_ROOT = SRC_ROOT;
const REPO_ROOT = resolve(WEB_ROOT, '../../..');

// WS-A "targeted set": files that have ADOPTED runAction and must not regress
// to silent mutations. Grows as more handlers migrate (see the backlog).
const TARGET_GLOBS = [
  'src/components/alerts/NotificationChannelsPage.tsx',
  'src/components/settings/PartnerSettingsPage.tsx',
  'src/components/patches/PatchesPage.tsx',
  'src/components/settings/RolesPage.tsx',
  'src/components/devices/DeviceInfoTab.tsx',
  'src/components/dnsSecurity/DnsSecurityIntegrationsTab.tsx',
  'src/components/dnsSecurity/AddDnsIntegrationModal.tsx',
  'src/components/dnsSecurity/DnsSecurityPoliciesTab.tsx',
  'src/components/dnsSecurity/AddDnsPolicyModal.tsx',
  'src/components/devices/DeviceSoftwareInventory.tsx',
  'src/components/pam/PamRespondModal.tsx',
  'src/components/pam/PamRevokeModal.tsx',
  'src/components/pam/PamRuleModal.tsx',
  'src/components/pam/PamRulesTab.tsx',
  'src/components/settings/TicketCategoriesPage.tsx',
  'src/components/settings/OrgPortalSettingsEditor.tsx',
  'src/components/alerts/CreateTicketFromAlertDialog.tsx',
];

const absoluteFiles: string[] = TARGET_GLOBS.map((rel) => resolve(WEB_ROOT, '..', rel));
const allowAbsolute = new Set(RUN_ACTION_ALLOWLIST.map((a) => resolve(REPO_ROOT, a.file)));

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Violation = { line: number; snippet: string };

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * Classify the options argument of a fetchWithAuth call.
 * Returns true if the call is (or might be) a mutation. Conservative: a
 * non-string-literal `method`, a `{ method }` shorthand, a spread with no
 * explicit safe method, or a non-object options arg all count as mutating.
 */
function isMutatingCall(call: ts.CallExpression): boolean {
  const optionsArg = call.arguments[1];
  if (!optionsArg) return false; // single-arg fetchWithAuth(url) === GET

  if (!ts.isObjectLiteralExpression(optionsArg)) {
    // fetchWithAuth(url, opts) — opts could carry any method. Flag it.
    return true;
  }

  let sawSpread = false;
  for (const prop of optionsArg.properties) {
    if (ts.isSpreadAssignment(prop)) {
      sawSpread = true;
      continue;
    }
    const name =
      prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
        ? prop.name.text
        : null;
    if (name !== 'method') continue;

    if (ts.isShorthandPropertyAssignment(prop)) return true; // { method }
    if (ts.isPropertyAssignment(prop)) {
      const init = prop.initializer;
      if (ts.isStringLiteralLike(init)) {
        const verb = init.text.toUpperCase();
        if (SAFE_METHODS.has(verb)) return false;
        return MUTATING_METHODS.has(verb) ? true : true; // any explicit non-safe verb → flag
      }
      // method: opts.method / cond ? 'PATCH' : 'POST' / `${x}` — can't prove safe.
      return true;
    }
  }
  // No explicit `method`. A spread might inject one → conservative flag;
  // otherwise it defaults to GET (safe).
  return sawSpread;
}

function isWrappedByRunAction(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur) && calleeName(cur.expression) === 'runAction') return true;
    cur = cur.parent;
  }
  return false;
}

function enclosingStatementStart(node: ts.Node): number {
  let cur: ts.Node = node;
  while (
    cur.parent &&
    !ts.isBlock(cur.parent) &&
    !ts.isSourceFile(cur.parent) &&
    !ts.isModuleBlock(cur.parent) &&
    !ts.isCaseClause(cur.parent) &&
    !ts.isDefaultClause(cur.parent)
  ) {
    cur = cur.parent;
  }
  return cur.getFullStart();
}

function isExempt(src: string, node: ts.Node): boolean {
  // Any `runaction-exempt` marker in the trivia/text between the start of the
  // enclosing statement and the call itself counts. Robust to exact comment
  // attribution (leading-comment-range edge cases) and to the for-loop case.
  const from = enclosingStatementStart(node);
  const window = src.slice(from, node.getStart());
  return /runaction-exempt/i.test(window);
}

function findViolations(src: string, label = 'sample.tsx'): Violation[] {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === 'fetchWithAuth') {
      if (isMutatingCall(node) && !isWrappedByRunAction(node) && !isExempt(src, node)) {
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

// ─── Self-check: the analyzer itself has teeth ──────────────────────────────
describe('guard self-checks (AST analyzer)', () => {
  it('flags a bare mutating call not wrapped by runAction', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'POST', body: '{}' });`)).toHaveLength(1);
  });

  it('does NOT flag a call wrapped by runAction', () => {
    const src = `runAction({ request: () => fetchWithAuth('/x', { method: 'POST' }), errorFallback: 'e' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('does NOT flag a GET (explicit or single-arg)', () => {
    expect(findViolations(`fetchWithAuth('/x', { method: 'GET' });`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x');`)).toHaveLength(0);
    expect(findViolations(`fetchWithAuth('/x', { headers: { a: '1' } });`)).toHaveLength(0);
  });

  it('flags a non-literal method (the old regex missed `{ method: opts.method }`)', () => {
    expect(findViolations(`fetchWithAuth(u, { method: opts.method, body: b });`)).toHaveLength(1);
  });

  it('flags a shorthand `{ method }` (old regex missed it)', () => {
    expect(findViolations(`const method='PUT'; fetchWithAuth(u, { method });`)).toHaveLength(1);
  });

  it('flags a parenthesised-URL mutation (old `[^)]*` regex could not cross `)`)', () => {
    expect(findViolations('fetchWithAuth(`/x/${build(id)}`, { method: \'DELETE\' });')).toHaveLength(1);
  });

  it('flags a non-object options arg conservatively', () => {
    expect(findViolations(`fetchWithAuth(u, opts);`)).toHaveLength(1);
  });

  it('honours an explicit runaction-exempt marker on the enclosing statement', () => {
    const src = `// runaction-exempt: aggregate\nconst r = await fetchWithAuth('/x', { method: 'POST' });`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('honours a runaction-exempt marker inside a for-loop body', () => {
    const src = `for (const id of ids) {\n  // runaction-exempt: inline UI\n  const r = await fetchWithAuth(\`/x/\${id}\`, { method: 'POST' });\n}`;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('still flags a NEW bare mutation added next to existing runAction usage (the realistic regression)', () => {
    const src = `
      await runAction({ request: () => fetchWithAuth('/a', { method: 'POST' }), errorFallback: 'e' });
      await fetchWithAuth('/sneaky', { method: 'DELETE' });
    `;
    // The file "contains runAction" — the OLD substring check passed this.
    const v = findViolations(src);
    expect(v).toHaveLength(1);
    expect(v[0].snippet).toContain('/sneaky');
  });

  it('allowlisted path is present in the allowlist Set', () => {
    const entry = RUN_ACTION_ALLOWLIST[0];
    expect(entry).toBeDefined();
    expect(allowAbsolute.has(resolve(REPO_ROOT, entry.file))).toBe(true);
  });
});

// ─── Backlog integrity check ─────────────────────────────────────────────────
describe('migration backlog integrity', () => {
  it('backlog is non-empty (debt is tracked)', () => {
    expect(RUN_ACTION_MIGRATION_BACKLOG.length).toBeGreaterThan(0);
  });

  it('every backlog entry is a string path under apps/web/src/', () => {
    for (const entry of RUN_ACTION_MIGRATION_BACKLOG) {
      expect(typeof entry).toBe('string');
      expect(entry.startsWith('apps/web/src/')).toBe(true);
    }
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no silent mutations in targeted set', () => {
  it('finds files to scan', () => {
    expect(absoluteFiles.length).toBe(17);
    for (const f of absoluteFiles) {
      expect(() => statSync(f)).not.toThrow();
    }
  });

  for (const absPath of absoluteFiles) {
    const webRelLabel = absPath.startsWith(WEB_ROOT) ? 'src' + absPath.slice(WEB_ROOT.length) : absPath;
    if (allowAbsolute.has(absPath)) continue; // whole-file allowlisted — skip

    it(`${webRelLabel}: every mutating fetchWithAuth is wrapped by runAction or explicitly exempt`, () => {
      const src = readFileSync(absPath, 'utf8');
      const violations = findViolations(src, webRelLabel);
      expect(
        violations,
        violations.length
          ? `Silent mutation(s) in ${webRelLabel}:\n` +
              violations.map((v) => `  L${v.line}: ${v.snippet}`).join('\n') +
              `\nWrap in runAction(), or add "// runaction-exempt: <reason>" if it is a ` +
              `legitimate aggregate/inline-feedback handler.`
          : undefined
      ).toEqual([]);
    });
  }
});
