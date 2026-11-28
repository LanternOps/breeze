/**
 * Server child processes get an explicit environment.
 *
 * Node's `child_process` launchers hand the child a copy of `process.env` unless
 * the call passes `env`. On the API that copy holds the database URL, signing and
 * encryption keys and provider credentials, none of which a subprocess needs. So
 * every launch in server code must pass an `env` built from a short allowlist,
 * and must not pass `process.env` itself or spread it.
 *
 * Good examples to copy:
 *   - apps/api/src/services/yaraPrecheck.ts (`env: { PATH: process.env.PATH ?? '' }`)
 *   - apps/api/src/services/workspace/fakeSandboxBackend.ts (`childEnv()`)
 *   - apps/api/src/services/aiModels/sdkChildEnv.ts (allowlist builder for the
 *     Agent SDK child)
 *
 * What the scan sees: `spawn`, `spawnSync`, `exec`, `execSync`, `execFile`,
 * `execFileSync` and `fork` from `child_process` / `node:child_process`, imported
 * by name (aliases included), through a namespace or default import, through
 * `require`, or wrapped with `promisify` / `util.promisify`. The options argument
 * must be an object literal written at the call, so the `env` property can be
 * read. Any other use of a launcher (passed as a value, reassigned) is reported
 * too, since the scan cannot follow it.
 *
 * Known limits: a dynamic `import('node:child_process')` is not followed, and
 * `env: someVariable` is trusted as explicit without checking what it holds.
 *
 * Sites are keyed by file, enclosing function, launcher and first argument, not by
 * line number, so unrelated edits do not move them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Server code that runs with the API's environment. The M365 executors are not
 * scanned: test-api does not run on executor-only changes (see
 * .github/scripts/classify-pr-paths.sh), and they launch no child processes today.
 */
const SCAN_ROOTS = ['apps/api/src', 'ee'];

/**
 * Existing call sites that inherit the environment. This list may only shrink: an
 * entry that no longer matches a flagged site fails the test, so delete it.
 */
const KNOWN_INHERITING_SITES: ReadonlyArray<{ site: string; reason: string }> = [
  {
    site: "apps/api/src/services/aiPatchTestRunner.ts > runOnVm > execFileAsync('ssh')",
    reason: 'fixed argv; allowlist env in follow-up',
  },
  {
    site: "apps/api/src/services/recoveryMediaService.ts > createBundleArchive > execFileAsync('tar')",
    reason: 'fixed argv; allowlist env in follow-up',
  },
  {
    site: 'apps/api/src/services/recoverySigning.ts > signRecoveryArtifact > execFileAsync(minisignBinary)',
    reason: 'fixed argv; allowlist env in follow-up',
  },
];

const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const LAUNCHERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
/** Launchers whose options are the second argument; the rest take (file, args?, options?). */
const OPTIONS_SECOND = new Set(['exec', 'execSync']);

export type LaunchProblem = 'no_env' | 'inherits_process_env' | 'options_not_inline' | 'untracked_use';
export interface LaunchSite {
  site: string;
  problem: LaunchProblem | null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
    || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

function isProcessEnv(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'process'
    && node.name.text === 'env';
}

/** True when `process.env` appears whole (not as `process.env.X` / `process.env['X']`). */
function usesWholeProcessEnv(expr: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isProcessEnv(node)) {
      const parent = node.parent;
      const memberRead = parent
        && ((ts.isPropertyAccessExpression(parent) && parent.expression === node)
          || (ts.isElementAccessExpression(parent) && parent.expression === node));
      if (!memberRead) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

function isRequireOfChildProcess(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const expr = unwrap(node);
  return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'require'
    && expr.arguments.length === 1 && ts.isStringLiteralLike(expr.arguments[0]!)
    && CHILD_PROCESS_MODULES.has(expr.arguments[0].text);
}

function enclosingName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur)) && cur.name) {
      return cur.name.getText();
    }
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) {
      const p = cur.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (p && ts.isPropertyAssignment(p)) return p.name.getText();
    }
  }
  return '<module>';
}

