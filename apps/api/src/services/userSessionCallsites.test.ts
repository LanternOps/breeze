import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = join(__dirname, '..');
const PRODUCTION_ISSUER_DIRS = [
  join(SRC_DIR, 'routes'),
  join(SRC_DIR, 'middleware'),
];
const LOW_LEVEL_ISSUERS = [
  'createTokenPair',
  'mintRefreshTokenFamily',
  'bindRefreshJtiToFamily',
];

function walkProductionTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walkProductionTypeScript(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('first-party user session issuer coverage', () => {
  it('routes and middleware do not import low-level token issuers', () => {
    const importDeclaration = /import\s+(?:type\s+)?[\w$*{},\s]+\s+from\s+['"][^'"]+['"]/g;
    const offenders = PRODUCTION_ISSUER_DIRS
      .flatMap(walkProductionTypeScript)
      .filter((file) => {
        const imports = readFileSync(file, 'utf8').match(importDeclaration) ?? [];
        return imports.some((declaration) =>
          LOW_LEVEL_ISSUERS.some((issuer) =>
            new RegExp(String.raw`\b${issuer}\b`).test(declaration),
          ),
        );
      })
      .map((file) => relative(SRC_DIR, file))
      .sort();

    expect(
      offenders,
      `First-party routes and middleware must use issueUserSession instead of low-level token issuers:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
