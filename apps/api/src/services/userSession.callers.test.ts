import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');

const expectedCreateTokenPairFiles = new Set([
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);

const expectedCookieWriterFiles = new Set([
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);

const expectedGuardedIssuerFiles = new Map([
  ['middleware/cfAccessLogin.ts', 1],
  ['routes/auth/login.ts', 2],
  ['routes/auth/mfa.ts', 1],
  ['routes/auth/passkeys.ts', 1],
]);

const expectedLegacyIssuerFiles = new Map(expectedGuardedIssuerFiles);
const expectedGuardedCookieInstallerFiles = new Map(expectedGuardedIssuerFiles);

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = join(dir, entry);
    if (statSync(file).isDirectory()) {
      return entry === '__tests__' ? [] : productionTypeScriptFiles(file);
    }
    return file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.spec.ts')
      ? [file]
      : [];
  });
}

function directCalls(file: string): Map<string, number> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const counts = new Map<string, number>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const calledName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (
        calledName === 'createTokenPair'
        || calledName === 'setRefreshTokenCookie'
        || calledName === 'issueUserSession'
        || calledName === 'issueUserSessionLegacyDuringTransition'
        || calledName === 'installAuthorizedUserSessionCookies'
        || calledName === 'recordAuthTransitionLegacyIssuer'
      ) {
        counts.set(calledName, (counts.get(calledName) ?? 0) + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

function buildInventories(): Readonly<{
  createTokenPair: Map<string, number>;
  setRefreshTokenCookie: Map<string, number>;
  issueUserSession: Map<string, number>;
  issueUserSessionLegacyDuringTransition: Map<string, number>;
  installAuthorizedUserSessionCookies: Map<string, number>;
  recordAuthTransitionLegacyIssuer: Map<string, number>;
}> {
  const createTokenPair = new Map<string, number>();
  const setRefreshTokenCookie = new Map<string, number>();
  const issueUserSession = new Map<string, number>();
  const issueUserSessionLegacyDuringTransition = new Map<string, number>();
  const installAuthorizedUserSessionCookies = new Map<string, number>();
  const recordAuthTransitionLegacyIssuer = new Map<string, number>();
  for (const file of productionTypeScriptFiles(SRC_DIR)) {
    const rel = relative(SRC_DIR, file);
    const counts = directCalls(file);
    const issuerCount = counts.get('createTokenPair') ?? 0;
    const cookieCount = counts.get('setRefreshTokenCookie') ?? 0;
    if (issuerCount > 0 && rel !== 'services/jwt.ts' && rel !== 'services/userSession.ts') {
      createTokenPair.set(rel, issuerCount);
    }
    if (cookieCount > 0 && rel !== 'routes/auth/helpers.ts') setRefreshTokenCookie.set(rel, cookieCount);
    const guardedCount = counts.get('issueUserSession') ?? 0;
    const legacyCount = counts.get('issueUserSessionLegacyDuringTransition') ?? 0;
    const installerCount = counts.get('installAuthorizedUserSessionCookies') ?? 0;
    const metricCount = counts.get('recordAuthTransitionLegacyIssuer') ?? 0;
    if (guardedCount > 0 && rel !== 'services/userSession.ts') issueUserSession.set(rel, guardedCount);
    if (legacyCount > 0 && rel !== 'services/userSession.ts') {
      issueUserSessionLegacyDuringTransition.set(rel, legacyCount);
    }
    if (installerCount > 0 && rel !== 'routes/auth/helpers.ts') {
      installAuthorizedUserSessionCookies.set(rel, installerCount);
    }
    if (metricCount > 0 && rel !== 'services/authTransitionMetrics.ts') {
      recordAuthTransitionLegacyIssuer.set(rel, metricCount);
    }
  }
  return {
    createTokenPair,
    setRefreshTokenCookie,
    issueUserSession,
    issueUserSessionLegacyDuringTransition,
    installAuthorizedUserSessionCookies,
    recordAuthTransitionLegacyIssuer,
  };
}

const frozenInventory = buildInventories();

describe('frozen authentication issuer inventory', () => {
  it('leaves exactly the four later-slice createTokenPair calls', () => {
    const calls = frozenInventory.createTokenPair;
    expect(new Set(calls.keys())).toEqual(expectedCreateTokenPairFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(calls.get('routes/sso.ts')).toBe(1);
  });

  it('leaves exactly the four later-slice direct refresh-cookie writes', () => {
    const calls = frozenInventory.setRefreshTokenCookie;
    expect(new Set(calls.keys())).toEqual(expectedCookieWriterFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(calls.get('routes/sso.ts')).toBe(1);
  });

  it('freezes the guarded issuer, rollout seam, and branded installer callers', () => {
    expect(frozenInventory.issueUserSession).toEqual(expectedGuardedIssuerFiles);
    expect(frozenInventory.issueUserSessionLegacyDuringTransition).toEqual(expectedLegacyIssuerFiles);
    expect(frozenInventory.installAuthorizedUserSessionCookies).toEqual(expectedGuardedCookieInstallerFiles);
    expect(frozenInventory.recordAuthTransitionLegacyIssuer).toEqual(expectedLegacyIssuerFiles);
  });

  it('keeps the rollout seam exact and one-argument', () => {
    const source = readFileSync(join(SRC_DIR, 'services/userSession.ts'), 'utf8');
    const ast = ts.createSourceFile('userSession.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'issueUserSessionLegacyDuringTransition') {
        declarations.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.parameters).toHaveLength(1);
    expect(declarations[0]?.parameters[0]?.name.getText(ast)).toBe('identity');
  });

  it.skip('has no process-local SSO exchange grant', () => {});
});
