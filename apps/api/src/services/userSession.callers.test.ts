import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '..');

const expectedCreateTokenPairFiles = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/mfa.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);

const expectedCookieWriterFiles = new Set([
  'middleware/cfAccessLogin.ts',
  'routes/auth/cfAccessRedirectLogin.ts',
  'routes/auth/invite.ts',
  'routes/auth/login.ts',
  'routes/auth/mfa.ts',
  'routes/auth/passkeys.ts',
  'routes/auth/verifyEmail.ts',
  'routes/sso.ts',
]);

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
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && (node.expression.text === 'createTokenPair' || node.expression.text === 'setRefreshTokenCookie')
    ) {
      counts.set(node.expression.text, (counts.get(node.expression.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

function buildInventories(): Readonly<{
  createTokenPair: Map<string, number>;
  setRefreshTokenCookie: Map<string, number>;
}> {
  const createTokenPair = new Map<string, number>();
  const setRefreshTokenCookie = new Map<string, number>();
  for (const file of productionTypeScriptFiles(SRC_DIR)) {
    const rel = relative(SRC_DIR, file);
    const counts = directCalls(file);
    const issuerCount = counts.get('createTokenPair') ?? 0;
    const cookieCount = counts.get('setRefreshTokenCookie') ?? 0;
    if (issuerCount > 0 && rel !== 'services/jwt.ts') createTokenPair.set(rel, issuerCount);
    if (cookieCount > 0 && rel !== 'routes/auth/helpers.ts') setRefreshTokenCookie.set(rel, cookieCount);
  }
  return { createTokenPair, setRefreshTokenCookie };
}

const frozenInventory = buildInventories();

describe('frozen authentication issuer inventory', () => {
  it('contains exactly nine createTokenPair calls in the reviewed issuer files', () => {
    const calls = frozenInventory.createTokenPair;
    expect(new Set(calls.keys())).toEqual(expectedCreateTokenPairFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(9);
    expect(calls.get('routes/auth/login.ts')).toBe(2);
    expect(calls.get('routes/sso.ts')).toBe(1);
  });

  it('contains exactly nine refresh-cookie writes in the reviewed boundaries', () => {
    const calls = frozenInventory.setRefreshTokenCookie;
    expect(new Set(calls.keys())).toEqual(expectedCookieWriterFiles);
    expect([...calls.values()].reduce((sum, count) => sum + count, 0)).toBe(9);
    expect(calls.get('routes/auth/login.ts')).toBe(2);
    expect(calls.get('routes/sso.ts')).toBe(1);
  });

  it.skip('requires guarded capability at every issuer', () => {});
  it.skip('has no legacy session issuer export', () => {});
  it.skip('has no process-local SSO exchange grant', () => {});
});