function snippet(node: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!node) return '';
  const text = node.getText(sf).replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** Classify one launch call from its options argument. */
function classifyCall(call: ts.CallExpression, launcher: string): LaunchProblem | null {
  const args = call.arguments.slice(1).map(unwrap);
  const options = args.find((a) => ts.isObjectLiteralExpression(a)) as ts.ObjectLiteralExpression | undefined;
  if (!options) {
    const optionsIndex = OPTIONS_SECOND.has(launcher) ? 1 : 2;
    const candidate = call.arguments[optionsIndex] ? unwrap(call.arguments[optionsIndex]!) : undefined;
    const isCallback = candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate));
    if (candidate && !isCallback) return usesWholeProcessEnv(candidate) ? 'inherits_process_env' : 'options_not_inline';
    return 'no_env';
  }
  let envValue: ts.Expression | undefined;
  for (const prop of options.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'env') envValue = prop.initializer;
    else if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === 'env') envValue = prop.name;
    else if (ts.isSpreadAssignment(prop) && usesWholeProcessEnv(prop.expression)) return 'inherits_process_env';
  }
  if (!envValue) {
    // `{ ...opts }` may carry an env the scan cannot see.
    return options.properties.some((p) => ts.isSpreadAssignment(p)) ? 'options_not_inline' : 'no_env';
  }
  return usesWholeProcessEnv(envValue) ? 'inherits_process_env' : null;
}

export function findChildProcessLaunches(path: string, text: string): LaunchSite[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  /** local identifier -> launcher name */
  const launcherNames = new Map<string, string>();
  /** local identifiers bound to the whole module */
  const moduleNames = new Set<string>();
  const declarationIds = new Set<ts.Node>();

  // Pass 1: bindings.
  const bind = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && CHILD_PROCESS_MODULES.has(node.moduleSpecifier.text) && node.importClause && !node.importClause.isTypeOnly) {
      const clause = node.importClause;
      if (clause.name) { moduleNames.add(clause.name.text); declarationIds.add(clause.name); }
      const nb = clause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) { moduleNames.add(nb.name.text); declarationIds.add(nb.name); }
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && LAUNCHERS.has(imported)) { launcherNames.set(el.name.text, imported); declarationIds.add(el.name); }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && isRequireOfChildProcess(node.initializer)) {
      if (ts.isIdentifier(node.name)) { moduleNames.add(node.name.text); declarationIds.add(node.name); }
      if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const imported = el.propertyName ? el.propertyName.getText() : el.name.getText();
          if (LAUNCHERS.has(imported) && ts.isIdentifier(el.name)) { launcherNames.set(el.name.text, imported); declarationIds.add(el.name); }
        }
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  if (launcherNames.size === 0 && moduleNames.size === 0) return [];

  /** `spawn` / `cp.spawn` -> launcher name, else undefined. */
  const launcherOf = (expr: ts.Expression): string | undefined => {
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) return launcherNames.get(e.text);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
      && moduleNames.has(e.expression.text) && LAUNCHERS.has(e.name.text)) return e.name.text;
    return undefined;
  };
  const isPromisify = (call: ts.CallExpression): boolean => {
    const callee = unwrap(call.expression);
    return (ts.isIdentifier(callee) && callee.text === 'promisify')
      || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify');
  };

  // Pass 1b: `const execFileAsync = promisify(execFile)`.
  const bindWrappers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isCallExpression(init) && isPromisify(init) && init.arguments[0]) {
        const launcher = launcherOf(init.arguments[0]);
        if (launcher) { launcherNames.set(node.name.text, launcher); declarationIds.add(node.name); }
      }
    }
    ts.forEachChild(node, bindWrappers);
  };
  bindWrappers(sf);

  const rel = path.split(sep).join('/');
  const sites: LaunchSite[] = [];
  const seen = new Map<string, number>();
  const push = (key: string, problem: LaunchProblem | null): void => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    sites.push({ site: n === 1 ? key : `${key} #${n}`, problem });
  };
  const handled = new Set<ts.Node>();

  // Pass 2: calls, then any other reference to a launcher.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const launcher = launcherOf(callee);
      if (launcher) {
        handled.add(ts.isPropertyAccessExpression(callee) ? callee.expression : callee);
        push(`${rel} > ${enclosingName(node)} > ${callee.getText(sf)}(${snippet(node.arguments[0], sf)})`,
          classifyCall(node, launcher));
      } else if (isPromisify(node) && node.arguments[0] && launcherOf(node.arguments[0])) {
        const arg = unwrap(node.arguments[0]);
        handled.add(ts.isPropertyAccessExpression(arg) ? arg.expression : arg);
      }
    }
    if (ts.isIdentifier(node) && !handled.has(node) && !declarationIds.has(node)
      && (launcherNames.has(node.text) || moduleNames.has(node.text))) {
      const parent = node.parent;
      const isPropertyName = parent && ts.isPropertyAccessExpression(parent) && parent.name === node;
      const inTypePosition = ts.findAncestor(node, (a) => ts.isTypeNode(a)) !== undefined;
      // `cp.someNonLauncher` (e.g. `cp.ChildProcess`) is not a launch.
      const nonLauncherMember = moduleNames.has(node.text) && parent && ts.isPropertyAccessExpression(parent)
        && parent.expression === node && !LAUNCHERS.has(parent.name.text);
      if (!isPropertyName && !inTypePosition && !nonLauncherMember) {
        push(`${rel} > ${enclosingName(node)} > ${node.text} (untracked use)`, 'untracked_use');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__tests__', '__fixtures__', '__mocks__']);
const SOURCE_EXT = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const TEST_FILE = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|\.d\.ts$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(path);
  }
  return out;
}

