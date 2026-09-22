/**
 * Recipe Library spec §6.1: "Recipes stay pure: no I/O, no imports from
 * services."
 *
 * This is the guard for that sentence, and it is mechanical on purpose. The
 * registry's value to a reviewer is that reading ONE file tells you everything
 * a workflow may do; a recipe that could reach `../../db` could observe or
 * mutate tenant state while still presenting itself as a pure validator, and
 * nothing in a diff review reliably catches an added import (CLAUDE.md's
 * cascade-list history: review 0/5, contract tests 5/5).
 *
 * ALLOWED, and nothing else:
 *  - `zod`                — schema declarations, no I/O.
 *  - `@breeze/shared`     — pure types and validators; cannot import apps/api.
 *  - `../operationKey`    — a pure string builder. Recipes MUST delegate to it
 *                           rather than formatting their own key, because two
 *                           formatters eventually disagree and the failure mode
 *                           of disagreeing is a DUPLICATE operation row for one
 *                           real-world effect.
 *  - `./<sibling>`        — any other file inside `recipes/`.
 *
 * The extractor throws when it finds no files or no imports, so a directory
 * move cannot make this suite vacuously green.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RECIPES_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Exactly the non-sibling module specifiers a recipe file may import. */
const ALLOWED_EXTERNAL_IMPORTS: ReadonlySet<string> = new Set([
  'zod',
  '@breeze/shared',
  '../operationKey',
]);

function recipeSourceFiles(): string[] {
  const files = readdirSync(RECIPES_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
  if (files.length === 0) {
    throw new Error(`purity guard found no recipe source files in ${RECIPES_DIR} — the directory moved; fix this test`);
  }
  return files;
}

/** Every module specifier of a static `import`/`export … from` or a dynamic `import()`. */
function importSpecifiers(source: string): string[] {
  const statics = Array.from(
    source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g),
    (m) => m[1]!,
  );
  const bareSideEffect = Array.from(source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g), (m) => m[1]!);
  const dynamic = Array.from(source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g), (m) => m[1]!);
  const required = Array.from(source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g), (m) => m[1]!);
  return [...statics, ...bareSideEffect, ...dynamic, ...required];
}

describe('recipes/ purity (Recipe Library spec §6.1)', () => {
  const files = recipeSourceFiles();

  it('finds the recipe source files it is supposed to be guarding', () => {
    expect(files).toContain('serviceRecovery.ts');
    expect(files).toContain('index.ts');
    expect(files).toContain('types.ts');
    expect(files).toContain('validateNextStep.ts');
  });

  it.each(files)('%s imports only zod, @breeze/shared, ../operationKey, or a recipes/ sibling', (file) => {
    const specifiers = importSpecifiers(readFileSync(join(RECIPES_DIR, file), 'utf8'));
    const forbidden = specifiers
      .filter((s) => !s.startsWith('./'))
      .filter((s) => !ALLOWED_EXTERNAL_IMPORTS.has(s))
      .sort();
    expect(
      forbidden,
      `${file} imports modules a recipe may not reach. A recipe is DATA plus pure validators and owns NO I/O `
        + '(spec §6.1). Move whatever needs this import into taskCoordinator.ts, which is where step EXECUTION lives.',
    ).toEqual([]);
  });

  it('the extractor actually sees imports (a silent regex break would pass every file)', () => {
    const specifiers = importSpecifiers(readFileSync(join(RECIPES_DIR, 'serviceRecovery.ts'), 'utf8'));
    expect(specifiers).toContain('zod');
    expect(specifiers).toContain('@breeze/shared');
    expect(specifiers).toContain('../operationKey');
  });
});
