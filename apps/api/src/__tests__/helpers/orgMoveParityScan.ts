/**
 * Static scan of the org-move engine for the §5.8 parity test
 * (services/deviceInstallBoundary/orgMoveParity.test.ts). Kept beside the manifest rather than in the test so
 * the scanner itself can be unit-tested against fixtures.
 *
 * It reads one source file with the TypeScript compiler API and returns the
 * device-bound writes and helper calls it makes, as stable keys:
 *  - `table:<name>` for every table the file UPDATEs or DELETEs, whether
 *    through drizzle (`tx.update(deviceCommands)`, resolved through the schema
 *    export to its SQL name) or raw SQL in a `sql\`...\`` template (`UPDATE x`,
 *    `DELETE FROM x`, and `UPDATE ${sql.identifier('x')}`);
 *  - `call:<name>` for every function it calls that it imported from another
 *    module (drizzle-orm's query builders excluded);
 *  - `sqlfn:<name>` for every `breeze_*` database function a raw statement
 *    calls (a write can hide in one, e.g. the custom-field re-home).
 * A raw statement whose table is a runtime variable (`sql.identifier(table)` in
 * a loop) has no static name; the loop's table getter is a `call:` key instead.
 */
import ts from 'typescript';
import { getTableName, isTable } from 'drizzle-orm';
import * as schema from '../../db/schema';

const WRITE_PREFIX = /\b(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?$/i;
const WRITE_STATEMENT = /\b(?:UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\b/gi;
const NOT_A_TABLE = new Set(['of', 'set', 'nowait', 'skip']);
const DB_FUNCTION_CALL = /\b(?:public\.)?(breeze_[a-z0-9_]+)\s*\(/gi;

function schemaTableName(identifier: string): string | null {
  const value = (schema as Record<string, unknown>)[identifier];
  return value && isTable(value) ? getTableName(value) : null;
}

function importedNames(source: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) names.set(element.name.text, from);
    }
  }
  return names;
}

function templateWrites(node: ts.TaggedTemplateExpression, keys: Set<string>): void {
  const template = node.template;
  const chunks: Array<{ text: string; next?: ts.Expression }> = ts.isNoSubstitutionTemplateLiteral(template)
    ? [{ text: template.text }]
    : [
        { text: template.head.text, next: template.templateSpans[0]?.expression },
        ...template.templateSpans.map((span, i) => ({
          text: span.literal.text,
          next: template.templateSpans[i + 1]?.expression,
        })),
      ];
  for (const chunk of chunks) {
    for (const match of chunk.text.matchAll(DB_FUNCTION_CALL)) keys.add(`sqlfn:${match[1]!.toLowerCase()}`);
    for (const match of chunk.text.matchAll(WRITE_STATEMENT)) {
      const name = match[1]!.toLowerCase();
      if (!NOT_A_TABLE.has(name)) keys.add(`table:${name}`);
    }
    // `UPDATE ${sql.identifier('time_entries')} SET ...`
    if (chunk.next && WRITE_PREFIX.test(chunk.text) && ts.isCallExpression(chunk.next)) {
      const [arg] = chunk.next.arguments;
      if (
        ts.isPropertyAccessExpression(chunk.next.expression)
        && chunk.next.expression.name.text === 'identifier'
        && arg && ts.isStringLiteral(arg)
      ) {
        keys.add(`table:${arg.text}`);
      }
    }
  }
}

export function scanOrgMoveWrites(sourceText: string, fileName = 'moveDeviceOrgInTransaction.ts'): Set<string> {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const imports = importedNames(source);
  const keys = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(source) === 'sql') {
      templateWrites(node, keys);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const from = imports.get(callee.text);
        if (from !== undefined && from !== 'drizzle-orm') keys.add(`call:${callee.text}`);
      } else if (
        ts.isPropertyAccessExpression(callee)
        && (callee.name.text === 'update' || callee.name.text === 'delete')
      ) {
        const [arg] = node.arguments;
        if (arg && ts.isIdentifier(arg)) {
          const table = schemaTableName(arg.text);
          if (table) keys.add(`table:${table}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}
