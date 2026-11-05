/**
 * #9692 — a correlated `sql` subquery in the selection of a single-table drizzle
 * query silently binds its outer column to the INNER table when that table has a
 * column of the same name (#9644).
 *
 * With no joins, drizzle's `buildSelection` runs in `isSingleTable` mode and
 * rewrites every column that is a DIRECT chunk of a selection `sql` to a bare
 * identifier:
 *
 *   db.select({ n: sql`(select max(${jobs.at}) from ${jobs} where ${jobs.profileId} = ${profiles.id})` })
 *     .from(profiles)
 *   -- renders: (select max("at") from "jobs" where "profile_id" = "id")
 *
 * `"id"` resolves to jobs.id, the value is NULL (or a wrong number) for every
 * row, nothing throws, and route tests that mock `db` cannot see it.
 *
 * The sweep is an AST walk, not a regex: which chunk is "direct" depends on the
 * template's structure (a nested sql`` or eq() keeps its qualifiers), whether the
 * chain has a join decides the mode, and selections and helpers are often declared
 * away from the `.select()` call. Those are all things a regex would have to guess.
 *
 * The first block pins drizzle's real rendering, so an upgrade that changes the
 * rule fails here and the walker's model gets re-reviewed.
 *
 * Known limit: selections and helpers reached through an object's property
 * (`{ x: projections.foo }`, `helpers.f(outer.id)`) are not followed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Column, eq, is, sql } from 'drizzle-orm';
import { getTableConfig, PgTable, pgTable, QueryBuilder, text, uuid } from 'drizzle-orm/pg-core';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reviewed hits that are correct as written: the stripped column name exists only
 * on the outer table, so it still reaches the outer row. Key:
 * `<path>::<outer table>.<field>` (not a line number, so unrelated edits do not
 * churn it). Each needs a reason. An entry cannot excuse a shadowed column: if a
 * migration adds that name to the inner table, the shadow check below fails.
 * Prefer fixing a new hit over adding it here.
 */
const noColumn = (inner: string, column: string) =>
  `${inner} has no ${column} column, so the bare name still reaches the outer row`;
const ALLOWLIST: Record<string, string> = {
  'jobs/businessCalendarRecomputeWorker.ts::tickets.calendarId': noColumn('business_calendar_revisions', 'sla_calendar_revision_id'),
  'routes/agentWs.ts::devices.partnerId': noColumn('organizations', 'org_id'),
  'routes/agentWs.ts::devices.orgType': noColumn('organizations', 'org_id'),
  'routes/enrollmentKeys.ts::installerBootstrapTokens.liveConsumed': noColumn('enrollment_keys', 'parent_enrollment_key_id'),
  'routes/enrollmentKeys.ts::installerBootstrapTokens.liveMax': noColumn('enrollment_keys', 'parent_enrollment_key_id'),
  'routes/enrollmentKeys.ts::enrollmentKeys.siteName': noColumn('sites', 'site_id'),
  'routes/portal/auth.ts::portalUsers.orgName': noColumn('organizations', 'org_id'),
  'routes/roles.ts::partnerUsers.activeCount': noColumn('users', 'user_id'),
  'routes/roles.ts::organizationUsers.activeCount': noColumn('users', 'user_id'),
  'routes/unifi/index.ts::sites.partnerId': noColumn('organizations', 'org_id'),
  'services/aiToolsAlerts.ts::alerts.orgName': noColumn('organizations', 'org_id'),
  'services/businessCalendars/repository.ts::tickets.revisionCalendarId': noColumn('business_calendar_revisions', 'sla_calendar_revision_id'),
  'services/businessCalendars/repository.ts::tickets.revisionNumber': noColumn('business_calendar_revisions', 'sla_calendar_revision_id'),
  'services/softwarePolicyInstallPreview.ts::softwareComplianceStatus.eligible':
    'the only inner source is jsonb_array_elements(...) AS elem, which exposes no "violations" column',
};

/** Inner sources that are not tables, so the shadow check has no columns to compare. */
const NON_TABLE_INNER_SOURCES = new Set(['jsonb_array_elements']);

interface Hit {
  file: string;
  definedAt: string;
  field: string;
  outer: string;
  columns: string[];
  inner: string[];
  via: 'select' | 'returning';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'testUtils' || entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name) ? [path] : [];
  });
}

type Decl = { expr?: ts.Expression; params: string[]; returns: ts.Expression[] };
type Env = Map<string, string>;

