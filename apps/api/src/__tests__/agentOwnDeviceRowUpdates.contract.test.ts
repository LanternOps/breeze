/**
 * Contract (#8318 wave 1b, spec §6.4 "Contract test"): every own-row `devices`
 * update on an agent path goes through `updateOwnDeviceRow`
 * (services/agentOwnDeviceRow.ts), which binds the write to the identity the
 * caller authenticated with (`id` AND `agent_id`).
 *
 *  - What it collects: every `update(devices)` call and every raw
 *    `UPDATE devices` SQL string in `apps/api/src` (non-test files).
 *  - Which sites must comply: those in a file reachable through runtime
 *    imports (static, `export … from`, `import()`; never `import type`) from an
 *    agent entry point: `routes/agents/**`, `routes/agentWs.ts`,
 *    `routes/helper/**`, `middleware/agentAuth.ts`.
 *  - When it fails: a site in a reachable file is neither the helper's own
 *    statement nor allow-listed in services/agentOwnDeviceRowAllowlist.ts
 *    (the site carries `// own-device-row-allowlisted: <marker>` and the
 *    allowlist has that marker for that file, with a kind and a reason).
 *    Stale allowlist entries fail too.
 *
 * An AST check in the style of apps/web's no-silent-mutations guard:
 * TypeScript compiler API, call-local, the `devices` table resolved through
 * TypeScript symbols (aliases, the schema barrel's re-export and a local
 * `const t = devices` included), so `import { devices as d }` or a renamed
 * local cannot hide a site and a local variable named `devices` that is not
 * the table cannot create a false one. Raw SQL is read from string and
 * template literals only — a comment mentioning `UPDATE devices` is not a site
 * — and a template that interpolates the table (`UPDATE ${devices} …`) reads
 * as `UPDATE devices`. Imports resolve relative specifiers and the tsconfig
 * `@/` path alias. Every reachable file is analysed (no text prefilter: it
 * could not see an interpolated table or a renamed one).
 *
 * Known residual: a table reaching `update()` through a function parameter
 * or a destructured binding is not followed.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  AGENT_OWN_DEVICE_ROW_ALLOWLIST,
  OWN_DEVICE_ROW_ALLOWLIST_MARKER,
} from '../services/agentOwnDeviceRowAllowlist';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, '../..');
const SRC_ROOT = resolve(API_ROOT, 'src');
const HELPER_FILE = resolve(SRC_ROOT, 'services/agentOwnDeviceRow.ts');
const DEVICES_SCHEMA_FILE = resolve(SRC_ROOT, 'db/schema/devices.ts');
const FIXTURE_ROOT = resolve(__dirname, 'fixtures/agent-own-device-row');

const ENTRY_POINT_DIRS = ['routes/agents', 'routes/helper'];
const ENTRY_POINT_FILES = ['routes/agentWs.ts', 'middleware/agentAuth.ts'];

const RAW_UPDATE_DEVICES = /\bUPDATE\s+(?:public\.)?"?devices"?\b/i;
const MARKER_PATTERN = new RegExp(`${OWN_DEVICE_ROW_ALLOWLIST_MARKER}:\\s*([a-z0-9-]+)`);

// ─── File discovery ────────────────────────────────────────────────────────

function isScannable(file: string): boolean {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return false;
  if (file.endsWith('.test.ts')) return false;
  const rel = relative(SRC_ROOT, file).split(sep).join('/');
  return !rel.startsWith('__tests__/');
}

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (isScannable(full)) out.push(full);
  }
  return out;
}

/** A runtime import's target file: relative specifiers and the tsconfig `@/*` → `src/*` alias. */
function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else if (spec.startsWith('@/')) base = resolve(SRC_ROOT, spec.slice(2));
  else return null;
  const candidates = [base + '.ts', join(base, 'index.ts'), base];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile() && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

const sourceCache = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let sf = sourceCache.get(file);
  if (!sf) {
    sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sourceCache.set(file, sf);
  }
  return sf;
}

/** Runtime imports only: a type-only import loads no code and reaches no site. */
function runtimeImportsOf(file: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveImport(file, node.moduleSpecifier.text);
      if (target) out.push(target);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveImport(file, node.moduleSpecifier.text);
      if (target) out.push(target);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteralLike(node.arguments[0])
    ) {
      const target = resolveImport(file, node.arguments[0].text);
      if (target) out.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  return out;
}

function agentEntryPoints(): string[] {
  const files = ENTRY_POINT_DIRS.flatMap((dir) => listTsFiles(resolve(SRC_ROOT, dir)));
  for (const rel of ENTRY_POINT_FILES) files.push(resolve(SRC_ROOT, rel));
  return files;
}

