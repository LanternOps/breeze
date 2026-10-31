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

// Check statically declared owners against the same shape enforced by alerts_owner_chk.
// Dynamic owner expressions (createSourcedAlert) have behavior tests at their producer.
function contradictsOwnerShape(fields: Map<string, string>): boolean {
  const owner = fields.get('ownerKind')?.replace(/^['"]|['"]$/g, '');
  const isNull = (value: string | undefined) => value === undefined || /^(null|undefined)$/i.test(value);
  if (owner === 'device') return isNull(fields.get('deviceId')) || !isNull(fields.get('topologySiteId'));
  if (owner === 'topology_site') return isNull(fields.get('topologySiteId'));
  if (owner === 'backup_workload') return !isNull(fields.get('deviceId')) || isNull(fields.get('ownerRef'));
  return false;
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
      const fields = new Map<string, string>();
      if (values && ts.isObjectLiteralExpression(values)) {
        for (const property of values.properties) {
          if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
            fields.set(property.name.getText(file).replace(/['"]/g, ''),
              ts.isPropertyAssignment(property) ? property.initializer.getText(file) : property.name.getText(file));
          }
        }
      }
      if (!hasOwner || contradictsOwnerShape(fields)) missing.push(line(node));
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node)) {
      const text = node.getText(file);
      for (const match of text.matchAll(/INSERT\s+INTO\s+(?:public\.)?alerts\s*\(([^)]*)\)/gi)) {
        const columns = (match[1] ?? '').split(',').map(column => column.trim().toLowerCase());
        const values = /^\s*VALUES\s*\(([^)]*)\)/i.exec(text.slice((match.index ?? 0) + match[0].length));
        const aliases: Record<string, string> = {
          owner_kind: 'ownerKind', device_id: 'deviceId', topology_site_id: 'topologySiteId', owner_ref: 'ownerRef',
        };
        const fields = new Map<string, string>();
        values?.[1]?.split(',').forEach((value, index) => {
          const name = aliases[columns[index] ?? ''];
          if (name) fields.set(name, value.trim());
        });
        if (!columns.includes('owner_kind') || (values && contradictsOwnerShape(fields))) missing.push(line(node));
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
      db.insert(alerts).values({ ownerKind: 'device', deviceId });
      // db.insert(alerts).values({ ownerKind: 'device', deviceId });`, 'fixture.ts')).toEqual([1]);
  });
  it.each([
    "db.insert(alerts).values({ ownerKind: 'device', deviceId, topologySiteId: siteId });",
    "db.insert(alerts).values({ ownerKind: 'device', deviceId: null });",
    "db.insert(alerts).values({ ownerKind: 'backup_workload', deviceId, ownerRef: 'workload' });",
    "db.insert(alerts).values({ ownerKind: 'topology_site', topologySiteId: null });",
    `db.execute(sql.raw("INSERT INTO alerts (owner_kind, device_id, topology_site_id) VALUES ('device', 'd1', 's1')"))`,
  ])('refuses explicit ownership that contradicts the row shape: %s', source => {
    expect(missingOwners(source, 'fixture.ts')).toEqual([1]);
  });
  it('accepts topology ownership with optional device provenance', () => {
    expect(missingOwners("db.insert(alerts).values({ ownerKind: 'topology_site', deviceId, topologySiteId: siteId });", 'fixture.ts'))
      .toEqual([]);
  });
});