const SELECT_METHODS = new Set(['select', 'selectDistinct', 'selectDistinctOn']);

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)
  ) current = current.expression;
  return current;
}

function returnsOf(body: ts.ConciseBody): ts.Expression[] {
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

const paramNames = (params: ts.NodeArray<ts.ParameterDeclaration>) => params.map((p) => p.name.getText());

/** Every named const/function in a file, so selections declared away from `.select()` still resolve. */
function collectDecls(file: ts.SourceFile): Map<string, Decl[]> {
  const decls = new Map<string, Decl[]>();
  const add = (name: string, decl: Decl) => decls.set(name, [...(decls.get(name) ?? []), decl]);
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      add(node.name.text, { params: paramNames(node.parameters), returns: returnsOf(node.body) });
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        add(node.name.text, { params: paramNames(init.parameters), returns: returnsOf(init.body) });
      } else {
        add(node.name.text, { expr: init, params: [], returns: [] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return decls;
}

function asSelectCall(node: ts.Expression | undefined): ts.CallExpression | undefined {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  return SELECT_METHODS.has(node.expression.name.text) ? node : undefined;
}

/**
 * The select call behind `.from(...)`, direct or held in a const
 * (`const q = db.select(...); q.from(t)`). Undefined when this `.from` is not a select's.
 */
function selectCallOf(from: ts.CallExpression, decls: Map<string, Decl[]>): ts.CallExpression | undefined {
  if (!ts.isPropertyAccessExpression(from.expression) || from.expression.name.text !== 'from') return undefined;
  const receiver = unwrap(from.expression.expression);
  if (ts.isIdentifier(receiver)) {
    return decls.get(receiver.text)?.map((decl) => asSelectCall(decl.expr)).find(Boolean);
  }
  return asSelectCall(receiver);
}

/** `sql` plus any local name drizzle's `sql` is imported under in this file. */
function isSqlTag(tag: ts.Expression): boolean {
  if (!ts.isIdentifier(tag)) return false;
  if (tag.text === 'sql') return true;
  return tag.getSourceFile().statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
    if (statement.moduleSpecifier.text !== 'drizzle-orm') return false;
    const bindings = statement.importClause?.namedBindings;
    return !!bindings && ts.isNamedImports(bindings) && bindings.elements.some(
      (el) => el.name.text === tag.text && el.propertyName?.text === 'sql',
    );
  });
}

/** Method names applied after `.from(...)` on the same fluent chain. */
function chainedMethods(node: ts.Expression): string[] {
  const methods: string[] = [];
  let current: ts.Node = node;
  while (true) {
    let parent: ts.Node = current.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
      current = parent;
      parent = current.parent;
    }
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== current) return methods;
    methods.push(parent.name.text);
    const call = parent.parent;
    if (!ts.isCallExpression(call) || call.expression !== parent) return methods;
    current = call;
  }
}

/**
 * Text of a column reference (`table.col`), with function parameters and local
 * `const c = table.col` aliases substituted. Undefined for anything else.
 */
function columnRef(expr: ts.Expression, env: Env, decls: Map<string, Decl[]>): string | undefined {
  const node = unwrap(expr);
  if (ts.isIdentifier(node)) {
    const bound = env.get(node.text);
    if (bound) return bound;
    const decl = decls.get(node.text)?.find((d) => d.expr && ts.isPropertyAccessExpression(d.expr));
    return decl?.expr?.getText();
  }
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const text = node.getText().replace(/\s+/g, '');
  const root = text.split('.')[0]!;
  const bound = env.get(root);
  return bound ? `${bound}${text.slice(root.length)}` : text;
}

const SQL_NOISE = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Which `${...}` spans of a template sit inside a subquery: tracks parens across
 * the literal parts and marks a group as a subquery once it holds `select`.
 * A column OUTSIDE the group (`${t.a} in (select ...)`) renders bare but still
 * resolves to the from-table, so only spans inside one are the bug.
 */
function spansInsideSubquery(template: ts.TemplateExpression): boolean[] {
  const stack: boolean[] = [false];
  const scan = (literal: string) => {
    const clean = literal.replace(SQL_NOISE, ' ');
    const tokens = clean.match(/\(|\)|\bselect\b/gi) ?? [];
    for (const token of tokens) {
      if (token === '(') stack.push(false);
      else if (token === ')') { if (stack.length > 1) stack.pop(); } else stack[stack.length - 1] = true;
    }
  };
  scan(template.head.text);
  return template.templateSpans.map((span) => {
    const inside = stack.some(Boolean);
    scan(span.literal.text);
    return inside;
  });
}