/** Every file `accept` admits reachable from `entries`, with how it was reached. */
function reachableFrom(entries: string[], accept: (file: string) => boolean): Map<string, string | null> {
  const via = new Map<string, string | null>();
  const stack = entries.map((file) => ({ file, from: null as string | null }));
  while (stack.length > 0) {
    const { file, from } = stack.pop()!;
    if (via.has(file)) continue;
    via.set(file, from);
    for (const dep of runtimeImportsOf(file)) {
      if (!via.has(dep) && accept(dep)) stack.push({ file: dep, from: file });
    }
  }
  return via;
}

/** Every scannable file reachable from an agent entry point, with how it was reached. */
function reachableFromAgentEntryPoints(): Map<string, string | null> {
  return reachableFrom(agentEntryPoints(), isScannable);
}

// ─── Site collection ───────────────────────────────────────────────────────

type Site = {
  file: string;
  line: number;
  kind: 'drizzle' | 'raw_sql';
  snippet: string;
  /** The allowlist marker carried by the statement, if any. */
  marker: string | null;
};

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  let symbol = checker.getSymbolAtLocation(node);
  const seen = new Set<ts.Symbol>();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol);
    const target = checker.getAliasedSymbol(symbol);
    if (target === symbol) break;
    symbol = target;
  }
  return symbol;
}

/** `(x)`, `x as T`, `x satisfies T`, `<T>x`, `x!` → `x`. */
function unwrapExpression(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur)
    || ts.isAsExpression(cur)
    || ts.isSatisfiesExpression(cur)
    || ts.isTypeAssertionExpression(cur)
    || ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Is this expression the `devices` table from db/schema/devices.ts, by symbol?
 * A local variable is followed to its initializer (`const t = devices`), so a
 * renamed table is found and a local merely NAMED `devices` is judged by what
 * it holds, never by its spelling.
 */
function isDevicesTable(expr: ts.Expression, checker: ts.TypeChecker, depth = 0): boolean {
  const unwrapped = unwrapExpression(expr);
  if (!ts.isIdentifier(unwrapped) && !ts.isPropertyAccessExpression(unwrapped)) return false;
  const target = ts.isPropertyAccessExpression(unwrapped) ? unwrapped.name : unwrapped;
  const symbol = resolvedSymbol(target, checker);
  if (!symbol) return false;
  const declarations = symbol.declarations ?? [];
  if (
    symbol.getName() === 'devices'
    && declarations.some((declaration) => resolve(declaration.getSourceFile().fileName) === DEVICES_SCHEMA_FILE)
  ) {
    return true;
  }
  if (depth >= 8) return false;
  return declarations.some(
    (declaration) =>
      ts.isVariableDeclaration(declaration)
      && resolve(declaration.getSourceFile().fileName) !== DEVICES_SCHEMA_FILE
      && declaration.initializer !== undefined
      && isDevicesTable(declaration.initializer, checker, depth + 1),
  );
}

function enclosingStatementFullStart(node: ts.Node): number {
  let cur: ts.Node = node;
  while (
    cur.parent
    && !ts.isBlock(cur.parent)
    && !ts.isSourceFile(cur.parent)
    && !ts.isModuleBlock(cur.parent)
    && !ts.isCaseClause(cur.parent)
    && !ts.isDefaultClause(cur.parent)
  ) {
    cur = cur.parent;
  }
  return cur.getFullStart();
}

/** A marker anywhere from the enclosing statement's leading trivia up to the end of the site node. */
function markerFor(sf: ts.SourceFile, node: ts.Node): string | null {
  const window = sf.text.slice(enclosingStatementFullStart(node), node.getEnd());
  return MARKER_PATTERN.exec(window)?.[1] ?? null;
}

/**
 * The SQL text of a string or template literal. An interpolation of the
 * `devices` table reads as `devices` (drizzle renders it as the table name),
 * any other interpolation as an opaque placeholder.
 */
function literalText(node: ts.Node, checker: ts.TypeChecker): string | null {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans
      .map((span) => (isDevicesTable(span.expression, checker) ? 'devices' : '${…}') + span.literal.text)
      .join('');
  }
  return null;
}

