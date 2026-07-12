import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');
const LOW_LEVEL_ISSUERS = [
  'createAccessToken',
  'createRefreshToken',
  'createRefreshTokenWithJti',
  'createTokenPair',
  'mintRefreshTokenFamily',
  'bindRefreshJtiToFamily',
];
const APPROVED_LOW_LEVEL_ISSUER_FILES = new Set([
  'services/jwt.ts',
  'services/refreshTokenFamily.ts',
  'services/userSession.ts',
]);

function walkProductionTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...walkProductionTypeScript(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function findLowLevelIssuerIdentifiers(source: string): string[] {
  const found = new Set<string>();
  const sourceFile = ts.createSourceFile(
    'issuer-audit.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node)
      && !node.exportClause
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (node.moduleSpecifier.text === './jwt') {
        found.add('createAccessToken');
        found.add('createRefreshToken');
        found.add('createRefreshTokenWithJti');
        found.add('createTokenPair');
      }
      if (node.moduleSpecifier.text === './refreshTokenFamily') {
        found.add('mintRefreshTokenFamily');
        found.add('bindRefreshJtiToFamily');
      }
    }
    if (ts.isIdentifier(node) && LOW_LEVEL_ISSUERS.includes(node.text)) {
      found.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return LOW_LEVEL_ISSUERS.filter((issuer) => found.has(issuer));
}

describe('first-party user session issuer coverage', () => {
  it.each([
    ['named import', "import { createTokenPair } from './jwt';", 'createTokenPair'],
    [
      'namespace import usage',
      "import * as services from './index'; void services.createTokenPair;",
      'createTokenPair',
    ],
    [
      'dynamic import destructuring',
      "const { mintRefreshTokenFamily } = await import('./refreshTokenFamily');",
      'mintRefreshTokenFamily',
    ],
    [
      're-export',
      "export { bindRefreshJtiToFamily } from './refreshTokenFamily';",
      'bindRefreshJtiToFamily',
    ],
    ['access-token creator', "createAccessToken({} as never);", 'createAccessToken'],
    ['refresh-token creator', "createRefreshToken({} as never);", 'createRefreshToken'],
    [
      'refresh-token creator with jti',
      "createRefreshTokenWithJti({} as never);",
      'createRefreshTokenWithJti',
    ],
    ['wildcard jwt re-export', "export * from './jwt';", 'createAccessToken'],
    [
      'wildcard refresh-family re-export',
      "export * from './refreshTokenFamily';",
      'mintRefreshTokenFamily',
    ],
  ])('detects %s', (_name, source, issuer) => {
    expect(findLowLevelIssuerIdentifiers(source)).toContain(issuer);
  });

  it('production API TypeScript uses low-level issuers only in approved services', () => {
    const offenders = walkProductionTypeScript(SRC_DIR)
      .filter((file) => !APPROVED_LOW_LEVEL_ISSUER_FILES.has(relative(SRC_DIR, file)))
      .filter((file) => findLowLevelIssuerIdentifiers(readFileSync(file, 'utf8')).length > 0)
      .map((file) => relative(SRC_DIR, file))
      .sort();

    expect(
      offenders,
      `First-party routes and middleware must use issueUserSession instead of low-level token issuers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