interface Walk {
  decls: Map<string, Decl[]>;
  globals: Map<string, Decl[]>;
  imports: Set<string>;
  outerRoot: string;
  /** Nodes on the current path. A cycle guard only: a helper called twice is walked twice. */
  active: Set<ts.Node>;
  report: (template: ts.TemplateExpression, columns: string[], inner: string[], field: string) => void;
}

/** A name's declarations: this file's first, then another module's only when this file imports the name. */
function resolveName(name: string, walk: Walk): Decl[] {
  return walk.decls.get(name) ?? (walk.imports.has(name) ? walk.globals.get(name) ?? [] : []);
}

function importedNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.add(el.name.text);
  }
  return names;
}

function innerTables(template: ts.TemplateExpression): string[] {
  const inner = new Set<string>();
  const record = (literal: string) => {
    for (const match of literal.replace(SQL_NOISE, ' ').matchAll(/\b(?:from|join)\s+("?[a-z_][\w.]*"?)/gi)) inner.add(match[1]!);
  };
  record(template.head.text);
  let before = template.head.text;
  for (const span of template.templateSpans) {
    if (/\b(?:from|join)\s*$/i.test(before.replace(SQL_NOISE, ' '))) inner.add(span.expression.getText());
    record(span.literal.text);
    before = span.literal.text;
  }
  return [...inner];
}

/** Walks a selection value down to the sql templates drizzle would treat as selection fields. */
function walkField(expr: ts.Expression, field: string, env: Env, walk: Walk): void {
  const node = unwrap(expr);
  if (walk.active.has(node)) return;
  walk.active.add(node);
  visitField(node, field, env, walk);
  walk.active.delete(node);
}

function visitField(node: ts.Expression, field: string, env: Env, walk: Walk): void {
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) walkField(prop.expression, field, env, walk);
      else if (ts.isPropertyAssignment(prop)) {
        walkField(prop.initializer, field ? `${field}.${prop.name.getText()}` : prop.name.getText(), env, walk);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name.text;
        for (const decl of resolveName(name, walk)) {
          if (decl.expr) walkField(decl.expr, field ? `${field}.${name}` : name, env, walk);
        }
      }
    }
    return;
  }
  if (ts.isConditionalExpression(node)) {
    walkField(node.whenTrue, field, env, walk);
    walkField(node.whenFalse, field, env, walk);
    return;
  }
  if (ts.isIdentifier(node)) {
    for (const decl of resolveName(node.text, walk)) {
      if (decl.expr) walkField(decl.expr, field, env, walk);
    }
    return;
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    // `sql`...`.as('x')`, `.mapWith(Number)`: wrappers that return the same chunks.
    if (ts.isPropertyAccessExpression(callee) && ['as', 'mapWith', 'inlineParams', '$type'].includes(callee.name.text)) {
      walkField(callee.expression, field, env, walk);
      return;
    }
    if (ts.isIdentifier(callee)) {
      for (const decl of resolveName(callee.text, walk)) {
        const bound: Env = new Map(env);
        decl.params.forEach((param, index) => {
          const arg = node.arguments[index];
          if (arg) bound.set(param, arg.getText().replace(/\s+/g, ''));
        });
        for (const ret of decl.returns) walkField(ret, field, bound, walk);
      }
    }
    return;
  }
  if (ts.isTaggedTemplateExpression(node) && isSqlTag(node.tag) && ts.isTemplateExpression(node.template)) {
    const template = node.template;
    const inside = spansInsideSubquery(template);
    const columns = template.templateSpans.flatMap((span, index) => {
      if (!inside[index]) return [];
      const ref = columnRef(span.expression, env, walk.decls);
      return ref && ref.split('.')[0] === walk.outerRoot ? [ref] : [];
    });
    if (columns.length > 0) walk.report(template, [...new Set(columns)], innerTables(template), field);
  }
}

const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

