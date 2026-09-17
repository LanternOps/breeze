// apps/web/src/lib/__tests__/network-asset-single-writer.test.ts
/**
 * Guard (spec §10, D7): `networkDevice/settings/useNetworkAssetMutations.ts` is
 * the ONLY module in apps/web that mutates a discovered network asset.
 *
 * Before W04 four surfaces wrote the same asset with four different idioms, and
 * two of them (AssetDetailModal's save, AssetMonitoringSection's disable) failed
 * into an inline banner nobody scrolled to. Concentrating the writes is the fix;
 * this test is what keeps them concentrated.
 *
 * It is an AST check (TypeScript compiler API) over every .ts/.tsx under
 * apps/web/src: find each `fetchWithAuth(...)` call, reduce its URL argument to
 * a shape (`${…}` → `*`), and flag a mutating call against a guarded shape from
 * any file other than the writer.
 *
 * Deliberately OUT of scope, with reasons:
 *  - `/discovery/assets/bulk-approve` | `/bulk-dismiss` — list-level triage that
 *    spec §10 leaves on the Discovery rows and bulk bar.
 *  - `/monitors`, `/monitors/:id` — the generic monitor surface owned by
 *    CreateMonitorForm / NetworkMonitorList / MonitorDetailModal. Spec §10 tells
 *    the settings modal to reuse CreateMonitorForm for Add, so a blanket ban
 *    would contradict the spec. The writer still exposes createCheck/deleteCheck
 *    so the modal has one typed path.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(__dirname, '../..'); // apps/web/src

/** The one module allowed to mutate the guarded endpoints. */
const WRITER = join('components', 'devices', 'networkDevice', 'settings', 'useNetworkAssetMutations.ts');

/**
 * URL shapes (interpolations collapsed to `*`, query string dropped) that only
 * the writer may mutate, with the methods that count as a mutation there.
 */
const GUARDED: ReadonlyArray<{ shape: string; methods: readonly string[] }> = [
  { shape: '/discovery/assets/*', methods: ['PATCH', 'DELETE'] },
  { shape: '/discovery/assets/*/approve', methods: ['PATCH', 'POST'] },
  { shape: '/discovery/assets/*/dismiss', methods: ['PATCH', 'POST'] },
  { shape: '/discovery/assets/*/link', methods: ['POST', 'DELETE', 'PATCH'] },
  { shape: '/monitoring/assets/*', methods: ['DELETE', 'PATCH', 'PUT', 'POST'] },
  { shape: '/monitoring/assets/*/snmp', methods: ['PUT', 'PATCH', 'POST', 'DELETE'] },
];

const SKIP_DIRS = new Set(['node_modules', '__mocks__', 'dist', '.astro']);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) collectSourceFiles(full, out);
      continue;
    }
    if (['.ts', '.tsx'].includes(extname(entry)) && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** `/discovery/assets/${id}/link?x=1` → `/discovery/assets/*\/link`. */
function urlShape(node: ts.Expression): string | null {
  let raw: string | null = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    raw = node.text;
  } else if (ts.isTemplateExpression(node)) {
    raw = node.head.text + node.templateSpans.map((s) => `*${s.literal.text}`).join('');
  }
  if (raw === null) return null;
  return raw.split('?')[0]!.replace(/\/+$/, '');
}

/**
 * The HTTP method a `fetchWithAuth` call uses.
 *   - one argument, or an options object with no `method`  → 'GET' (the default)
 *   - a string-literal `method`                            → that verb
 *   - anything else (spread, identifier, conditional)      → 'UNKNOWN' (mutating)
 */
function methodOf(call: ts.CallExpression): string {
  const options = call.arguments[1];
  if (!options) return 'GET';
  if (!ts.isObjectLiteralExpression(options)) return 'UNKNOWN';
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop)) return 'UNKNOWN';
    const name = (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) ? prop.name : undefined;
    if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name)) || name.text !== 'method') continue;
    if (ts.isShorthandPropertyAssignment(prop)) return 'UNKNOWN';
    const value = (prop as ts.PropertyAssignment).initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text.toUpperCase();
    return 'UNKNOWN';
  }
  return 'GET';
}