function scanRepo(): LaunchSite[] {
  return SCAN_ROOTS.flatMap((root) => {
    const abs = join(repoRoot, root);
    try {
      statSync(abs);
    } catch {
      return [];
    }
    return sourceFiles(abs).flatMap((path) => findChildProcessLaunches(relative(repoRoot, path), readFileSync(path, 'utf8')));
  });
}

const check = (body: string, imports = "import { spawn, execFile, execSync, fork } from 'node:child_process';") =>
  findChildProcessLaunches('x.ts', `${imports}\nasync function f() {\n${body}\n}`);
const problems = (body: string, imports?: string) => check(body, imports).map((s) => s.problem);

describe('the scan sees the shapes it claims to', () => {
  it('flags a launch with no options or no env', () => {
    expect(problems(`spawn('x', []);`)).toEqual(['no_env']);
    expect(problems(`spawn('x', [], { stdio: 'pipe' });`)).toEqual(['no_env']);
    expect(problems(`execSync('x');`)).toEqual(['no_env']);
    expect(problems(`execFile('x', ['a'], (err) => {});`)).toEqual(['no_env']);
  });
  it('flags process.env passed whole or spread', () => {
    expect(problems(`spawn('x', [], { env: process.env });`)).toEqual(['inherits_process_env']);
    expect(problems(`spawn('x', [], { env: { ...process.env, A: '1' } });`)).toEqual(['inherits_process_env']);
    expect(problems(`spawn('x', [], { env: Object.assign({}, process.env) });`)).toEqual(['inherits_process_env']);
    expect(problems(`spawn('x', [], { env: opts.env ?? process.env });`)).toEqual(['inherits_process_env']);
    expect(problems(`fork('m.js', [], { ...process.env });`)).toEqual(['inherits_process_env']);
  });
  it('passes an explicit env, including one that reads single variables', () => {
    expect(problems(`spawn('x', [], { env: { PATH: process.env.PATH ?? '' } });`)).toEqual([null]);
    expect(problems(`spawn('x', [], { env: childEnv(dir) });`)).toEqual([null]);
    expect(problems(`execSync('x', { env: { HOME: process.env['HOME'] } });`)).toEqual([null]);
    expect(problems(`const env = {}; spawn('x', [], { env });`)).toEqual([null]);
  });
  it('flags options it cannot read', () => {
    expect(problems(`spawn('x', [], opts);`)).toEqual(['options_not_inline']);
    expect(problems(`spawn('x', [], { ...opts });`)).toEqual(['options_not_inline']);
  });
  it('follows aliases, namespace, default and require bindings', () => {
    expect(problems(`run('x', []);`, "import { spawn as run } from 'child_process';")).toEqual(['no_env']);
    expect(problems(`cp.spawn('x', []);`, "import * as cp from 'node:child_process';")).toEqual(['no_env']);
    expect(problems(`cp.execFileSync('x', []);`, "import cp from 'child_process';")).toEqual(['no_env']);
    expect(problems(`spawn('x', []);`, "const { spawn } = require('node:child_process');")).toEqual(['no_env']);
  });
  it('follows promisify wrappers', () => {
    const imports = "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst execFileAsync = promisify(execFile);";
    expect(check(`await execFileAsync('tar', ['-c']);`, imports)).toEqual([
      { site: "x.ts > f > execFileAsync('tar')", problem: 'no_env' },
    ]);
    expect(problems(`await execFileAsync('tar', [], { env: { PATH: '/bin' } });`, imports)).toEqual([null]);
    const utilImports = "import * as cp from 'node:child_process';\nimport util from 'node:util';\nconst run = util.promisify(cp.exec);";
    expect(problems(`await run('x');`, utilImports)).toEqual(['no_env']);
  });
  it('reports a launcher used as a value', () => {
    expect(problems(`const launch = spawn; launch('x');`)).toEqual(['untracked_use']);
  });
  it('ignores type positions, unrelated members and files without the import', () => {
    expect(problems(`let c: ReturnType<typeof spawn>;`)).toEqual([]);
    expect(problems(`const k = cp.ChildProcess;`, "import * as cp from 'node:child_process';")).toEqual([]);
    expect(findChildProcessLaunches('y.ts', `spawn('x', []);`)).toEqual([]);
  });
});

