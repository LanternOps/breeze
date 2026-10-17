import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Monaco's structural stylesheet (editor.main.css) is injected by the AMD
// loader as a runtime <link> exactly once per page session. Astro's
// ClientRouter rebuilds <head> on every View-Transition swap and the loader
// singleton never re-injects it, so any Monaco consumer that does not ship the
// stylesheet in its own static CSS renders a mangled editor (no gutter, text
// offset, stray scrollbar artefacts) after SPA navigation — the approvals
// script-proposal card regressed this way while ScriptForm, which bundled the
// CSS, kept working. The import lives in lib/monacoLoader.ts so every editor
// that goes through configureMonacoLoader() gets it; this test keeps future
// consumers on that path.
const SRC = join(__dirname, '..');
const CSS_IMPORT = "import 'monaco-editor/min/vs/editor/editor.main.css';";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('Monaco structural CSS', () => {
  it('lib/monacoLoader.ts bundles editor.main.css', () => {
    expect(readFileSync(join(SRC, 'lib/monacoLoader.ts'), 'utf8')).toContain(CSS_IMPORT);
  });

  it('every runtime @monaco-editor/react consumer goes through lib/monacoLoader', () => {
    // `import type { EditorProps } from '@monaco-editor/react'` is erased at
    // build time and never mounts an editor, so only runtime imports count.
    const runtimeImport = /^\s*import\s+(?!type\b)[^;]*from\s+['"]@monaco-editor\/react['"]|import\(\s*['"]@monaco-editor\/react['"]\s*\)/m;
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('lib/monacoLoader.ts'))
      .filter((f) => runtimeImport.test(readFileSync(f, 'utf8')))
      .filter((f) => !readFileSync(f, 'utf8').includes('@/lib/monacoLoader'))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
