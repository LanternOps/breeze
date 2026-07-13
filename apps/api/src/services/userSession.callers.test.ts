import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');

const expectedIssuers = new Set([
  'services/mfaAssurance.ts',
  'services/recoveryCodeAuth.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/register.ts',
  'routes/auth/login.ts',
  'routes/auth/invite.ts',
  'routes/sso.ts',
]);

const expectedCookieWriters = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/mfa.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/register.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/sso.ts',
]);

function walkProductionTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...walkProductionTypeScript(fullPath));
    } else if (
      entry.endsWith('.ts')
      && !entry.endsWith('.test.ts')
      && !entry.endsWith('.spec.ts')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const CANONICAL_PROTECTED_FILES: Record<string, string> = {
  issueUserSession: join(SRC_DIR, 'services/userSession.ts'),
  issueUserSessionLegacyDuringTransition: join(SRC_DIR, 'services/userSession.ts'),
  setRefreshTokenCookie: join(SRC_DIR, 'routes/auth/helpers.ts'),
};

function normalizeFileName(fileName: string): string {
  const absolute = resolve(fileName);
  return ts.sys.fileExists(absolute) && ts.sys.realpath ? ts.sys.realpath(absolute) : absolute;
}

const API_TSCONFIG = join(SRC_DIR, '../tsconfig.json');

function readAnalysisConfig(configFile: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(configFile, ts.sys.readFile);
  if (read.error) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configFile),
    undefined,
    configFile,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
      .join('\n'));
  }
  return parsed;
}

function createAnalysisProgram(
  rootNames: string[],
  virtualSources: ReadonlyMap<string, string> = new Map(),
  noResolve = false,
  configFile = API_TSCONFIG,
  includeConfigFiles = false,
): ts.Program {
  const normalizedVirtualSources = new Map(
    [...virtualSources].map(([fileName, source]) => [normalizeFileName(fileName), source]),
  );
  const parsedConfig = readAnalysisConfig(configFile);
  const compilerOptions: ts.CompilerOptions = {
    ...parsedConfig.options,
    noEmit: true,
    skipLibCheck: true,
    noResolve,
  };
  const host = ts.createCompilerHost(compilerOptions, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultGetSourceFile = host.getSourceFile.bind(host);
  const defaultRealpath = host.realpath?.bind(host);
  host.fileExists = (fileName) => normalizedVirtualSources.has(normalizeFileName(fileName))
    || defaultFileExists(fileName);
  host.readFile = (fileName) => normalizedVirtualSources.get(normalizeFileName(fileName))
    ?? defaultReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const virtual = normalizedVirtualSources.get(normalizeFileName(fileName));
    return virtual === undefined
      ? defaultGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(fileName, virtual, languageVersion, true, ts.ScriptKind.TS);
  };
  if (defaultRealpath) {
    host.realpath = (fileName) => normalizedVirtualSources.has(normalizeFileName(fileName))
      ? normalizeFileName(fileName)
      : defaultRealpath(fileName);
  }
  return ts.createProgram({
    rootNames: [...new Set([
      ...rootNames.map(normalizeFileName),
      ...(includeConfigFiles ? parsedConfig.fileNames.map(normalizeFileName) : []),
    ])],
    options: compilerOptions,
    host,
  });
}

function resolveAliasedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const resolved = checker.getAliasedSymbol(current);
    if (resolved === current) break;
    current = resolved;
  }
  return current;
}

function getCanonicalSymbol(
  program: ts.Program,
  canonicalFile: string,
  functionName: string,
): ts.Symbol {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(normalizeFileName(canonicalFile));
  const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol
    && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === functionName);
  if (!exported) throw new Error(`Unable to resolve canonical ${functionName} export`);
  const canonical = resolveAliasedSymbol(checker, exported);
  const declaredInCanonicalFile = canonical.declarations?.some(
    (declaration) => normalizeFileName(declaration.getSourceFile().fileName)
      === normalizeFileName(canonicalFile),
  );
  if (!declaredInCanonicalFile) {
    throw new Error(`Canonical ${functionName} export did not resolve to ${canonicalFile}`);
  }
  return canonical;
}

function hasCanonicalDeclaration(symbol: ts.Symbol, canonical: ts.Symbol): boolean {
  if (symbol === canonical) return true;
  const canonicalDeclarations = canonical.declarations ?? [];
  return (symbol.declarations ?? []).some((declaration) =>
    canonicalDeclarations.some((candidate) =>
      normalizeFileName(declaration.getSourceFile().fileName)
        === normalizeFileName(candidate.getSourceFile().fileName)
      && declaration.pos === candidate.pos
      && declaration.end === candidate.end));
}

