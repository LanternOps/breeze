import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import ts from 'typescript';
import { stripComments } from './routeScan';

/**
 * Guard for {@link stripComments} (#4019).
 *
 * Every site-scope detector now reads COMMENT-STRIPPED source, so the
 * stripper sits underneath the whole scanner: if it ever removed real code,
 * a gate reference or a device-table predicate would vanish and the affected
 * detector would answer `false` — silently, and in the unsafe direction. The
 * stripper is hand-rolled (a parser would be far heavier than the scan it
 * feeds), and its risky cases are exactly the ones a regex stripper gets
 * wrong: a `/` that opens a regex literal vs. one that divides, an unescaped
 * `/` inside a regex character class, a `//` inside a string or a URL, and
 * `${...}` interpolations nested in template literals.
 *
 * The inline fixtures in `routeScan.test.ts` pin those cases individually.
 * This guard proves the property over the REAL corpus the scanner runs on:
 * for every file under `src/routes/`, the stripped text must tokenize to the
 * exact same non-comment token stream as the raw text. That is the precise
 * contract — "only comments were removed" — and it catches an over-strip
 * anywhere in ~500 route files, including shapes nobody thought to fixture.
 */

const ROUTE_DIR = path.resolve(__dirname, '../../routes');

/** One read + one strip per file, shared by both cases below. Parsing ~500
 *  route files twice is the expensive part of this guard; doing the I/O and
 *  the strip once keeps a loaded CI runner inside the timeout. */
type CorpusEntry = { rel: string; raw: string; stripped: string };
let corpusPromise: Promise<CorpusEntry[]> | null = null;

function loadCorpus(): Promise<CorpusEntry[]> {
  corpusPromise ??= (async () => {
    const files = await listTsFiles(ROUTE_DIR);
    return Promise.all(
      files.map(async (file) => {
        const raw = await fs.readFile(file, 'utf8');
        return { rel: path.relative(ROUTE_DIR, file), raw, stripped: stripComments(raw) };
      }),
    );
  })();
  return corpusPromise;
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Leaf-token stream of `text` as the TypeScript PARSER sees it, comments and
 * trivia excluded. The full parser (not the raw scanner) is used on purpose:
 * only the parser knows whether a `/` opens a regex literal or divides, and
 * how a `}` resumes a template literal after a `${...}` interpolation — the
 * exact constructs the stripper has to get right. A hand-rolled comparator
 * would mis-tokenize those and report the STRIPPER as broken.
 */
function codeTokens(text: string): string[] {
  const sf = ts.createSourceFile(
    'file.ts',
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const tokens: string[] = [];
  const walk = (node: ts.Node): void => {
    // `getChildren()` hangs parsed JSDoc nodes off their owner, so the raw
    // source would carry its doc-comment prose into the token stream while the
    // stripped source (correctly) has none. Skip the whole JSDoc subtree.
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = node.getChildren(sf);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      tokens.push(`${node.kind}:${node.getText(sf)}`);
      return;
    }
    for (const child of children) walk(child);
  };
  walk(sf);
  return tokens;
}

describe('stripComments — corpus parse guard (#4019)', () => {
  // Two TypeScript parses per file over the whole `routes/` tree: fast locally
  // (~2s) but comfortably past vitest's 5s default on a loaded CI runner, which
  // is what this generous timeout is for — a timeout here is a red required
  // job, not a skipped assertion.
  it(
    'removes ONLY comments from every file under src/routes',
    async () => {
      const corpus = await loadCorpus();
      // A zero-file — or quietly shrunken — scan would make this suite
      // vacuously green (the same failure mode the site-scope suite guards
      // against for its own corpus). The real corpus is ~500 files; the floor
      // tracks it closely enough that a broken recursive walk that silently
      // drops a subtree fails here instead of passing on a rump.
      expect(corpus.length).toBeGreaterThan(400);

      const damaged: string[] = [];
      for (const { rel, raw, stripped } of corpus) {
        const rawTokens = codeTokens(raw);
        const strippedTokens = codeTokens(stripped);
        if (rawTokens.length !== strippedTokens.length) {
          damaged.push(
            `${rel}: ${rawTokens.length} code tokens raw vs ${strippedTokens.length} stripped`,
          );
          continue;
        }
        const firstDiff = rawTokens.findIndex((t, i) => t !== strippedTokens[i]);
        if (firstDiff !== -1) {
          damaged.push(
            `${rel}: token ${firstDiff} is ${JSON.stringify(rawTokens[firstDiff])} raw but ` +
              `${JSON.stringify(strippedTokens[firstDiff])} stripped`,
          );
        }
      }

      expect(
        damaged,
        `\nstripComments() altered non-comment code in ${damaged.length} route file(s). ` +
          `Every site-scope detector reads the stripped text, so a removed token is a ` +
          `detector that silently answers "false":\n${damaged.join('\n')}`,
      ).toEqual([]);
    },
    120_000,
  );

  it('keeps every line number stable across the corpus', async () => {
    // The scanner reports `route.line` from the STRIPPED text, so a stripper
    // that dropped a newline would misreport every line below it and send
    // reviewers to the wrong handler.
    const corpus = await loadCorpus();
    const shifted = corpus
      .filter(({ raw, stripped }) => raw.split('\n').length !== stripped.split('\n').length)
      .map(({ rel, raw, stripped }) =>
        `${rel}: ${raw.split('\n').length} -> ${stripped.split('\n').length}`,
      );
    expect(shifted, `\nLine count changed:\n${shifted.join('\n')}`).toEqual([]);
  }, 120_000);
});