function collectSites(sf: ts.SourceFile, checker: ts.TypeChecker): Site[] {
  const sites: Site[] = [];
  const push = (node: ts.Node, kind: Site['kind']): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    sites.push({
      file: sf.fileName,
      line: line + 1,
      kind,
      snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
      marker: markerFor(sf, node),
    });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'update'
      && node.arguments.length === 1
      && isDevicesTable(node.arguments[0]!, checker)
    ) {
      push(node, 'drizzle');
    } else if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))) {
      const text = literalText(node, checker);
      if (text && RAW_UPDATE_DEVICES.test(text)) push(node, 'raw_sql');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

function programFor(files: string[]): { program: ts.Program; checker: ts.TypeChecker } {
  const configPath = resolve(API_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram({
    rootNames: files,
    options: { ...parsed.options, noEmit: true, skipLibCheck: true, types: [] },
  });
  return { program, checker: program.getTypeChecker() };
}

function sitesIn(files: string[]): Site[] {
  // No text prefilter: `UPDATE ${devices}` and `const t = devices` are only
  // visible to the AST and the checker, so every file goes through them.
  if (files.length === 0) return [];
  const { program, checker } = programFor(files);
  const sites: Site[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`program did not load ${file}`);
    sites.push(...collectSites(sf, checker));
  }
  return sites;
}

function rel(file: string): string {
  return relative(API_ROOT, file).split(sep).join('/');
}

type Verdict = { violations: string[]; usedEntries: Set<string> };

function judge(sites: Site[]): Verdict {
  const violations: string[] = [];
  const usedEntries = new Set<string>();
  for (const site of sites) {
    const file = resolve(site.file);
    if (file === HELPER_FILE) continue; // the helper's own statement
    const relFile = rel(file);
    if (site.marker) {
      const entry = AGENT_OWN_DEVICE_ROW_ALLOWLIST.find((e) => e.file === relFile && e.marker === site.marker);
      if (entry) {
        usedEntries.add(`${entry.file}#${entry.marker}`);
        continue;
      }
      violations.push(
        `${relFile}:${site.line} carries marker "${site.marker}" but services/agentOwnDeviceRowAllowlist.ts has no entry for it in this file`,
      );
      continue;
    }
    violations.push(
      `${relFile}:${site.line} (${site.kind}) updates devices outside updateOwnDeviceRow: ${site.snippet}\n` +
        `    Use updateOwnDeviceRow(exec, agent, set, { where }) (services/agentOwnDeviceRow.ts), or — for a ` +
        `non-agent path or one that carries the agent_id predicate itself — add an entry to ` +
        `services/agentOwnDeviceRowAllowlist.ts and mark the statement with ` +
        `"// ${OWN_DEVICE_ROW_ALLOWLIST_MARKER}: <marker>".`,
    );
  }
  return { violations, usedEntries };
}

// ─── Self-checks: the analyzer bites ───────────────────────────────────────

describe('agent own-device-row contract — self-checks (fixtures)', () => {
  // The fixtures live under src/__tests__/, which the real scan skips on
  // purpose, so they are listed here directly rather than through listTsFiles.
  const fixtureDir = resolve(FIXTURE_ROOT, 'routes/agents');
  const fixtureFiles = readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(fixtureDir, name));
  const fixtureSites = sitesIn(fixtureFiles);

  it('finds the fixtures', () => {
    expect(fixtureFiles.map((f) => f.split(sep).pop()).sort()).toEqual([
      'aliasPathImport.ts',
      'aliasedBareUpdate.ts',
      'bareUpdate.ts',
      'constAliasUpdate.ts',
      'helperUpdate.ts',
      'interpolatedRawUpdate.ts',
      'localDevicesVariable.ts',
    ]);
  });

  it('flags a bare update(devices) in a file that mimics routes/agents/', () => {
    const bare = fixtureSites.filter((s) => s.file.endsWith('bareUpdate.ts'));
    expect(bare).toHaveLength(1);
    expect(judge(bare).violations).toHaveLength(1);
  });

  it('flags an aliased import of the table and a raw UPDATE devices string', () => {
    const aliased = fixtureSites.filter((s) => s.file.endsWith('aliasedBareUpdate.ts'));
    expect(aliased.map((s) => s.kind).sort()).toEqual(['drizzle', 'raw_sql']);
    expect(judge(aliased).violations).toHaveLength(2);
  });

  it('does not flag the helper call (and resolves the aliased schema import without a false site)', () => {
    const compliant = fixtureSites.filter((s) => s.file.endsWith('helperUpdate.ts'));
    expect(compliant).toEqual([]);
  });

  // Review of wave 1b-1: the dodges an AST scan by name or by text would miss.
  it('flags a table renamed through a local (`const t = devices; db.update(t)`)', () => {
    const renamed = fixtureSites.filter((s) => s.file.endsWith('constAliasUpdate.ts'));
    expect(renamed.map((s) => s.kind)).toEqual(['drizzle', 'drizzle']);
    expect(judge(renamed).violations).toHaveLength(2);
  });

  it('flags a raw UPDATE whose table is interpolated (`sql`UPDATE ${devices} …``)', () => {
    const interpolated = fixtureSites.filter((s) => s.file.endsWith('interpolatedRawUpdate.ts'));
    expect(interpolated.map((s) => s.kind)).toEqual(['raw_sql']);
    expect(judge(interpolated).violations).toHaveLength(1);
  });

  it('does not flag a local variable NAMED devices that is not the table (symbol resolution, not name matching)', () => {
    const local = fixtureSites.filter((s) => s.file.endsWith('localDevicesVariable.ts'));
    expect(local).toEqual([]);
  });

  it('follows a runtime import through the tsconfig `@/` alias and flags the site it reaches', () => {
    const entry = join(fixtureDir, 'aliasPathImport.ts');
    const lib = resolve(FIXTURE_ROOT, 'lib/bareViaAliasPath.ts');
    expect(runtimeImportsOf(entry)).toContain(lib);
    const reached = [...reachableFrom([entry], (file) => file.startsWith(FIXTURE_ROOT)).keys()];
    expect(reached).toContain(lib);
    const libSites = sitesIn(reached).filter((s) => resolve(s.file) === lib);
    expect(libSites.map((s) => s.kind)).toEqual(['drizzle']);
    expect(judge(libSites).violations).toHaveLength(1);
  });

  it('counts the helper\'s own update(devices) as the one exempt statement', () => {
    const helperSites = sitesIn([HELPER_FILE]);
    expect(helperSites).toHaveLength(1);
    expect(judge(helperSites).violations).toEqual([]);
  });
});

