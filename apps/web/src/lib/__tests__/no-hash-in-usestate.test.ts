/**
 * Guard (#2421): no component may read `window.location.hash` inside a
 * `useState` initializer.
 *
 * The URL fragment is never sent to the server, so hash-derived initial state
 * renders differently on the server and on the first client render — React
 * discards the SSR tree with a hydration-mismatch error on every deep link
 * (the #2383/#2416 regression class). The sanctioned pattern is
 * `useHashState` / `useHashTab` from `src/lib/useHashState.ts`, which starts
 * from the SSR-safe default and adopts the hash in a pre-paint effect.
 *
 * This is an AST check (TypeScript compiler API), modeled on
 * `no-silent-mutations.test.ts`. Two rules, both call-local:
 *   1. The `useState` argument subtree itself contains a `location.hash` read.
 *   2. The argument references a SAME-FILE function whose body reads
 *      `location.hash` (the common `useState(getTabFromHash)` form).
 * Cross-file helpers are out of reach of rule 2, but every such helper call
 * observed so far passes `window.location.hash` at the call site — which rule
 * 1 catches.
 *
 * Legitimate exceptions (none known today) must carry an explicit
 * `// hash-usestate-exempt: <reason>` marker on the enclosing statement.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

const LOCATION_HASH_RE = /\blocation\s*\.\s*hash\b/;

type Violation = { line: number; snippet: string };

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text; // React.useState
  return null;
}

/**
 * Names declared in this file that carry a `location.hash` read — both
 * hash-reading *functions* (`function getTabFromHash() {…}`, `const readTab =
 * () => …`) and plain *values* computed from the hash (`const initial =
 * window.location.hash.slice(1)`). The latter matters because `const initial =
 * …hash…; useState(initial)` is the most natural thing to write once the guard
 * reds a PR, and it reintroduces exactly the same hydration bug.
 */
function collectHashReadingNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (LOCATION_HASH_RE.test(node.body.getText(sf))) names.add(node.name.text);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      LOCATION_HASH_RE.test(node.initializer.getText(sf))
    ) {
      // Covers both function-valued and plain-value initializers.
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function referencesAny(node: ts.Node, names: Set<string>): boolean {
  if (names.size === 0) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
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
  const from = enclosingStatementStart(node);
  const window = src.slice(from, node.getStart());
  return /hash-usestate-exempt/i.test(window);
}

// `useReducer(reducer, initialArg, init)` has the same lazy-init hazard as
// useState, so both are checked. The initial value is the last argument.
const INIT_HOOKS = new Set(['useState', 'useReducer']);

export function findViolations(src: string, label = 'sample.tsx'): Violation[] {
  const sf = ts.createSourceFile(label, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hashNames = collectHashReadingNames(sf);
  const violations: Violation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression);
      if (!callee || !INIT_HOOKS.has(callee)) {
        ts.forEachChild(node, visit);
        return;
      }
      // useState(initial) / useReducer(reducer, initialArg, init?) — the state
      // seed is everything after the reducer for useReducer, the sole arg for useState.
      const seedArgs =
        callee === 'useReducer' ? node.arguments.slice(1) : node.arguments.slice(0, 1);
      for (const arg of seedArgs) {
        const direct = LOCATION_HASH_RE.test(arg.getText(sf));
        // A bare same-file reference (`useState(getTabFromHash)`, `useState(initial)`)
        // or a wrapped call (`useState(() => getTabFromHash())`) is just as unsafe.
        const viaName = !direct && referencesAny(arg, hashNames);
        if ((direct || viaName) && !isExempt(src, node)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          violations.push({
            line: line + 1,
            snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 120),
          });
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

/** All non-test .ts/.tsx sources under apps/web/src. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

// ─── Self-check: the analyzer itself has teeth ──────────────────────────────
describe('guard self-checks (AST analyzer)', () => {
  it('flags an inline lazy initializer reading location.hash', () => {
    const src = `const [open] = useState(() => window.location.hash === '#add-device');`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('flags a direct (non-lazy) initializer expression reading location.hash', () => {
    const src = `const [tab] = useState(window.location.hash.replace('#', ''));`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('flags a bare same-file helper reference (useState(getTabFromHash))', () => {
    const src = `
      function getTabFromHash() { return window.location.hash.replace('#', ''); }
      const [tab] = useState(getTabFromHash);
    `;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('flags a wrapped same-file helper call (useState(() => helper(...)))', () => {
    const src = `
      const readTab = () => window.location.hash.slice(1);
      const [tab] = useState(() => resolve(readTab(), true));
    `;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('flags a hash read hoisted into a local const (the natural way to dodge the guard)', () => {
    const src = `
      const initial = window.location.hash.slice(1);
      const [tab] = useState(initial);
    `;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('flags a lazy useReducer init reading location.hash', () => {
    const src = `const [s, d] = useReducer(reducer, null, () => window.location.hash.slice(1));`;
    expect(findViolations(src)).toHaveLength(1);
  });

  it('does NOT flag a plain default initializer', () => {
    expect(findViolations(`const [tab] = useState('overview');`)).toHaveLength(0);
    expect(findViolations(`const [tab] = useState<string | null>(null);`)).toHaveLength(0);
  });

  it('does NOT flag a pure helper that takes the hash as a parameter', () => {
    const src = `
      function parseTab(hash: string) { return hash || 'overview'; }
      const [tab] = useState(() => parseTab('overview'));
    `;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('does NOT flag hash reads outside useState initializers (effects, handlers)', () => {
    const src = `
      const [tab, setTab] = useState('overview');
      useEffect(() => { setTab(window.location.hash.slice(1)); }, []);
      const onClick = () => { window.location.hash = 'x'; };
    `;
    expect(findViolations(src)).toHaveLength(0);
  });

  it('honours an explicit hash-usestate-exempt marker', () => {
    const src = `
      // hash-usestate-exempt: rendered client-only via client:only
      const [tab] = useState(() => window.location.hash.slice(1));
    `;
    expect(findViolations(src)).toHaveLength(0);
  });
});

// ─── Main guard ─────────────────────────────────────────────────────────────
describe('no location.hash reads in useState initializers (apps/web/src)', () => {
  const files = listSourceFiles(SRC_ROOT);

  it('finds a plausible number of source files to scan (glob is not broken)', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  // The escape hatch is a free-form comment, so — unlike the runAction guard's
  // reviewed allowlist module — nothing would otherwise stop someone silencing a
  // real violation with CI still green. Pin the count at zero: adding the first
  // legitimate exemption must be a deliberate, reviewed bump of this number.
  it('nobody has silenced a violation with hash-usestate-exempt (expected: 0)', () => {
    const exempted = files.filter((file) =>
      /hash-usestate-exempt/i.test(readFileSync(file, 'utf8')),
    );
    expect(exempted).toEqual([]);
  });

  it('every hash-derived initial state goes through useHashState/useHashTab', () => {
    const all: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      // Fast path: skip files that never mention both tokens.
      if (!src.includes('useState') || !LOCATION_HASH_RE.test(src)) continue;
      const rel = file.startsWith(SRC_ROOT) ? 'src' + file.slice(SRC_ROOT.length).split(sep).join('/') : file;
      for (const v of findViolations(src, rel)) {
        all.push(`  ${rel} L${v.line}: ${v.snippet}`);
      }
    }
    expect(
      all,
      all.length
        ? `location.hash read inside a useState initializer (SSR hydration mismatch, #2421):\n` +
            all.join('\n') +
            `\nUse useHashState/useHashTab from src/lib/useHashState.ts instead, or add ` +
            `"// hash-usestate-exempt: <reason>" for a genuinely client-only component.`
        : undefined
    ).toEqual([]);
  });
});
