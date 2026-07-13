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
import { join, relative } from 'node:path';
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

function countTrackedSymbolCalls(source: string, functionName: string): number {
  const sourceFile = ts.createSourceFile(
    'session-inventory.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const importedBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  const collectImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamespaceImport(bindings)) {
        namespaceBindings.add(bindings.name.text);
      } else {
        for (const element of bindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === functionName) importedBindings.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(sourceFile);

  const isTrackedCallable = (rawExpression: ts.Expression): boolean => {
    const expression = unwrapExpression(rawExpression);
    if (ts.isIdentifier(expression)) return importedBindings.has(expression.text);
    if (ts.isPropertyAccessExpression(expression)) {
      const receiver = unwrapExpression(expression.expression);
      return ts.isIdentifier(receiver)
        && namespaceBindings.has(receiver.text)
        && expression.name.text === functionName;
    }
    if (ts.isElementAccessExpression(expression)) {
      const receiver = unwrapExpression(expression.expression);
      const argument = expression.argumentExpression && unwrapExpression(expression.argumentExpression);
      return ts.isIdentifier(receiver)
        && namespaceBindings.has(receiver.text)
        && !!argument
        && ts.isStringLiteral(argument)
        && argument.text === functionName;
    }
    return false;
  };

  // Resolve local aliases to a fixed point so alias chains are also fail-closed.
  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer
        && isTrackedCallable(node.initializer)
        && !importedBindings.has(node.name.text)
      ) {
        importedBindings.add(node.name.text);
        changed = true;
      }
      if (
        ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && isTrackedCallable(node.right)
        && !importedBindings.has(node.left.text)
      ) {
        importedBindings.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(sourceFile);
  }

  let count = 0;
  const visitCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && (
        isTrackedCallable(node.expression)
        || (
          ts.isPropertyAccessExpression(unwrapExpression(node.expression))
          && ['call', 'apply'].includes(
            (unwrapExpression(node.expression) as ts.PropertyAccessExpression).name.text,
          )
          && isTrackedCallable(
            (unwrapExpression(node.expression) as ts.PropertyAccessExpression).expression,
          )
        )
      )
    ) {
      count += 1;
    }
    ts.forEachChild(node, visitCalls);
  };
  visitCalls(sourceFile);
  return count;
}

function collectCallInventory(functionName: string): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of walkProductionTypeScript(SRC_DIR)) {
    const count = countTrackedSymbolCalls(readFileSync(file, 'utf8'), functionName);
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
  if (!ts.isIfStatement(statement)) return false;
  const condition = unwrapExpression(statement.expression);
  if (
    !ts.isPrefixUnaryExpression(condition)
    || condition.operator !== ts.SyntaxKind.ExclamationToken
    || !ts.isIdentifier(unwrapExpression(condition.operand))
    || (unwrapExpression(condition.operand) as ts.Identifier).text !== variableName
  ) {
    return false;
  }
  return ts.isReturnStatement(statement.thenStatement)
    || (ts.isBlock(statement.thenStatement)
      && statement.thenStatement.statements.some(ts.isReturnStatement));
}

function cookieUsesGrantRefreshToken(
  statement: ts.Statement,
  grantName: string,
): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = unwrapExpression(statement.expression);
  if (!isDirectCall(expression, 'setRefreshTokenCookie')) return false;
  const token = expression.arguments[1] && unwrapExpression(expression.arguments[1]);
  return !!token
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

  // Requiring adjacency after the rejection guard prevents an intervening
  // statement from replacing or mutating the authorized grant/token source.
  return guardIndex > consumeIndex && cookieIndex === guardIndex + 1;
}

describe('session inventory analyzer fixtures', () => {
  it.each([
    [
      'named import alias',
      "import { issueUserSession as issue } from './userSession'; issue({} as never);",
      1,
    ],
    [
      'namespace property call',
      "import * as sessions from './userSession'; sessions.issueUserSession({} as never);",
      1,
    ],
    [
      'local alias',
      "import { issueUserSession } from './userSession'; const issue = issueUserSession; issue({} as never);",
      1,
    ],
    [
      'call/apply forms',
      "import { issueUserSession } from './userSession'; issueUserSession.call(null, {}); issueUserSession.apply(null, [{}]);",
      2,
    ],
  ])('resolves issueUserSession through %s', (_name, source, expected) => {
    expect(countTrackedSymbolCalls(source, 'issueUserSession')).toBe(expected);
  });

  it.each([
    [
      'named import alias',
      "import { setRefreshTokenCookie as install } from './auth/helpers'; install(c, token);",
      1,
    ],
    [
      'namespace property call',
      "import * as helpers from './auth/helpers'; helpers.setRefreshTokenCookie(c, token);",
      1,
    ],
    [
      'local alias',
      "import { setRefreshTokenCookie } from './auth/helpers'; const install = setRefreshTokenCookie; install(c, token);",
      1,
    ],
    [
      'call/apply forms',
      "import { setRefreshTokenCookie } from './auth/helpers'; setRefreshTokenCookie.call(null, c, token); setRefreshTokenCookie.apply(null, [c, token]);",
      2,
    ],
  ])('resolves setRefreshTokenCookie through %s', (_name, source, expected) => {
    expect(countTrackedSymbolCalls(source, 'setRefreshTokenCookie')).toBe(expected);
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
});

describe('browser-auth issuer inventory (9 issuances in 7 files; 10 cookie writes in 8 files)', () => {
  it('freezes every production issueUserSession call site', () => {
    const inventory = collectCallInventory('issueUserSession');

    expect(new Set(inventory.keys())).toEqual(expectedIssuers);
    expect(Object.fromEntries([...inventory.entries()].sort())).toEqual({
      'routes/auth/cfAccessRedirectLogin.ts': 1,
      'routes/auth/invite.ts': 1,
      'routes/auth/login.ts': 1,
      'routes/auth/register.ts': 2,
      'routes/sso.ts': 1,
      'services/mfaAssurance.ts': 2,
      'services/recoveryCodeAuth.ts': 1,
    });
    expect([...inventory.values()].reduce((total, count) => total + count, 0)).toBe(9);
  });

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
  });

  it('writes the SSO exchange refresh cookie only after consuming the exchange grant', () => {
    const source = readFileSync(join(SRC_DIR, 'routes/sso.ts'), 'utf8');

    expect(provesAuthorizedSsoExchangeCookieFlow(source)).toBe(true);
  });

  it.skip('requires a guarded capability at every production issuer');
  it.skip('allows refresh cookie installation only from an authorized session result');
  it.skip('keeps SSO exchange inside the durable binding generation');
});
