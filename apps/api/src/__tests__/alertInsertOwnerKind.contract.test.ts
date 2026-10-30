import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'testUtils') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

// Parse statements so a nearby, unrelated ownerKind (or a comment) cannot
// satisfy a writer. Each .insert(alerts).values(...) must own its values.
function missingOwners(source: string, filename: string): number[] {
  // Most API modules never write alerts; only parse candidate writers.
  if (!/\.insert\s*\(\s*alerts\s*\)|INSERT\s+INTO\s+(?:public\.)?alerts/i.test(source)) return [];
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const missing: number[] = [];
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'insert' && node.arguments[0]?.getText(file) === 'alerts') {
      const valuesAccess = node.parent;
      const valuesCall = valuesAccess.parent;
      const values = ts.isPropertyAccessExpression(valuesAccess) && valuesAccess.name.text === 'values'
        && ts.isCallExpression(valuesCall) ? valuesCall.arguments[0] : undefined;
      const hasOwner = values && ts.isObjectLiteralExpression(values) && values.properties.some(property =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(file).replace(/['"]/g, '') === 'ownerKind');
      if (!hasOwner) missing.push(line(node));
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      const text = node.getText(file);
      for (const match of text.matchAll(/INSERT\s+INTO\s+(?:public\.)?alerts\s*\(([^)]*)\)/gi)) {
        if (!/\bowner_kind\b/i.test(match[1] ?? '')) missing.push(line(node));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return missing;
}

describe('alert insert owner contract', () => {
  it('requires explicit ownership in every production alert insert statement', () => {
    const offenders = sourceFiles(src).flatMap(path => missingOwners(readFileSync(path, 'utf8'), path)
      .map(line => `${relative(src, path)}:${line}`));
    expect(offenders, 'Alert inserts missing ownerKind/owner_kind').toEqual([]);
  });
  it('also checks raw SQL string literals', () => {
    expect(missingOwners('db.execute(sql.raw("INSERT INTO alerts (device_id) VALUES (NULL)"))', 'fixture.ts'))
      .toEqual([1]);
  });
  it('does not accept ownership on another insert or in a comment', () => {
    expect(missingOwners(`db.insert(alerts).values({ deviceId });
      db.insert(alerts).values({ ownerKind: 'device' });
      // db.insert(alerts).values({ ownerKind: 'device' });`, 'fixture.ts')).toEqual([1]);
  });
});