function symbolContainsCanonical(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  canonical: ts.Symbol,
  visiting: Set<ts.Symbol> = new Set(),
): boolean {
  if (!symbol) return false;
  const resolved = resolveAliasedSymbol(checker, symbol);
  if (hasCanonicalDeclaration(resolved, canonical)) return true;
  if (visiting.has(resolved)) return false;
  visiting.add(resolved);
  if ((resolved.flags & (ts.SymbolFlags.Module | ts.SymbolFlags.NamespaceModule)) !== 0) {
    for (const exported of checker.getExportsOfModule(resolved)) {
      if (symbolContainsCanonical(checker, exported, canonical, visiting)) {
        visiting.delete(resolved);
        return true;
      }
    }
  }
  visiting.delete(resolved);
  return false;
}

function protectedConventionError(functionName: string, detail: string): Error {
  return new Error(`Protected symbol convention violation for ${functionName}: ${detail}`);
}

function isBindingDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isParameter(parent) && parent.name === node)
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.name === node)
    || (ts.isFunctionDeclaration(parent) && parent.name === node)
    || (ts.isClassDeclaration(parent) && parent.name === node);
}

function resolveStaticModuleSpecifier(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
): string | null {
  if (!expression) return null;
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text;
  }
  if (!ts.isIdentifier(unwrapped)) return null;
  const symbol = checker.getSymbolAtLocation(unwrapped);
  for (const declaration of symbol?.declarations ?? []) {
    if (
      ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        return initializer.text;
      }
    }
  }
  return null;
}

function resolveRequiredModuleSymbol(
  program: ts.Program,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  specifier: string,
): ts.Symbol | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    sourceFile.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return undefined;
  const requiredSource = program.getSourceFile(normalizeFileName(resolved));
  return requiredSource ? checker.getSymbolAtLocation(requiredSource) : undefined;
}

