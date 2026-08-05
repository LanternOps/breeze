/**
 * Guard: nothing in apps/web/src may compare a value against a TRANSLATED
 * string.
 *
 * An i18n codemod rewrote a number of discriminator comparisons from a machine
 * literal to a catalog lookup — `modalMode === "delete"` became
 * `modalMode === i18n.t("…configurationPoliciesPage.delete")`. These survived
 * review and CI because the `en` catalog happened to store the machine value
 * verbatim ("delete", "overview", "create"), so every such comparison is TRUE
 * in English and FALSE in every locale that actually translated the entry.
 *
 * The failure is always silent and always locale-specific:
 *   - #2950: the config-policy delete confirmation modal never rendered under
 *     fr/de/es/pt — the row's Delete button did nothing at all.
 *   - ConfigPolicyDetailPage: the Overview and Assignments tab bodies rendered
 *     empty under fr-FR/fr-CA/de-DE/es-419.
 *   - ComplianceDashboard: the edit form loaded blank defaults instead of the
 *     selected policy, and the partner-wide ownerScope selector never appeared.
 *
 * A per-file version of this check already existed for the config-policy
 * feature tabs (featureTabs/structuralValues.test.ts) but (a) ran over a
 * hand-maintained file list that none of the above were on, and (b) required a
 * `.property` on the left-hand side, so a bare identifier like `modalMode` or
 * `activeTab` slipped through. This one is repo-wide over apps/web/src and
 * matches bare identifiers too.
 *
 * If you are here because this test failed: compare against the machine literal
 * the value actually holds (the union member / enum / DOM key), and use i18n
 * only for what you RENDER.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', 'locales']);

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectSources(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    // Test files legitimately mention the pattern when asserting on it.
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const sources = collectSources(SRC_ROOT);

// An operand, then an equality operator, then a translation lookup — with the
// line breaks Prettier introduces between them tolerated via /g+/s over the
// whole file rather than a line window.
//
// The left operand may be a bare identifier (`modalMode`), a member expression
// (`condition.type`), a string, or a call/index result, so it is matched as a
// single trailing character class rather than `\.\w+` — requiring a `.property`
// is precisely why the old featureTabs guard missed `modalMode === …`.
//
// The lookup is `i18n.t(` or a bare `t(`. The negative lookbehind on the bare
// form is load-bearing: without it `t(` matches the tail of every identifier
// ending in "t" — `useEffect(`, `parseInt(`, `.split(` — which floods the
// report with false positives.
const TRANSLATED_COMPARISON =
  /[\w$\])'"`]\s*[=!]==?\s*(?:i18n\s*\.\s*t\s*\(|(?<![\w$.])t\s*\()/gs;

/** Byte offset -> 1-based line number. */
function lineAt(src: string, offset: number): number {
  return src.slice(0, offset).split('\n').length;
}

/**
 * Blank out comment bodies, preserving every newline so offsets and line
 * numbers are unchanged.
 *
 * Prose describing this bug class necessarily quotes its code shape, and a
 * comment is not the bug. Testing whether the matched LINE starts with `*` or
 * `//` is not enough: `{/* … *\/}` JSX comments and non-JSDoc block comments
 * have unprefixed continuation lines, so the guard would fail on a wrapped
 * sentence and report "compared against a translated string" pointing at a
 * comment — a confusing red on main for someone who changed no code.
 *
 * Deliberately naive: a `//` inside a string literal (a URL) also gets blanked,
 * which can only ever hide a real hit later on that same line. Erring toward a
 * false negative is right here — a false positive reds main.
 */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

describe('no equality comparison against a translated string', () => {
  it('scans a non-trivial number of web sources', () => {
    // Cheap canary: a broken walker that returns [] would make the assertion
    // below vacuously pass.
    expect(sources.length).toBeGreaterThan(500);
  });

  it('matches the shape it is meant to catch, and not ordinary calls', () => {
    const positive = [
      'modalMode === i18n.t("ns.delete")',
      'activeTab ===\n        i18n.t(\n          "ns.overview2",\n        )',
      'condition.type === t("ns.cpu")',
      "e.key !== i18n.t('ns.enter')",
    ];
    const negative = [
      "typeof window === 'undefined'",
      'useEffect(() => {',
      'const n = parseInt(raw, 10);',
      'const label = i18n.t("ns.delete");',
      'if (parts.length === 2) return;',
    ];
    for (const src of positive) {
      expect(new RegExp(TRANSLATED_COMPARISON.source, 's').test(src), src).toBe(true);
    }
    for (const src of negative) {
      expect(new RegExp(TRANSLATED_COMPARISON.source, 's').test(src), src).toBe(false);
    }
  });

  it('does not fire on prose that quotes the bug shape in a comment', () => {
    // A guard that reds main when someone DOCUMENTS the bug is worse than no
    // guard — it silently constrains prose instead of code. All four shapes
    // below matched before stripComments() replaced the line-prefix heuristic.
    const commentary = [
      '// modalMode === i18n.t("ns.delete") was the bug',
      '/* mode === i18n.t("ns.audit") is wrong */',
      '{/*\n  codemod turned this into `modalMode === i18n.t(".delete")`, which\n  only ever matched under en.\n*/}',
      '/**\n * The gate compared activeTab === i18n.t("ns.overview2").\n */',
    ];
    const re = new RegExp(TRANSLATED_COMPARISON.source, 'gs');
    for (const src of commentary) {
      expect(re.test(src), `raw: ${src}`).toBe(true); // the shape IS present…
      re.lastIndex = 0;
      expect(re.test(stripComments(src)), `stripped: ${src}`).toBe(false); // …but only in a comment
      re.lastIndex = 0;
    }
    // Real code on the line after a comment is still caught.
    expect(
      re.test(stripComments('// see below\nif (modalMode === i18n.t("ns.delete")) {}')),
    ).toBe(true);
  });

  it('finds no value compared against an i18n lookup', () => {
    const offenders: string[] = [];

    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      const scannable = stripComments(src);
      const lines = src.split('\n');
      const re = new RegExp(TRANSLATED_COMPARISON.source, 'gs');
      let match: RegExpExecArray | null;
      while ((match = re.exec(scannable)) !== null) {
        const line = lineAt(scannable, match.index);
        offenders.push(`${relative(SRC_ROOT, file)}:${line}: ${(lines[line - 1] ?? '').trim()}`);
      }
    }

    expect(
      offenders,
      offenders.length
        ? 'Value(s) compared against a translated string — these are TRUE only in ' +
            'English and silently FALSE in every translated locale:\n' +
            offenders.map((o) => `  ${o}`).join('\n') +
            '\nCompare against the machine literal instead; translate only what you render.'
        : undefined,
    ).toEqual([]);
  });
});