// ─── The contract over apps/api/src ────────────────────────────────────────

describe('agent own-device-row contract (#8318 §6.4)', () => {
  const reachable = reachableFromAgentEntryPoints();
  const reachableFiles = [...reachable.keys()];
  const sites = sitesIn(reachableFiles);
  const verdict = judge(sites);

  it('reaches the agent entry points and the files the spec names', () => {
    for (const expected of [
      'routes/agentWs.ts',
      'middleware/agentAuth.ts',
      'routes/agents/heartbeat.ts',
      'jobs/offlineDetector.ts',
      'routes/agents/enrollment.ts',
      'services/agentTokenPromotion.ts',
      'services/deviceMtlsCertificateIssuance.ts',
    ]) {
      expect(reachable.has(resolve(SRC_ROOT, expected)), `${expected} should be reachable`).toBe(true);
    }
  });

  it('every update(devices) / raw UPDATE devices on an agent-reachable path is the helper or allow-listed', () => {
    expect(verdict.violations, verdict.violations.join('\n\n')).toEqual([]);
  });

  it('every allowlist entry is used by a marked site in a reachable file (no stale entries)', () => {
    const stale = AGENT_OWN_DEVICE_ROW_ALLOWLIST
      .filter((e) => !verdict.usedEntries.has(`${e.file}#${e.marker}`))
      .map((e) => `${e.file}#${e.marker}`);
    expect(stale).toEqual([]);
  });

  it('allowlist entries are well-formed and unique', () => {
    const keys = new Set<string>();
    for (const entry of AGENT_OWN_DEVICE_ROW_ALLOWLIST) {
      expect(existsSync(resolve(API_ROOT, entry.file)), `${entry.file} exists`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(['non_agent_path', 'agent_path_inline_predicate']).toContain(entry.kind);
      const key = `${entry.file}#${entry.marker}`;
      expect(keys.has(key), `duplicate allowlist entry ${key}`).toBe(false);
      keys.add(key);
    }
  });

  it('the two inline-predicate exceptions really carry an agent_id predicate', () => {
    for (const entry of AGENT_OWN_DEVICE_ROW_ALLOWLIST.filter((e) => e.kind === 'agent_path_inline_predicate')) {
      const text = readFileSync(resolve(API_ROOT, entry.file), 'utf8');
      const markerAt = text.indexOf(`${OWN_DEVICE_ROW_ALLOWLIST_MARKER}: ${entry.marker}`);
      expect(markerAt, `${entry.file} carries marker ${entry.marker}`).toBeGreaterThan(-1);
      const after = text.slice(markerAt, markerAt + 4000);
      expect(after, `${entry.file}#${entry.marker} filters on devices.agentId`).toMatch(/eq\(devices\.agentId,/);
    }
  });
});
