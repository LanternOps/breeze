/**
 * Guard (#9951): a same-page `<a href="#…">` must be a `HashLink`.
 *
 * Under Astro's `<ClientRouter />` a bare same-page hash anchor is claimed by
 * the router, which `pushState`s the new fragment without firing `hashchange`
 * — so every `hashchange` subscriber keeps rendering the old tab (#4229).
 * `HashLink` (components/shared/HashLink.tsx) assigns `location.hash` itself.
 *
 * AST check (TypeScript compiler API): any JSX `<a>` whose `href` is a string
 * literal / template / conditional starting with `#` (a bare `"#"` placeholder
 * is ignored), including variable-built forms like href={`#${x}`}.
 *
 * Legitimate exceptions carry a `// bare-hash-anchor-exempt: <reason>` comment
 * as the last line directly above the `<a` (e.g. the element installs its own
 * click handler that sets the hash).
 *
 * Scope: .tsx files, inline href expressions only (literal / template / `+` /
 * `??` / `||` / conditional). Hrefs hidden behind an identifier or helper call
 * are not resolved.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

type Violation = { line: number; snippet: string };

/** Does this expression (possibly built from variables) start with "#x"? */
function startsWithHash(expr: ts.Expression): boolean {
  if (ts.isStringLiteralLike(expr)) return /^#./.test(expr.text);
  if (ts.isTemplateExpression(expr)) {
    return expr.head.text.startsWith('#') && (expr.head.text.length > 1 || expr.templateSpans.length > 0);
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return startsWithHash(expr.expression);
  }
  if (ts.isConditionalExpression(expr)) return startsWithHash(expr.whenTrue) || startsWithHash(expr.whenFalse);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      return ts.isStringLiteralLike(expr.left) && expr.left.text === '#' ? true : startsWithHash(expr.left);
    }
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
      return startsWithHash(expr.left) || startsWithHash(expr.right);
    }
  }
  return false;
}

function isExempt(src: string, el: ts.Node): boolean {
  // The marker must be the last thing before the element (only whitespace
  // may follow its line), so it can never exempt a neighbouring anchor.
  return /bare-hash-anchor-exempt[^\n]*\s*$/.test(src.slice(0, el.getStart()));
}

export function findViolations(src: string, label = 'sample.tsx'): Violation[] {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: Violation[] = [];
  const check = (el: ts.JsxOpeningLikeElement) => {
    if (!ts.isIdentifier(el.tagName) || el.tagName.text !== 'a') return;
    for (const attr of el.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'href' || !attr.initializer) continue;
      const init = attr.initializer;
      const value = ts.isStringLiteral(init)
        ? init
        : ts.isJsxExpression(init) && init.expression
          ? init.expression
          : null;
      if (value && startsWithHash(value) && !isExempt(src, el)) {
        const { line } = sf.getLineAndCharacterOfPosition(el.getStart());
        violations.push({ line: line + 1, snippet: attr.getText(sf).replace(/\s+/g, ' ').slice(0, 100) });
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) check(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx$/.test(entry) || /\.(test|spec)\.tsx$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe('guard self-checks (AST analyzer)', () => {
  it('flags a literal href="#tab"', () => {
    expect(findViolations(`const x = <a href="#alerts">A</a>;`)).toHaveLength(1);
  });
  it('flags a template href built from a variable', () => {
    expect(findViolations('const x = <a href={`#${item.hash}`}>A</a>;')).toHaveLength(1);
  });
  it('flags a fallback expression and a concatenation', () => {
    expect(findViolations('const x = <a href={item.href ?? `#${h}`}>A</a>;')).toHaveLength(1);
    expect(findViolations(`const x = <a href={'#' + h}>A</a>;`)).toHaveLength(1);
  });
  it('ignores a bare "#" placeholder, non-hash and non-anchor hrefs, and HashLink', () => {
    expect(findViolations(`const x = <a href="#">A</a>;`)).toHaveLength(0);
    expect(findViolations(`const x = <a href="/devices#alerts">A</a>;`)).toHaveLength(0);
    expect(findViolations('const x = <a href={`/d/${id}#a`}>A</a>;')).toHaveLength(0);
    expect(findViolations(`const x = <HashLink hash="alerts">A</HashLink>;`)).toHaveLength(0);
  });
  it('a marker exempts only the element directly below it', () => {
    const src = `
      const x = (
        <div>
          {/* bare-hash-anchor-exempt: handled */}
          <a href="#a">A</a>
          <a href="#b">B</a>
        </div>
      );`;
    expect(findViolations(src)).toHaveLength(1);
  });
  it('honors the exempt marker', () => {
    const src = `
      const x = (
        // bare-hash-anchor-exempt: sets location.hash in its own onClick
        <a href="#alerts">A</a>
      );`;
    expect(findViolations(src)).toHaveLength(0);
  });
});

describe('no bare same-page hash anchors (#9951)', () => {
  it('uses HashLink for every same-page href="#…" anchor', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      for (const v of findViolations(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${relative(SRC_ROOT, file).split(sep).join('/')}:${v.line}  ${v.snippet}`);
      }
    }
    expect(
      offenders,
      `Same-page hash anchors must use <HashLink hash="…"> (components/shared/HashLink.tsx) so hashchange fires under the Astro client router. ` +
        `If the element handles the click itself, add "// bare-hash-anchor-exempt: <reason>" above it.\n` +
        offenders.join('\n'),
    ).toEqual([]);
  }, 30_000);
});
