import { readFileSync, readdirSync, statSync } from 'node:fs';
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

function countDirectCalls(source: string, functionName: string): number {
  const sourceFile = ts.createSourceFile(
    'session-inventory.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === functionName
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function collectCallInventory(functionName: string): Map<string, number> {
  const inventory = new Map<string, number>();
  for (const file of walkProductionTypeScript(SRC_DIR)) {
    const count = countDirectCalls(readFileSync(file, 'utf8'), functionName);
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

function directCallPositions(node: ts.Node): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression)) {
      const current = positions.get(child.expression.text) ?? [];
      current.push(child.getStart());
      positions.set(child.expression.text, current);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return positions;
}

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
    const calls = directCallPositions(findSsoExchangeHandler(source));
    const consumePositions = calls.get('consumeSsoTokenExchangeGrant') ?? [];
    const cookiePositions = calls.get('setRefreshTokenCookie') ?? [];

    expect(consumePositions).toHaveLength(1);
    expect(cookiePositions).toHaveLength(1);
    expect(cookiePositions[0]).toBeGreaterThan(consumePositions[0] ?? Number.POSITIVE_INFINITY);
  });

  it.skip('requires a guarded capability at every production issuer');
  it.skip('allows refresh cookie installation only from an authorized session result');
  it.skip('keeps SSO exchange inside the durable binding generation');
});