function analyzeTrackedSymbolCalls(
  program: ts.Program,
  fileName: string,
  functionName: string,
  canonicalFile: string,
): number {
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(normalizeFileName(fileName));
  if (!sourceFile) throw new Error(`Unable to load analysis source ${fileName}`);
  const canonical = getCanonicalSymbol(program, canonicalFile, functionName);
  const protectedBindings = new Map<ts.Symbol, { exact: boolean; reExported: boolean }>();

  const inspectModuleLoads = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const moduleSymbol = checker.getSymbolAtLocation(node.arguments[0]);
      if (!symbolContainsCanonical(checker, moduleSymbol, canonical)) {
        ts.forEachChild(node, inspectModuleLoads);
        return;
      }
      const awaited = ts.isAwaitExpression(node.parent) ? node.parent : undefined;
      const declaration = awaited && ts.isVariableDeclaration(awaited.parent)
        ? awaited.parent
        : undefined;
      const elements = declaration && ts.isObjectBindingPattern(declaration.name)
        ? declaration.name.elements
        : undefined;
      const destructuresOnlyUnrelatedExports = !!elements
        && elements.length > 0
        && elements.every((element) => {
          if (
            element.dotDotDotToken
            || (element.propertyName && ts.isComputedPropertyName(element.propertyName))
          ) return false;
          const importedName = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName)
              ? element.propertyName.text
              : undefined
            : ts.isIdentifier(element.name) ? element.name.text : undefined;
          if (!importedName) return false;
          const exported = checker.getExportsOfModule(resolveAliasedSymbol(checker, moduleSymbol!))
            .find((symbol) => symbol.name === importedName);
          return !symbolContainsCanonical(checker, exported, canonical);
        });
      if (destructuresOnlyUnrelatedExports) {
        ts.forEachChild(node, inspectModuleLoads);
        return;
      }
      throw protectedConventionError(functionName, 'dynamic imports are forbidden');
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(unwrapExpression(node.expression))
      && (unwrapExpression(node.expression) as ts.Identifier).text === 'require'
    ) {
      const specifier = resolveStaticModuleSpecifier(checker, node.arguments[0]);
      const moduleSymbol = specifier
        ? resolveRequiredModuleSymbol(program, checker, sourceFile, specifier)
        : undefined;
      if (symbolContainsCanonical(checker, moduleSymbol, canonical)) {
        throw protectedConventionError(functionName, 'CommonJS require is forbidden');
      }
    }
    ts.forEachChild(node, inspectModuleLoads);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.importClause
    ) {
      const bindings = statement.importClause.namedBindings;
      if (statement.importClause.name) {
        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (symbolContainsCanonical(checker, moduleSymbol, canonical)) {
          throw protectedConventionError(functionName, 'default imports are forbidden');
        }
      }
      if (bindings && ts.isNamespaceImport(bindings)) {
        const localSymbol = checker.getSymbolAtLocation(bindings.name);
        if (symbolContainsCanonical(checker, localSymbol, canonical)) {
          throw protectedConventionError(functionName, 'namespace imports are forbidden');
        }
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const localSymbol = checker.getSymbolAtLocation(element.name);
          if (!localSymbol || !symbolContainsCanonical(checker, localSymbol, canonical)) continue;
          protectedBindings.set(localSymbol, {
            exact: importedName === functionName
              && element.name.text === functionName
              && !element.propertyName,
            reExported: false,
          });
        }
      }
    }
  }
  inspectModuleLoads(sourceFile);

  if (protectedBindings.size === 0) return 0;

  let count = 0;
  const inspectReferences = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const localSymbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
          ?? checker.getSymbolAtLocation(node)
        : checker.getSymbolAtLocation(node);
      const binding = localSymbol && protectedBindings.get(localSymbol);
      if (ts.isImportSpecifier(node.parent)) return;
      if (
        ts.isExportSpecifier(node.parent)
        && symbolContainsCanonical(checker, localSymbol, canonical)
      ) {
        if (binding) binding.reExported = true;
        return;
      }
      if (
        binding
        && ts.isTypeQueryNode(node.parent)
        && node.parent.exprName === node
        && binding.exact
      ) return;
      if (binding && ts.isCallExpression(node.parent) && node.parent.expression === node) {
        if (!binding.exact) {
          throw protectedConventionError(functionName, 'named import aliases are forbidden');
        }
        count += 1;
        return;
      }
      if (binding || symbolContainsCanonical(checker, localSymbol, canonical)) {
        throw protectedConventionError(
          functionName,
          'only a direct CallExpression identifier may reference the imported symbol',
        );
      }
      if (
        protectedBindings.size > 0
        && node.text === functionName
        && isBindingDeclarationIdentifier(node)
      ) {
        throw protectedConventionError(functionName, 'shadowing is forbidden');
      }
    }
    ts.forEachChild(node, inspectReferences);
  };
  inspectReferences(sourceFile);
  for (const binding of protectedBindings.values()) {
    if (!binding.exact && !binding.reExported) {
      throw protectedConventionError(functionName, 'named import aliases are forbidden');
    }
  }
  return count;
}

function countTrackedSymbolCalls(
  source: string,
  functionName: string,
  fileName = join(SRC_DIR, '__session_inventory_fixture.ts'),
  canonicalFile = CANONICAL_PROTECTED_FILES[functionName],
  configFile?: string,
): number {
  if (!canonicalFile) throw new Error(`Unknown protected symbol: ${functionName}`);
  const normalizedFile = normalizeFileName(fileName);
  const onDiskSource = ts.sys.fileExists(normalizedFile) ? ts.sys.readFile(normalizedFile) : undefined;
  const virtualSources = new Map<string, string>();
  if (onDiskSource !== source) {
    virtualSources.set(normalizedFile, source);
    // Isolated source fixtures need symbol identity, not the canonical files'
    // production dependency graphs. A virtual definition preserves identity
    // while keeping each fixture program deterministic and small.
    virtualSources.set(normalizeFileName(canonicalFile), `export function ${functionName}() {}`);
  }
  const program = createAnalysisProgram(
    [normalizedFile, canonicalFile],
    virtualSources,
    false,
    configFile ?? API_TSCONFIG,
    !!configFile,
  );
  return analyzeTrackedSymbolCalls(program, normalizedFile, functionName, canonicalFile);
}

let repositoryProgram: ts.Program | undefined;