describe('server child processes get an explicit environment', () => {
  const sites = scanRepo();

  it('sees the launches it should (guards against a scan that finds nothing)', () => {
    const compliant = sites.filter((s) => s.problem === null).map((s) => s.site.split(' > ')[0]);
    expect(compliant).toContain('apps/api/src/services/yaraPrecheck.ts');
    expect(compliant).toContain('apps/api/src/services/workspace/fakeSandboxBackend.ts');
  });

  it('has no launch that inherits the server environment', () => {
    const allowed = new Set(KNOWN_INHERITING_SITES.map((e) => e.site));
    const offenders = sites.filter((s) => s.problem !== null && !allowed.has(s.site)).map((s) => `${s.site} [${s.problem}]`);
    expect(
      offenders,
      'A server child process must get an explicit, minimal environment so the API\'s '
      + 'secrets are not inherited. Pass `env` as an object literal option built from '
      + 'only the variables the child needs (for example `{ PATH: process.env.PATH ?? \'\' }`); '
      + 'never pass `process.env` or spread it. Examples: apps/api/src/services/yaraPrecheck.ts, '
      + 'apps/api/src/services/workspace/fakeSandboxBackend.ts (childEnv), '
      + 'apps/api/src/services/aiModels/sdkChildEnv.ts.',
    ).toEqual([]);
  }, 60_000);

  it('has no stale exception (the list only shrinks)', () => {
    const flagged = new Set(sites.filter((s) => s.problem !== null).map((s) => s.site));
    const stale = KNOWN_INHERITING_SITES.filter((e) => !flagged.has(e.site)).map((e) => e.site);
    expect(stale, 'These KNOWN_INHERITING_SITES entries no longer match a flagged site; delete them.').toEqual([]);
  });
});
