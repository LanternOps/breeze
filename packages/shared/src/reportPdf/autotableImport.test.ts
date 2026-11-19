import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `jspdf-autotable` must be imported by its NAMED export, never its default.
//
// @breeze/shared is `"type": "module"`, so when tsup bundles it into the API's
// CommonJS `dist/index.cjs`, esbuild emits `__toESM(require('jspdf-autotable'),
// 1)` — Node-mode interop — which sets `.default` to the whole module object
// rather than the function the package's CJS build exports as `exports.default`.
// Every `autoTable(doc, …)` call on the server then throws
// `(0, import_jspdf_autotable.default) is not a function` (portal report PDF
// downloads returned 500 on prod, 2026-11-05). Vitest and Vite resolve the
// package's ESM entry, so no unit or browser test sees the breakage — only the
// shipped bundle does. The named `autoTable` export is a function under both
// module systems.
describe('jspdf-autotable import style', () => {
  it('uses the named export in every reportPdf source file', () => {
    const dir = __dirname;
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /^import\s+autoTable[\s,]/m.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