function collectCallInventory(functionName: string): Map<string, number> {
  const files = walkProductionTypeScript(SRC_DIR);
  // Every API source is already a root; noResolve prevents the compiler from
  // pulling the full monorepo/node_modules graph while still binding imports
  // and re-exports between these root source files.
  repositoryProgram ??= createAnalysisProgram(files, new Map(), true, API_TSCONFIG);
  const canonicalFile = CANONICAL_PROTECTED_FILES[functionName];
  if (!canonicalFile) throw new Error(`Unknown protected symbol: ${functionName}`);
  const inventory = new Map<string, number>();
  for (const file of files) {
    const count = analyzeTrackedSymbolCalls(
      repositoryProgram,
      file,
      functionName,
      canonicalFile,
    );
    if (count > 0) inventory.set(relative(SRC_DIR, file), count);
  }
  return inventory;
}

function findSsoExchangeHandler(source: string): ts.ArrowFunction | ts.FunctionExpression {
  const sourceFile = ts.createSourceFile(
    'sso.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'ssoRoutes'
      && node.expression.name.text === 'post'
      && node.arguments[0]
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === '/exchange'
    ) {
      const candidate = node.arguments.at(-1);
      if (candidate && (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate))) {
        handler = candidate;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!handler) throw new Error('Unable to locate POST /sso/exchange handler');
  return handler;
}

function isDirectCall(expression: ts.Expression, functionName: string): expression is ts.CallExpression {
  return ts.isCallExpression(expression)
    && ts.isIdentifier(unwrapExpression(expression.expression))
    && (unwrapExpression(expression.expression) as ts.Identifier).text === functionName;
}

function isFalsyGuard(statement: ts.Statement, variableName: string): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  const condition = unwrapExpression(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition)
    || condition.operator !== ts.SyntaxKind.ExclamationToken
    || !ts.isIdentifier(unwrapExpression(condition.operand))
    || (unwrapExpression(condition.operand) as ts.Identifier).text !== variableName
  ) {
    return false;
  }
  if (ts.isReturnStatement(statement.thenStatement)) return true;
  if (!ts.isBlock(statement.thenStatement)) return false;
  const onlyStatement = statement.thenStatement.statements[0];
  return !!onlyStatement
    && statement.thenStatement.statements.length === 1
    && ts.isReturnStatement(onlyStatement);
}

function cookieUsesGrantRefreshToken(
  statement: ts.Statement,
  grantName: string,
): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrapExpression(statement.expression);
  if (!isDirectCall(expression, 'setRefreshTokenCookie')) return false;
  const context = expression.arguments[0] && unwrapExpression(expression.arguments[0]);
  const token = expression.arguments[1] && unwrapExpression(expression.arguments[1]);
  return expression.arguments.length === 2
    && !!context
    && ts.isIdentifier(context)
    && context.text === 'c'
    && !!token
    && ts.isPropertyAccessExpression(token)
    && ts.isIdentifier(unwrapExpression(token.expression))
    && (unwrapExpression(token.expression) as ts.Identifier).text === grantName
    && token.name.text === 'refreshToken';
}

function provesAuthorizedSsoExchangeCookieFlow(source: string): boolean {
  const handler = findSsoExchangeHandler(source);
  if (!ts.isBlock(handler.body)) return false;

  let allConsumeCalls = 0;
  let allCookieCalls = 0;
  const countCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(unwrapExpression(node.expression))) {
      const name = (unwrapExpression(node.expression) as ts.Identifier).text;
      if (name === 'consumeSsoTokenExchangeGrant') allConsumeCalls += 1;
      if (name === 'setRefreshTokenCookie') allCookieCalls += 1;
    }
    ts.forEachChild(node, countCalls);
  };
  countCalls(handler.body);
  if (allConsumeCalls !== 1 || allCookieCalls !== 1) return false;

  const statements = [...handler.body.statements];
  let grantName: string | undefined;
  let consumeIndex = -1;
  for (const [index, statement] of statements.entries()) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name)
        && declaration.initializer
        && isDirectCall(unwrapExpression(declaration.initializer), 'consumeSsoTokenExchangeGrant')
      ) {
        if (
          (statement.declarationList.flags & ts.NodeFlags.Const) === 0
          || statement.declarationList.declarations.length !== 1
        ) {
          return false;
        }
        grantName = declaration.name.text;
        consumeIndex = index;
      }
    }
  }
  if (!grantName || consumeIndex < 0) return false;

  const guardIndex = statements.findIndex((statement, index) =>
    index > consumeIndex && isFalsyGuard(statement, grantName!));
  const cookieIndex = statements.findIndex((statement, index) =>
    index > consumeIndex && cookieUsesGrantRefreshToken(statement, grantName!));

  // Exact statement adjacency prevents deferred work or an intervening
  // statement from replacing/mutating the authorized grant/token source.
  return guardIndex === consumeIndex + 1 && cookieIndex === guardIndex + 1;
}

