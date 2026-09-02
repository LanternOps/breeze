import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');

const expectedCreateTokenPairFiles = new Set<string>();

const expectedCookieWriterFiles = new Set([
  'routes/sso.ts',
]);

const expectedGuardedIssuerFiles = new Map([
  ['middleware/cfAccessLogin.ts', 1],
  ['routes/auth/login.ts', 2],
  ['routes/auth/mfa.ts', 1],
  ['routes/auth/passkeys.ts', 1],
  ['routes/auth/verifyEmail.ts', 2],
  ['routes/auth/invite.ts', 1],
  ['routes/auth/cfAccessRedirectLogin.ts', 1],
  ['routes/auth/ssoLinkCompletion.ts', 1],
  ['routes/sso.ts', 1],
  ['services/mfaEnrollmentSession.ts', 1],
]);

const expectedSingleBoundaryFiles = new Map([
  ['middleware/cfAccessLogin.ts', 1],
  ['routes/auth/login.ts', 2],
  ['routes/auth/mfa.ts', 1],
  ['routes/auth/passkeys.ts', 1],
  ['routes/auth/verifyEmail.ts', 1],
  ['routes/auth/invite.ts', 1],
  ['routes/auth/cfAccessRedirectLogin.ts', 1],
]);
const expectedLegacyIssuerFiles = new Map(expectedSingleBoundaryFiles);
const expectedGuardedCookieInstallerFiles = new Map([
  ...expectedSingleBoundaryFiles,
  ['routes/auth/mfa.ts', 4],
  ['routes/auth/passkeys.ts', 3],
  ['routes/auth/phone.ts', 1],
  ['routes/sso.ts', 1],
]);
const expectedLegacyCookieInstallerFiles = new Map(expectedSingleBoundaryFiles);

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
        || calledName === 'installLegacyUserSessionCookiesDuringTransition'
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
  installLegacyUserSessionCookiesDuringTransition: Map<string, number>;
  recordAuthTransitionLegacyIssuer: Map<string, number>;
}> {
  const createTokenPair = new Map<string, number>();
  const setRefreshTokenCookie = new Map<string, number>();
  const issueUserSession = new Map<string, number>();
  const issueUserSessionLegacyDuringTransition = new Map<string, number>();
  const installAuthorizedUserSessionCookies = new Map<string, number>();
  const installLegacyUserSessionCookiesDuringTransition = new Map<string, number>();
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
    const legacyInstallerCount = counts.get('installLegacyUserSessionCookiesDuringTransition') ?? 0;
    const metricCount = counts.get('recordAuthTransitionLegacyIssuer') ?? 0;
    if (guardedCount > 0 && rel !== 'services/userSession.ts') issueUserSession.set(rel, guardedCount);
    if (legacyCount > 0 && rel !== 'services/userSession.ts') {
      issueUserSessionLegacyDuringTransition.set(rel, legacyCount);
    }
    if (installerCount > 0 && rel !== 'routes/auth/helpers.ts') {
      installAuthorizedUserSessionCookies.set(rel, installerCount);
    }
    if (legacyInstallerCount > 0 && rel !== 'routes/auth/helpers.ts') {
      installLegacyUserSessionCookiesDuringTransition.set(rel, legacyInstallerCount);
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
    installLegacyUserSessionCookiesDuringTransition,
    recordAuthTransitionLegacyIssuer,
  };
}

const frozenInventory = buildInventories();

