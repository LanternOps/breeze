/**
 * #11225: `jsonb_build_object('error', ${error})` takes variadic "any", so Postgres
 * cannot infer the bound parameter's type and answers 42P18. The statement fails on
 * every run, which is how marking a restore job failed never worked on these paths.
 * Mocked-Drizzle unit tests cannot see it, and the path only runs after another
 * failure. `caughtQueryServiceRows.integration.test.ts` proves one site on real
 * Postgres; this catches the shape everywhere. Limit: it matches only the literal
 * keys below, so another key with an uncast parameter is not flagged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const UNCAST_PARAM = /'(?:error|reason)',\s*\$\{[A-Za-z_.]+\}(?!::)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The spans of each `jsonb_build_object(...)` call in `text`, nested calls included. */
function buildObjectCalls(text: string): string[] {
  const calls: string[] = [];
  for (const match of text.matchAll(/jsonb_build_object\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') depth -= 1;
      end += 1;
    }
    calls.push(text.slice(start, end));
  }
  return calls;
}

const uncastParams = (text: string): string[] =>
  buildObjectCalls(text).flatMap((call) => call.match(UNCAST_PARAM) ?? []);

describe('jsonb_build_object error parameters carry a cast', () => {
  it('flags the failing shape and passes the cast one', () => {
    expect(uncastParams("jsonb_build_object('error', ${error})")).toHaveLength(1);
    expect(uncastParams("jsonb_build_object('status', 'failed', 'reason', ${reason})")).toHaveLength(1);
    expect(uncastParams("jsonb_build_object('error', ${error}::text)")).toEqual([]);
    expect(uncastParams("{ error: 'x', reason: ${reason} }")).toEqual([]);
  });

  it('finds none in the API source', () => {
    const hits = sourceFiles(SRC).flatMap((file) =>
      uncastParams(readFileSync(file, 'utf8')).map((hit) => `${relative(SRC, file)}: ${hit}`));
    expect(hits).toEqual([]);
  }, 30_000);
});
