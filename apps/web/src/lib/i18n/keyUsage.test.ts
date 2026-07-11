import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { i18n } from './index';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Dynamic keys (t(variable)) cannot be checked statically. Each one must carry
// an explicit marker immediately before its argument: t(/* i18n-dynamic */ key).
const DYNAMIC_KEY_MARKER = /\/\*\s*i18n-dynamic\s*\*\//;

type NamespaceBindings = Map<ts.Node, Map<string, string[]>>;
type Exists = (key: string, namespace: string) => boolean;

function isI18nTranslationCall(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'i18n'
    && node.expression.name.text === 't';
}

function namespaceList(argument: ts.Expression | undefined): string[] {
  if (!argument) return ['common'];
  if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
    return [argument.text];
  }
  if (ts.isArrayLiteralExpression(argument)) {
    const namespaces = argument.elements
      .filter((element): element is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
        ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element))
      .map(element => element.text);
    return namespaces.length > 0 ? namespaces : ['common'];
  }
  return ['common'];
}

function lexicalScope(node: ts.Node): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isFunctionLike(current)) {
      return current;
    }
    current = current.parent;
  }
  return node.getSourceFile();
}

function collectNamespaceBindings(sourceFile: ts.SourceFile): NamespaceBindings {
  const bindings: NamespaceBindings = new Map();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression)
      && node.initializer.expression.text === 'useTranslation') {
      const namespaces = namespaceList(node.initializer.arguments[0]);
      let localName: string | undefined;
      if (ts.isObjectBindingPattern(node.name)) {
        const translationBinding = node.name.elements.find(element => {
          const importedName = element.propertyName ?? element.name;
          return ts.isIdentifier(importedName) && importedName.text === 't';
        });
        if (translationBinding && ts.isIdentifier(translationBinding.name)) {
          localName = translationBinding.name.text;
        }
      } else if (ts.isArrayBindingPattern(node.name)) {
        const first = node.name.elements[0];
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
          localName = first.name.text;
        }
      }
      if (localName) {
        const scope = lexicalScope(node);
        const scopeBindings = bindings.get(scope) ?? new Map<string, string[]>();
        scopeBindings.set(localName, namespaces);
        bindings.set(scope, scopeBindings);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function defaultNamespaces(sourceFile: ts.SourceFile): string[] {
  let result: string[] | undefined;
  function visit(node: ts.Node): void {
    if (result) return;
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'useTranslation') {
      result = namespaceList(node.arguments[0]);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result ?? ['common'];
}

function resolveNamespaces(node: ts.Node, name: string, bindings: NamespaceBindings): string[] | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const namespaces = bindings.get(current)?.get(name);
    if (namespaces) return namespaces;
    current = current.parent;
  }
  return undefined;
}

function hasCountOption(argument: ts.Expression | undefined): boolean {
  if (!argument || !ts.isObjectLiteralExpression(argument)) return false;
  return argument.properties.some(property => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = property.name;
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'count';
  });
}

function translationProblems(
  source: string,
  file: string,
  exists: Exists = (key, namespace) => i18n.exists(key, { ns: namespace, lng: 'en' }),
): string[] {
  const problems: string[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = collectNamespaceBindings(sourceFile);
  const fileNamespaces = defaultNamespaces(sourceFile);

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const localNamespaces = ts.isIdentifier(node.expression)
        ? resolveNamespaces(node, node.expression.text, bindings)
        : undefined;
      const isLegacyT = ts.isIdentifier(node.expression) && node.expression.text === 't';
      if (localNamespaces || isLegacyT || isI18nTranslationCall(node)) {
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
            : [localNamespaces?.[0] ?? (isLegacyT ? fileNamespaces[0] : 'common'), raw];
          const pluralExists = hasCountOption(node.arguments[1])
            && exists(`${key}_one`, namespace)
            && exists(`${key}_other`, namespace);
          if (!exists(key, namespace) && !pluralExists) {
            problems.push(`${location}: t('${raw}') → missing en ${namespace}:${key}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return problems;
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
  it('resolves namespace arrays and same-name bindings in their lexical scopes', () => {
    const checked: string[] = [];
    const source = `
      function Policies() {
        const { t } = useTranslation(['policies', 'common']);
        return t('policyTitle');
      }
      function Devices() {
        const { t } = useTranslation('devices');
        return t('deviceTitle');
      }
    `;
    expect(translationProblems(source, 'fixture.tsx', (key, namespace) => {
      checked.push(`${namespace}:${key}`);
      return true;
    })).toEqual([]);
    expect(checked).toEqual(['policies:policyTitle', 'devices:deviceTitle']);
  });

  it('continues to require the marker for dynamic keys with namespace arrays', () => {
    const source = `
      const { t } = useTranslation(['policies', 'common']);
      t(unmarkedKey);
      t(/* i18n-dynamic */ markedKey);
    `;
    expect(translationProblems(source, 'fixture.tsx')).toEqual([
      'fixture.tsx:3: dynamic translation key requires /* i18n-dynamic */ before the argument',
    ]);
  });

  it('accepts plural families when a literal count option is supplied', () => {
    const source = `
      const { t } = useTranslation('backup');
      t('running', { count: deviceCount });
    `;
    expect(translationProblems(source, 'fixture.tsx', (key, namespace) =>
      namespace === 'backup' && (key === 'running_one' || key === 'running_other')
    )).toEqual([]);
  });

  it('every literal t() key resolves in en', () => {
    const problems: string[] = [];
    for (const file of walk(srcDir)) {
      const source = readFileSync(file, 'utf8');
      problems.push(...translationProblems(source, file));
    }
    expect(problems, problems.join('\n')).toEqual([]);
  }, 30_000);
});