describe('session inventory analyzer fixtures', () => {
  const analyzeFixture = countTrackedSymbolCalls as unknown as (
    source: string,
    functionName: string,
    fileName: string,
    canonicalFile: string,
    configFile?: string,
  ) => number;

  function withModuleGraph(
    files: Record<string, string>,
    run: (root: string) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), 'protected-module-graph-'));
    try {
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = join(root, relativePath);
        mkdirSync(join(fullPath, '..'), { recursive: true });
        writeFileSync(fullPath, content);
      }
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('resolves a protected issuer through an alternate relative path', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'routes/consumer.ts': "import { issueUserSession } from '../services/userSession'; issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toBe(1);
    });
  });

  it('honors a fixture project path alias for both protected functions', () => {
    withModuleGraph({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
          module: 'ESNext',
          moduleResolution: 'Node',
          target: 'ES2022',
        },
        include: ['**/*.ts'],
      }),
      'src/services/userSession.ts': 'export function issueUserSession() {}',
      'src/routes/auth/helpers.ts': 'export function setRefreshTokenCookie() {}',
      'src/consumer.ts': `
        import { issueUserSession } from '@/services/userSession';
        import { setRefreshTokenCookie } from '@/routes/auth/helpers';
        issueUserSession();
        setRefreshTokenCookie();
      `,
    }, (root) => {
      const consumer = join(root, 'src/consumer.ts');
      const config = join(root, 'tsconfig.json');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'src/services/userSession.ts'),
        config,
      )).toBe(1);
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'setRefreshTokenCookie',
        consumer,
        join(root, 'src/routes/auth/helpers.ts'),
        config,
      )).toBe(1);
    });
  });

  it.each([
    [
      'direct property access',
      "const issueUserSession = require('../services/userSession').issueUserSession; issueUserSession();",
    ],
    [
      'aliased destructuring through a barrel',
      "const { issueUserSession: issue } = require('../services/barrel'); issue();",
    ],
    [
      'computed module variable that resolves to the protected module',
      "const moduleName = '../services/userSession'; const { issueUserSession } = require(moduleName); issueUserSession();",
    ],
  ])('rejects protected CommonJS require through %s', (_name, body) => {
    withModuleGraph({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022' },
        include: ['**/*.ts'],
      }),
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/barrel.ts': "export * from './userSession';",
      'routes/consumer.ts': body,
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
        join(root, 'tsconfig.json'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it.each([
    [
      'whitespace before the argument list',
      "const { issueUserSession } = require \n ('../services/userSession'); issueUserSession();",
    ],
    [
      'a parenthesized callee',
      "const { issueUserSession } = (require)('../services/userSession'); issueUserSession();",
    ],
    [
      'a TypeScript-wrapped callee',
      "const { issueUserSession } = (require as typeof require)('../services/userSession'); issueUserSession();",
    ],
  ])('rejects formatted protected CommonJS require through %s', (_name, body) => {
    withModuleGraph({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022' },
        include: ['**/*.ts'],
      }),
      'services/userSession.ts': 'export function issueUserSession() {}',
      'routes/consumer.ts': body,
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
        join(root, 'tsconfig.json'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it('ignores CommonJS require of a genuinely unrelated module', () => {
    withModuleGraph({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022' },
        include: ['**/*.ts'],
      }),
      'services/userSession.ts': 'export function issueUserSession() {}',
      'unrelated.ts': 'export function issueUserSession() {}',
      'consumer.ts': "const { issueUserSession } = require('./unrelated'); issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'consumer.ts');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
        join(root, 'tsconfig.json'),
      )).toBe(0);
    });
  });

  it('resolves protected symbols through nested re-export barrels and cycles', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/a.ts': "export * from './b';",
      'services/b.ts': "export * from './a'; export * from './userSession';",
      'routes/consumer.ts': "import { issueUserSession } from '../services/a'; issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toBe(1);
    });
  });

  it('resolves both entry orders through a cyclic barrel component', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/a.ts': "export * from './b';",
      'services/b.ts': "export * from './a'; export * from './userSession';",
      'routes/from-a.ts': "import { issueUserSession } from '../services/a'; issueUserSession();",
      'routes/from-b.ts': "import { issueUserSession } from '../services/b'; issueUserSession();",
    }, (root) => {
      const canonical = join(root, 'services/userSession.ts');
      for (const consumerName of ['from-b.ts', 'from-a.ts']) {
        const consumer = join(root, 'routes', consumerName);
        expect(analyzeFixture(
          readFileSync(consumer, 'utf8'),
          'issueUserSession',
          consumer,
          canonical,
        )).toBe(1);
      }
    });
  });

  it('rejects a protected function exposed through a namespace re-export', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/barrel.ts': "export * as sessions from './userSession';",
      'routes/consumer.ts': "import { sessions } from '../services/barrel'; sessions.issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it.each([
    ["a quoted property", "const { 'issueUserSession': issue } = await import('../services/userSession'); issue();"],
    ['a computed property', "const key = 'issueUserSession'; const { [key]: issue } = await import('../services/userSession'); issue();"],
  ])('rejects dynamic protected destructuring through %s', (_name, body) => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'routes/consumer.ts': `async function run() { ${body} }`,
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it('rejects a protected dynamic import with a comment before its argument list', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'routes/consumer.ts': `
        async function run() {
          const { issueUserSession } = await import /* module */ ('../services/userSession');
          issueUserSession();
        }
      `,
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it('recognizes a named alias re-export and still rejects alias consumption', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/barrel.ts': "export { issueUserSession as issue } from './userSession';",
      'routes/consumer.ts': "import { issue as issueUserSession } from '../services/barrel'; issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it('rejects consumption that preserves an arbitrary canonical re-export alias', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'services/barrel.ts': "export { issueUserSession as issue } from './userSession';",
      'routes/consumer.ts': "import { issue } from '../services/barrel'; issue();",
    }, (root) => {
      const consumer = join(root, 'routes/consumer.ts');
      expect(() => analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toThrow(/protected symbol convention/i);
    });
  });

  it('resolves the protected cookie writer through a nested local re-export', () => {
    withModuleGraph({
      'auth/helpers.ts': 'export function setRefreshTokenCookie() {}',
      'auth/barrel.ts': "import { setRefreshTokenCookie as local } from './helpers'; export { local as setRefreshTokenCookie };",
      'routes/consumer.ts': "import { setRefreshTokenCookie } from '../auth/barrel'; setRefreshTokenCookie();",
    }, (root) => {
      const barrel = join(root, 'auth/barrel.ts');
      expect(analyzeFixture(
        readFileSync(barrel, 'utf8'),
        'setRefreshTokenCookie',
        barrel,
        join(root, 'auth/helpers.ts'),
      )).toBe(0);
      const consumer = join(root, 'routes/consumer.ts');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'setRefreshTokenCookie',
        consumer,
        join(root, 'auth/helpers.ts'),
      )).toBe(1);
    });
  });

  it('ignores a genuinely unrelated same-named export in the module graph', () => {
    withModuleGraph({
      'services/userSession.ts': 'export function issueUserSession() {}',
      'unrelated.ts': 'export function issueUserSession() {}',
      'consumer.ts': "import { issueUserSession } from './unrelated'; issueUserSession();",
    }, (root) => {
      const consumer = join(root, 'consumer.ts');
      expect(analyzeFixture(
        readFileSync(consumer, 'utf8'),
        'issueUserSession',
        consumer,
        join(root, 'services/userSession.ts'),
      )).toBe(0);
    });
  });

  it.each([
    [
      'named import alias',
      "import { issueUserSession as issue } from './services/userSession'; issue({} as never);",
    ],
    [
      'namespace property call',
      "import * as sessions from './services/userSession'; sessions.issueUserSession({} as never);",
    ],
    [
      'local alias',
      "import { issueUserSession } from './services/userSession'; const issue = issueUserSession; issue({} as never);",
    ],
    [
      'call/apply forms',
      "import { issueUserSession } from './services/userSession'; issueUserSession.call(null, {}); issueUserSession.apply(null, [{}]);",
    ],
  ])('rejects issueUserSession through %s', (_name, source) => {
    expect(() => countTrackedSymbolCalls(source, 'issueUserSession')).toThrow(
      /protected symbol convention/i,
    );
  });

  it.each([
    [
      'named import alias',
      "import { setRefreshTokenCookie as install } from './routes/auth/helpers'; install(c, token);",
    ],
    [
      'namespace property call',
      "import * as helpers from './routes/auth/helpers'; helpers.setRefreshTokenCookie(c, token);",
    ],
    [
      'local alias',
      "import { setRefreshTokenCookie } from './routes/auth/helpers'; const install = setRefreshTokenCookie; install(c, token);",
    ],
    [
      'call/apply forms',
      "import { setRefreshTokenCookie } from './routes/auth/helpers'; setRefreshTokenCookie.call(null, c, token); setRefreshTokenCookie.apply(null, [c, token]);",
    ],
  ])('rejects setRefreshTokenCookie through %s', (_name, source) => {
    expect(() => countTrackedSymbolCalls(source, 'setRefreshTokenCookie')).toThrow(
      /protected symbol convention/i,
    );
  });

  it.each([
    [
      'dynamic import destructuring',
      "async function f() { const { issueUserSession } = await import('./services/userSession'); await issueUserSession({}); }",
    ],
    [
      'bind',
      "import { issueUserSession } from './services/userSession'; const issue = issueUserSession.bind(null); issue({});",
    ],
    [
      'shadowing',
      "import { issueUserSession } from './services/userSession'; function f(issueUserSession: () => void) { issueUserSession(); }",
    ],
    [
      'namespace destructuring',
      "import * as sessions from './services/userSession'; const { issueUserSession } = sessions; issueUserSession({});",
    ],
    [
      'object alias',
      "import { issueUserSession } from './services/userSession'; const issuers = { issueUserSession }; issuers.issueUserSession({});",
    ],
  ])('rejects issueUserSession %s', (_name, source) => {
    expect(() => countTrackedSymbolCalls(source, 'issueUserSession')).toThrow(
      /protected symbol convention/i,
    );
  });

  it.each([
    [
      'dynamic import destructuring',
      "async function f() { const { setRefreshTokenCookie } = await import('./routes/auth/helpers'); setRefreshTokenCookie(c, token); }",
    ],
    [
      'bind',
      "import { setRefreshTokenCookie } from './routes/auth/helpers'; const install = setRefreshTokenCookie.bind(null); install(c, token);",
    ],
    [
      'shadowing',
      "import { setRefreshTokenCookie } from './routes/auth/helpers'; function f(setRefreshTokenCookie: () => void) { setRefreshTokenCookie(); }",
    ],
  ])('rejects setRefreshTokenCookie %s', (_name, source) => {
    expect(() => countTrackedSymbolCalls(source, 'setRefreshTokenCookie')).toThrow(
      /protected symbol convention/i,
    );
  });

  it.each([
    [
      'issueUserSession',
      "import { issueUserSession } from './unrelated'; issueUserSession({});",
    ],
    [
      'setRefreshTokenCookie',
      "import { setRefreshTokenCookie } from './unrelated'; setRefreshTokenCookie(c, token);",
    ],
  ])('does not count %s imported from an unrelated source', (symbol, source) => {
    expect(countTrackedSymbolCalls(source, symbol)).toBe(0);
  });

  it('ignores comments, strings, and unrelated local declarations', () => {
    const source = `
      // issueUserSession({}); setRefreshTokenCookie(c, token);
      const text = 'issueUserSession({}); setRefreshTokenCookie(c, token);';
      function issueUserSession() { return undefined; }
      const setRefreshTokenCookie = () => undefined;
    `;

    expect(countTrackedSymbolCalls(source, 'issueUserSession')).toBe(0);
    expect(countTrackedSymbolCalls(source, 'setRefreshTokenCookie')).toBe(0);
  });

  it('excludes test files and __tests__ trees from the production walk', () => {
    const root = mkdtempSync(join(tmpdir(), 'session-inventory-'));
    try {
      mkdirSync(join(root, '__tests__'));
      writeFileSync(join(root, 'production.ts'), '');
      writeFileSync(join(root, 'unit.test.ts'), '');
      writeFileSync(join(root, 'unit.spec.ts'), '');
      writeFileSync(join(root, '__tests__', 'fixture.ts'), '');

      expect(walkProductionTypeScript(root).map((file) => relative(root, file))).toEqual([
        'production.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a deferred SSO grant consumption declared before the cookie write', () => {
    const source = `
      ssoRoutes.post('/exchange', async (c) => {
        const consumeLater = () => consumeSsoTokenExchangeGrant(code);
        setRefreshTokenCookie(c, grant.refreshToken);
        const grant = consumeLater();
      });
    `;
    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(false);
  });

  it('accepts a direct consumed, authorized grant whose token is installed afterward', () => {
    const source = `
      ssoRoutes.post('/exchange', async (c) => {
        const grant = consumeSsoTokenExchangeGrant(code);
        if (!grant) {
          return c.json({ error: 'invalid' }, 400);
        }
        setRefreshTokenCookie(c, grant.refreshToken);
      });
    `;

    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(true);
  });

  it('rejects mutation of the consumed SSO grant before cookie installation', () => {
    const source = `
      ssoRoutes.post('/exchange', async (c) => {
        const grant = consumeSsoTokenExchangeGrant(code);
        if (!grant) return c.json({ error: 'invalid' }, 400);
        grant.refreshToken = attackerToken;
        setRefreshTokenCookie(c, grant.refreshToken);
      });
    `;

    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(false);
  });

  it.each([
    [
      'an intervening statement before the grant guard',
      `
        const grant = consumeSsoTokenExchangeGrant(code);
        audit(grant);
        if (!grant) return c.json({ error: 'invalid' }, 400);
        setRefreshTokenCookie(c, grant.refreshToken);
      `,
    ],
    [
      'a mutable grant binding',
      `
        let grant = consumeSsoTokenExchangeGrant(code);
        if (!grant) return c.json({ error: 'invalid' }, 400);
        setRefreshTokenCookie(c, grant.refreshToken);
      `,
    ],
    [
      'a compound grant declaration',
      `
        const other = value, grant = consumeSsoTokenExchangeGrant(code);
        if (!grant) return c.json({ error: 'invalid' }, 400);
        setRefreshTokenCookie(c, grant.refreshToken);
      `,
    ],
  ])('rejects SSO exchange with %s', (_name, body) => {
    const source = `ssoRoutes.post('/exchange', async (c) => { ${body} });`;
    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(false);
  });
});

describe('browser-auth issuer inventory (1 guarded refresh; 8 frozen legacy issuances; 10 cookie writes)', () => {
  it('allows guarded issueUserSession only from refresh', () => {
    const inventory = collectCallInventory('issueUserSession');

    expect(Object.fromEntries(inventory)).toEqual({ 'routes/auth/login.ts': 1 });
    const source = readFileSync(join(SRC_DIR, 'routes/auth/login.ts'), 'utf8');
    expect(source).toMatch(/finishAuthIssuance\([\s\S]*issueUserSession\([\s\S]*tx,[\s\S]*capability,/);
    expect(source).not.toContain('issueUserSessionLegacyDuringTransition');
    expect(source).not.toContain('touchFamilyLastUsed');
  }, 15_000);

  it('freezes the exact remaining migration-shim callers', () => {
    const inventory = collectCallInventory('issueUserSessionLegacyDuringTransition');
    expect(new Set(inventory.keys())).toEqual(new Set([...expectedIssuers].filter(
      (file) => file !== 'routes/auth/login.ts',
    )));
    expect(Object.fromEntries([...inventory.entries()].sort())).toEqual({
      'routes/auth/cfAccessRedirectLogin.ts': 1,
      'routes/auth/invite.ts': 1,
      'routes/auth/register.ts': 2,
      'routes/sso.ts': 1,
      'services/mfaAssurance.ts': 2,
      'services/recoveryCodeAuth.ts': 1,
    });
    expect([...inventory.values()].reduce((total, count) => total + count, 0)).toBe(8);
  }, 15_000);

  it('freezes every production setRefreshTokenCookie call site', () => {
    const inventory = collectCallInventory('setRefreshTokenCookie');

    expect(new Set(inventory.keys())).toEqual(expectedCookieWriters);
    expect(Object.fromEntries([...inventory.entries()].sort())).toEqual({
      'middleware/cfAccessLogin.ts': 1,
      'routes/auth/cfAccessRedirectLogin.ts': 1,
      'routes/auth/invite.ts': 1,
      'routes/auth/login.ts': 2,
      'routes/auth/mfa.ts': 2,
      'routes/auth/passkeys.ts': 1,
      'routes/auth/register.ts': 1,
      'routes/sso.ts': 1,
    });
    expect([...inventory.values()].reduce((total, count) => total + count, 0)).toBe(10);
  }, 15_000);

  it('writes the SSO exchange refresh cookie only after consuming the exchange grant', () => {
    const source = readFileSync(join(SRC_DIR, 'routes/sso.ts'), 'utf8');

    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(true);
  });

  it.skip('requires a guarded capability at every production issuer');
  it.skip('allows refresh cookie installation only from an authorized session result');
  it.skip('keeps SSO exchange inside the durable binding generation');
});
