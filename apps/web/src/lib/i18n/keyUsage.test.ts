import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Dynamic keys (t(variable)) cannot be checked statically. Each one must carry
// an explicit marker immediately before its argument: t(/* i18n-dynamic */ key).
const USE_TRANSLATION = /useTranslation\(\s*['"]([\w-]+)['"]\s*\)/;
const DYNAMIC_KEY_MARKER = /\/\*\s*i18n-dynamic\s*\*\//;

function isTranslationCall(node: ts.CallExpression): boolean {
  if (ts.isIdentifier(node.expression)) return node.expression.text === 't';
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'i18n'
    && node.expression.name.text === 't';
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__mocks__') yield* walk(path);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      yield path;
    }
  }
}

describe('translation key usage', () => {
  it('every literal t() key resolves in en', () => {
    const problems: string[] = [];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8');
      const fileNamespace = source.match(USE_TRANSLATION)?.[1] ?? 'common';
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && isTranslationCall(node)) {
          const argument = node.arguments[0];
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const location = `${file.replace(srcDir, 'src')}:${line + 1}`;
          if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
            const leadingTrivia = argument
              ? source.slice(argument.getFullStart(), argument.getStart(sourceFile))
              : source.slice(node.expression.end, node.end);
            if (!DYNAMIC_KEY_MARKER.test(leadingTrivia)) {
              problems.push(`${location}: dynamic translation key requires /* i18n-dynamic */ before the argument`);
            }
          } else {
            const raw = argument.text;
            const [namespace, key] = raw.includes(':')
              ? raw.split(':', 2)
              : [fileNamespace, raw];
            if (!i18n.exists(key, { ns: namespace, lng: 'en' })) {
              problems.push(`${location}: t('${raw}') → missing en ${namespace}:${key}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  }, 30_000);
});