type Violation = { line: number; shape: string; method: string };

export function findAssetWrites(source: string, fileName = 'x.tsx'): Violation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: Violation[] = [];
  const fetchNames = new Set(['fetchWithAuth']);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(?:^|\/)stores\/auth$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      if ((binding.propertyName ?? binding.name).text === 'fetchWithAuth') fetchNames.add(binding.name.text);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && fetchNames.has(node.expression.text)) {
      const shape = node.arguments[0] ? urlShape(node.arguments[0]) : null;
      if (shape) {
        const guard = GUARDED.find((g) => g.shape === shape);
        const method = methodOf(node);
        if (guard && (method === 'UNKNOWN' || guard.methods.includes(method))) {
          violations.push({
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
            shape,
            method,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

describe('guard self-checks', () => {
  it('flags an aliased import of fetchWithAuth', () => {
    for (const module of ['@/stores/auth', '../../stores/auth']) {
      expect(findAssetWrites(`import { fetchWithAuth as request } from '${module}';
        request(\`/discovery/assets/\${id}\`, { method: 'PATCH' });`)).toHaveLength(1);
    }
  });

  it.todo('string-concat and variable URLs are not resolved');

  it('flags a mutating call against a guarded shape', () => {
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`, { method: 'PATCH' });")).toHaveLength(1);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}/snmp`, { method: 'PUT' });")).toHaveLength(1);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}`, { method: 'DELETE' });")).toHaveLength(1);
  });

  it('does NOT flag reads of the same URLs', () => {
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`);")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}`, { headers: h });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/discovery/assets/${id}`, { method: 'GET' });")).toHaveLength(0);
  });

  it('treats a non-literal method as a mutation (conservative)', () => {
    expect(findAssetWrites('fetchWithAuth(`/discovery/assets/${id}`, { method: m });')).toHaveLength(1);
    expect(findAssetWrites('fetchWithAuth(`/discovery/assets/${id}`, { ...init });')).toHaveLength(1);
  });

  it('ignores the out-of-scope endpoints by design', () => {
    expect(findAssetWrites("fetchWithAuth('/discovery/assets/bulk-approve', { method: 'POST' });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth('/monitors', { method: 'POST' });")).toHaveLength(0);
    expect(findAssetWrites("fetchWithAuth(`/monitors/${id}`, { method: 'DELETE' });")).toHaveLength(0);
  });

  it('drops a query string before matching', () => {
    expect(findAssetWrites("fetchWithAuth(`/monitoring/assets/${id}?orgId=1`, { method: 'DELETE' });")).toHaveLength(1);
  });
});

describe('network asset single writer', () => {
  const files = collectSourceFiles(SRC_ROOT);

  it('finds the writer module', () => {
    expect(files.some((f) => relative(SRC_ROOT, f) === WRITER)).toBe(true);
  });

  it('the writer actually covers every guarded shape (no vacuous pass)', () => {
    const source = readFileSync(join(SRC_ROOT, WRITER), 'utf8');
    const covered = new Set(findAssetWrites(source, WRITER).map((v) => v.shape));
    expect([...covered].sort()).toEqual(GUARDED.map((g) => g.shape).sort());
  });

  it('no other module mutates an asset-scoped endpoint', () => {
    const offenders = files
      .filter((f) => relative(SRC_ROOT, f) !== WRITER)
      .flatMap((f) => {
        const rel = relative(SRC_ROOT, f).split(sep).join('/');
        return findAssetWrites(readFileSync(f, 'utf8'), rel).map((v) => `${rel}:${v.line} ${v.method} ${v.shape}`);
      })
      .sort();

    expect(
      offenders,
      offenders.length
        ? `These modules write a network asset directly:\n  ${offenders.join('\n  ')}\n` +
            `Route them through useNetworkAssetMutations() (spec §10, D7).`
        : undefined,
    ).toEqual([]);
  });
});