function findHits(source: string, path: string, globals: Map<string, Decl[]>): Hit[] {
  if (!/\b(?:select|selectDistinct|selectDistinctOn|returning)\s*\(/.test(source)) return [];
  const file = parse(path, source);
  const decls = collectDecls(file);
  const imports = importedNames(file);
  const hits: Hit[] = [];

  const scan = (selection: ts.Expression, outer: string, via: Hit['via']) => {
    walkField(selection, '', new Map(), {
      decls, globals, imports, outerRoot: outer.split('.')[0]!, active: new Set(),
      report: (template, columns, inner, field) => {
        // A helper's template lives in its own module; report where it is written.
        const home = template.getSourceFile();
        hits.push({
          file: path,
          definedAt: `${home === file ? path : relative(src, home.fileName).replaceAll('\\', '/')}:${
            home.getLineAndCharacterOfPosition(template.getStart(home)).line + 1}`,
          field,
          outer,
          columns,
          inner,
          via,
        });
      },
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const select = selectCallOf(node, decls);
      if (select && !chainedMethods(node).some((m) => /Join(?:Lateral)?$/.test(m))) {
        const method = (select.expression as ts.PropertyAccessExpression).name.text;
        const selection = select.arguments[method === 'selectDistinctOn' ? 1 : 0];
        const outer = node.arguments[0];
        if (selection && outer) scan(selection, unwrap(outer).getText().replace(/\s+/g, ''), 'select');
      }
      // insert, delete and from-less update returning() also render through
      // isSingleTable. update().from().returning() does not; scanning it too can
      // only add a false positive.
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'returning' && node.arguments[0]) {
        let receiver: ts.Expression = node.expression.expression;
        while (ts.isCallExpression(receiver) && ts.isPropertyAccessExpression(receiver.expression)
          && !['insert', 'update', 'delete'].includes(receiver.expression.name.text)) {
          receiver = receiver.expression.expression;
        }
        if (ts.isCallExpression(receiver) && receiver.arguments[0]) {
          scan(node.arguments[0], unwrap(receiver.arguments[0]).getText().replace(/\s+/g, ''), 'returning');
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hits;
}

function sweep(): Hit[] {
  const files = sourceFiles(src).map((path) => ({ path, source: readFileSync(path, 'utf8') }));
  // Helpers exported from another module resolve by name. Same-file names win.
  const globals = new Map<string, Decl[]>();
  for (const { path, source } of files) {
    if (!/sql[`<]/i.test(source) && !/\bsql as\b/.test(source)) continue;
    for (const [name, decls] of collectDecls(parse(path, source))) {
      globals.set(name, [...(globals.get(name) ?? []), ...decls]);
    }
  }
  return files.flatMap(({ path, source }) => findHits(source, relative(src, path).replaceAll('\\', '/'), globals));
}

const keyOf = (hit: Hit) => `${hit.file}::${hit.outer}.${hit.field}`;
const describeHit = (hit: Hit) =>
  `${hit.definedAt} [${hit.via}] query in ${hit.file} field=${hit.field || '(selection)'} outer=${hit.outer} `
  + `inner=${hit.inner.join(',') || '?'} columns=${hit.columns.join(',')}`;

/** Every schema table by export name and by SQL name, as its set of SQL column names. */
function schemaColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    const columns = new Set(config.columns.map((column) => column.name));
    tables.set(exportName, columns);
    tables.set(config.name, columns);
  }
  return tables;
}

/**
 * The outer SQL column names this hit's inner table(s) also have. Each one is the
 * wrong-data bug: the stripped name resolves to the inner table. Empty means the
 * name happens to reach the outer row, which stays true only until a migration
 * adds that column to the inner table, so this runs against the live schema.
 */
function shadowedColumns(hit: Hit, tables: Map<string, Set<string>>): string[] {
  const outerTable = (schema as Record<string, unknown>)[hit.outer];
  return hit.columns.flatMap((ref) => {
    const property = ref.split('.')[1]!;
    const column = is(outerTable, PgTable) ? (outerTable as unknown as Record<string, Column>)[property] : undefined;
    const name = column?.name ?? property;
    return hit.inner.some((inner) => tables.get(inner.replaceAll('"', ''))?.has(name)) ? [`${ref} ("${name}")`] : [];
  });
}

const fixture = (body: string) => findHits(body, 'fixture.ts', new Map());

describe('drizzle single-table selection rendering (the rule this contract models)', () => {
  const outer = pgTable('outer_t', { id: uuid('id').primaryKey(), name: text('name') });
  const inner = pgTable('inner_t', { id: uuid('id').primaryKey(), outerId: uuid('outer_id') });
  const qb = new QueryBuilder();

  it('strips qualifiers from direct column chunks, so the correlation binds to the inner table', () => {
    const rendered = qb
      .select({ n: sql`(select count(*) from ${inner} where ${inner.outerId} = ${outer.id})` })
      .from(outer)
      .toSQL().sql;
    expect(rendered).toContain('where "outer_id" = "id"');
  });

  it('keeps qualifiers on nested sql and eq(), and whenever the query has a join', () => {
    const nested = qb
      .select({ n: sql`(select count(*) from ${inner} where ${sql`${inner.outerId} = ${outer.id}`})` })
      .from(outer)
      .toSQL().sql;
    expect(nested).toContain('"inner_t"."outer_id" = "outer_t"."id"');

    const viaEq = qb
      .select({ n: sql`(select count(*) from ${inner} where ${eq(inner.outerId, outer.id)})` })
      .from(outer)
      .toSQL().sql;
    expect(viaEq).toContain('"inner_t"."outer_id" = "outer_t"."id"');

    const joined = qb
      .select({ n: sql`(select count(*) from ${inner} where ${inner.outerId} = ${outer.id})` })
      .from(outer)
      .leftJoin(inner, eq(inner.outerId, outer.id))
      .toSQL().sql;
    expect(joined).toContain('"inner_t"."outer_id" = "outer_t"."id"');
  });

  it('does not strip WHERE, so only selections carry the bug', () => {
    const rendered = qb
      .select({ id: outer.id })
      .from(outer)
      .where(sql`exists (select 1 from ${inner} where ${inner.outerId} = ${outer.id})`)
      .toSQL().sql;
    expect(rendered).toContain('"inner_t"."outer_id" = "outer_t"."id"');
  });
});

describe('walker', () => {
  const bad = 'sql`(select count(*) from ${inner} where ${inner.outerId} = ${outer.id})`';

  it.each([
    ['inline', `db.select({ n: ${bad} }).from(outer);`],
    ['.as() wrapper', `db.select({ n: ${bad}.as('n') }).from(outer).where(x);`],
    ['tx receiver and selectDistinct', `tx.selectDistinct({ n: ${bad} }).from(outer);`],
    ['spread', `db.select({ ...{ n: ${bad} } }).from(outer);`],
    ['nested object', `db.select({ a: { n: ${bad} } }).from(outer);`],
    ['selection const', `const s = { n: ${bad} }; db.select(s).from(outer);`],
    ['field const', `const n = ${bad}; db.select({ n }).from(outer);`],
    ['conditional', `db.select({ n: flag ? ${bad} : sql\`0\` }).from(outer);`],
    ['helper function with column argument', `const f = (c) => sql\`(select 1 from \${inner} where \${inner.a} = \${c})\`; db.select({ n: f(outer.id) }).from(outer);`],
    ['exists', 'db.select({ n: sql`exists (select 1 from ${inner} where ${inner.a} = ${outer.id})` }).from(outer);'],
    ['returning', `db.update(outer).set(v).where(w).returning({ n: ${bad} });`],
    ['a query split across statements', `const q = db.select({ n: ${bad} }); q.from(outer);`],
    ['an aliased sql import', "import { sql as q } from 'drizzle-orm'; db.select({ n: q`(select 1 from b where a = ${outer.id})` }).from(outer);"],
  ])('flags %s', (_name, body) => {
    expect(fixture(body)).toHaveLength(1);
  });

  it('reads the inner table from a literal aliased FROM, the shape two real bugs used', () => {
    const [hit] = fixture('db.select({ n: sql`(select 1 from inner_t x where x.a = ${outer.id})` }).from(outer);');
    expect(hit?.inner).toEqual(['inner_t']);
    expect(hit?.columns).toEqual(['outer.id']);
  });

  it('reports each call of a helper, so an allowlisted first call cannot hide a second', () => {
    const hits = fixture('const f = (c) => sql`(select 1 from b where a = ${c})`; db.select({ x: f(outer.id), y: f(outer.name) }).from(outer);');
    expect(hits.map((hit) => [hit.field, hit.columns])).toEqual([['x', ['outer.id']], ['y', ['outer.name']]]);
  });

  it.each([
    ['a join on the chain', `db.select({ n: ${bad} }).from(outer).leftJoin(inner, on);`],
    ['nested sql (keeps qualifiers)', 'db.select({ n: sql`(select 1 from ${inner} where ${sql`${inner.a} = ${outer.id}`})` }).from(outer);'],
    ['eq() (keeps qualifiers)', 'db.select({ n: sql`(select 1 from ${inner} where ${eq(inner.a, outer.id)})` }).from(outer);'],
    ['only inner columns', 'db.select({ n: sql`(select max(${inner.a}) from ${inner})` }).from(outer);'],
    ['outer column outside the subquery', 'db.select({ n: sql`${outer.id} in (select a from b)` }).from(outer);'],
    ['outer column after the subquery closes', 'db.select({ n: sql`coalesce((select 1 from b), ${outer.id})` }).from(outer);'],
    ['no subquery', 'db.select({ n: sql`coalesce(${outer.id}, 0)` }).from(outer);'],
    ['a selection with no sql', 'db.select({ id: outer.id }).from(outer);'],
    ['subquery in WHERE', `db.select({ id: outer.id }).from(outer).where(${bad});`],
  ])('does not flag %s', (_name, body) => {
    expect(fixture(body)).toEqual([]);
  });
});

describe('shadow check', () => {
  const tables = new Map([['inner_t', new Set(['id', 'outer_id'])]]);
  const hit = (columns: string[], inner: string[]): Hit => ({
    file: 'f.ts', definedAt: 'f.ts:1', field: 'n', outer: 'devices', columns, inner, via: 'select',
  });

  it('maps the outer property to its SQL column name before comparing', () => {
    // devices.orgId is "org_id": a same-named inner column shadows it, the property name does not.
    expect(shadowedColumns(hit(['devices.orgId'], ['inner_t']), new Map([['inner_t', new Set(['org_id'])]])))
      .toEqual(['devices.orgId ("org_id")']);
    expect(shadowedColumns(hit(['devices.orgId'], ['inner_t']), new Map([['inner_t', new Set(['orgId'])]])))
      .toEqual([]);
  });

  it('flags a shared name and passes a name only the outer table has', () => {
    expect(shadowedColumns(hit(['devices.id'], ['inner_t']), tables)).toEqual(['devices.id ("id")']);
    expect(shadowedColumns(hit(['devices.hostname'], ['inner_t']), tables)).toEqual([]);
  });

  it('cannot judge an inner source that is not a schema table', () => {
    expect(shadowedColumns(hit(['devices.id'], ['jsonb_array_elements']), tables)).toEqual([]);
  });
});

describe('single-table selections hold no correlated sql subquery (#9692)', () => {
  const hits = sweep();
  const tables = schemaColumns();
  const message = 'A correlated sql subquery in a single-table selection loses its table qualifiers '
    + '(drizzle strips them), so the outer column can bind to the inner table. Use a join or a grouped '
    + 'lookup, or nest the correlation in eq()/sql`` so it keeps its qualifiers. See #9692.';

  it('sees the real schema, or the shadow check below would pass vacuously', () => {
    expect(tables.get('snmpDevices')?.has('asset_id')).toBe(true);
    expect(tables.get('snmp_devices')).toBe(tables.get('snmpDevices'));
  });

  it('resolves every inner source, because the shadow check cannot judge one it cannot see', () => {
    const blind = hits.flatMap((hit) => {
      const unknown = hit.inner.filter((inner) => {
        const name = inner.replaceAll('"', '');
        return !tables.has(name) && !NON_TABLE_INNER_SOURCES.has(name);
      });
      return hit.inner.length === 0 || unknown.length > 0 ? [`${describeHit(hit)} UNRESOLVED=${unknown.join(',') || '(none found)'}`] : [];
    });
    expect(blind).toEqual([]);
  });

  it('has no outer column shadowed by an inner table, allowlisted or not', () => {
    const wrongData = hits.flatMap((hit) => {
      const shadowed = shadowedColumns(hit, tables);
      return shadowed.length > 0 ? [`${describeHit(hit)} SHADOWED=${shadowed.join(',')}`] : [];
    });
    expect(wrongData, message).toEqual([]);
  });

  it('finds none outside the reviewed allowlist', () => {
    const unexpected = hits.filter((hit) => !(keyOf(hit) in ALLOWLIST)).map(describeHit);
    expect(unexpected, message).toEqual([]);
  });

  it('keeps every allowlist entry live and justified', () => {
    const keys = new Set(hits.map(keyOf));
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(keys.has(key), `stale allowlist entry: ${key}`).toBe(true);
      expect(reason.trim().length, `allowlist entry needs a reason: ${key}`).toBeGreaterThan(20);
    }
  });
});