describe('frozen authentication issuer inventory', () => {
  it('has no direct production createTokenPair caller outside the guarded issuer', () => {
    const calls = frozenInventory.createTokenPair;
    expect(new Set(calls.keys())).toEqual(expectedCreateTokenPairFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it('leaves exactly the SSO later-slice direct refresh-cookie write', () => {
    const calls = frozenInventory.setRefreshTokenCookie;
    expect(new Set(calls.keys())).toEqual(expectedCookieWriterFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(calls.get('routes/sso.ts')).toBe(1);
  });

  it('freezes the guarded issuer, rollout seam, and branded installer callers', () => {
    expect(frozenInventory.issueUserSession).toEqual(expectedGuardedIssuerFiles);
    expect(frozenInventory.issueUserSessionLegacyDuringTransition).toEqual(expectedLegacyIssuerFiles);
    expect(frozenInventory.installAuthorizedUserSessionCookies).toEqual(expectedGuardedCookieInstallerFiles);
    expect(frozenInventory.installLegacyUserSessionCookiesDuringTransition).toEqual(expectedLegacyCookieInstallerFiles);
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
    expect(declarations[0]?.type?.getText(ast)).toBe('Promise<LegacyUserSessionDuringTransition>');
  });

  it('keeps the legacy cookie boundary exact and branded', () => {
    const source = readFileSync(join(SRC_DIR, 'routes/auth/helpers.ts'), 'utf8');
    const ast = ts.createSourceFile('helpers.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declarations: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'installLegacyUserSessionCookiesDuringTransition') {
        declarations.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.parameters).toHaveLength(2);
    expect(declarations[0]?.parameters[0]?.name.getText(ast)).toBe('c');
    expect(declarations[0]?.parameters[1]?.name.getText(ast)).toBe('issued');
    expect(declarations[0]?.parameters[1]?.type?.getText(ast)).toBe('LegacyUserSessionDuringTransition');
  });

  it('has no assertion bypass around either branded cookie boundary', () => {
    const assertions: string[] = [];
    for (const [rel] of expectedGuardedIssuerFiles) {
      const file = join(SRC_DIR, rel);
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (
          ts.isAsExpression(node)
          && /^(AuthorizedUserSession|LegacyUserSessionDuringTransition)$/.test(node.type.getText(ast))
        ) {
          assertions.push(`${rel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(assertions).toEqual([]);
  });

  it('keeps every converted W07-C guarded issuer lexically inside finishAuthIssuance', () => {
    const converted = [
      'routes/auth/verifyEmail.ts',
      'routes/auth/invite.ts',
      'routes/auth/cfAccessRedirectLogin.ts',
    ];
    const outsideFinalization: string[] = [];
    for (const rel of converted) {
      const file = join(SRC_DIR, rel);
      const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === 'issueUserSession') {
          let current: ts.Node | undefined = node.parent;
          let guarded = false;
          while (current && !ts.isSourceFile(current)) {
            if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
              && ts.isCallExpression(current.parent)
              && ts.isIdentifier(current.parent.expression)
              && current.parent.expression.text === 'finishAuthIssuance'
              && current.parent.arguments.includes(current)) {
              guarded = true;
              break;
            }
            current = current.parent;
          }
          if (!guarded) {
            outsideFinalization.push(`${rel}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    expect(outsideFinalization).toEqual([]);
  });

  it('keeps SSO callback issuance and exchange installation behind durable boundaries', () => {
    const file = join(SRC_DIR, 'routes/sso.ts');
    const sourceText = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const calls: Array<{ name: string; start: number; node: ts.CallExpression }> = [];
    const processLocalGrantMaps: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'Map'
        && ts.isVariableDeclaration(node.parent)
        && ts.isIdentifier(node.parent.name)
        && node.parent.name.text === 'ssoTokenExchangeGrants') {
        processLocalGrantMaps.push(node.getStart(ast));
      }
      if (ts.isCallExpression(node)) {
        const name = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : '';
        if (name) calls.push({ name, start: node.getStart(ast), node });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);

    expect(processLocalGrantMaps).toEqual([]);
    expect(calls.filter(({ name }) => name === 'createTokenPair')).toEqual([]);

    const issueCall = calls.find(({ name }) => name === 'issueUserSession');
    expect(issueCall).toBeDefined();
    let owner: ts.Node | undefined = issueCall?.node.parent;
    let insideFinalization = false;
    while (owner && !ts.isSourceFile(owner)) {
      if ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))
        && ts.isCallExpression(owner.parent)
        && ts.isIdentifier(owner.parent.expression)
        && owner.parent.expression.text === 'finishAuthIssuance'
        && owner.parent.arguments.includes(owner)) {
        insideFinalization = true;
        break;
      }
      owner = owner.parent;
    }
    expect(insideFinalization).toBe(true);

    const durableCreate = calls.find(({ name }) => name === 'createDurableSsoExchangeGrant');
    expect(durableCreate).toBeDefined();
    const consume = calls.find(({ name }) => name === 'consumeDurableSsoExchangeGrant');
    const install = calls.find(({ name }) => name === 'setRefreshTokenCookie');
    expect(consume).toBeDefined();
    expect(install).toBeDefined();
    expect(consume!.start).toBeLessThan(install!.start);
  });
});
