// Test-only model of a GitHub Actions job graph: reads each job's `needs:` and
// job-level `if:` from a workflow file and evaluates them the way the Actions
// runner does, so a contract test can compare which jobs run or skip under a
// scenario between two versions of a workflow.
//
// Scope is deliberately narrow — the expression subset release.yml uses at the
// job level: literals, property paths, `!`, `&&`, `||`, `==`, `!=`, parentheses,
// and the functions startsWith/contains/success/failure/always/cancelled.
// Anything else throws, so an unmodelled construct fails the test instead of
// being silently mis-evaluated.

import { readFileSync } from 'node:fs';

import { activeLines, workflowJobs } from '../../../.github/scripts/check-workflow-security.mjs';

function directScalar(job, key) {
  const propertyIndent = job.lines[0].indent + 2;
  const index = job.lines.findIndex((line, lineIndex) => (
    lineIndex > 0
    && !line.isBlockScalarContent
    && line.indent === propertyIndent
    && line.trimmed.startsWith(`${key}:`)
  ));
  if (index === -1) return null;
  const value = job.lines[index].trimmed.slice(`${key}:`.length).trim();
  if (!/^[>|][0-9+-]*$/u.test(value)) return value;
  const parts = [];
  for (let next = index + 1; next < job.lines.length && job.lines[next].isBlockScalarContent; next += 1) {
    parts.push(job.lines[next].trimmed);
  }
  return parts.join(' ');
}

export function readJobGraph(path) {
  const jobs = workflowJobs(activeLines(readFileSync(path, 'utf8')));
  const graph = {};
  for (const job of jobs) {
    const needsValue = directScalar(job, 'needs');
    let needs = [];
    if (needsValue) {
      if (!needsValue.startsWith('[') || !needsValue.endsWith(']')) {
        throw new Error(`${job.name}: needs must be a flow list`);
      }
      needs = needsValue.slice(1, -1).split(',').map((need) => need.trim()).filter(Boolean);
    }
    graph[job.name] = { needs, if: directScalar(job, 'if') };
  }
  return graph;
}

// ── Expressions ────────────────────────────────────────────────────────────
function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = /^\s+/u.exec(rest);
    if (whitespace) { index += whitespace[0].length; continue; }
    const operator = /^(?:&&|\|\||==|!=|[()!,])/u.exec(rest);
    if (operator) { tokens.push({ type: 'op', value: operator[0] }); index += operator[0].length; continue; }
    if (rest[0] === "'") {
      let value = '';
      let cursor = 1;
      for (;;) {
        if (cursor >= rest.length) throw new Error(`unterminated string in: ${source}`);
        if (rest[cursor] === "'" && rest[cursor + 1] === "'") { value += "'"; cursor += 2; continue; }
        if (rest[cursor] === "'") { cursor += 1; break; }
        value += rest[cursor];
        cursor += 1;
      }
      tokens.push({ type: 'literal', value });
      index += cursor;
      continue;
    }
    const number = /^-?\d+(?:\.\d+)?/u.exec(rest);
    if (number) { tokens.push({ type: 'literal', value: Number(number[0]) }); index += number[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*/u.exec(rest);
    if (identifier) {
      const word = identifier[0];
      if (word === 'true' || word === 'false') tokens.push({ type: 'literal', value: word === 'true' });
      else if (word === 'null') tokens.push({ type: 'literal', value: null });
      else tokens.push({ type: 'identifier', value: word });
      index += word.length;
      continue;
    }
    throw new Error(`unsupported expression syntax at '${rest.slice(0, 20)}' in: ${source}`);
  }
  return tokens;
}

export function parseExpression(source) {
  let text = source.trim();
  if (text.startsWith('${{') && text.endsWith('}}')) text = text.slice(3, -2);
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = (value) => {
    const token = tokens[position];
    if (!token || (value !== undefined && token.value !== value)) {
      throw new Error(`expected '${value}' in: ${source}`);
    }
    position += 1;
    return token;
  };

  function primary() {
    const token = peek();
    if (!token) throw new Error(`unexpected end of: ${source}`);
    if (token.type === 'op' && token.value === '(') {
      take('(');
      const inner = or();
      take(')');
      return inner;
    }
    if (token.type === 'op' && token.value === '!') {
      take('!');
      return { kind: 'not', operand: primary() };
    }
    if (token.type === 'literal') { position += 1; return { kind: 'literal', value: token.value }; }
    if (token.type === 'identifier') {
      position += 1;
      if (peek()?.value === '(') {
        take('(');
        const args = [];
        while (peek()?.value !== ')') {
          args.push(or());
          if (peek()?.value === ',') take(',');
        }
        take(')');
        return { kind: 'call', name: token.value, args };
      }
      return { kind: 'path', path: token.value };
    }
    throw new Error(`unexpected '${token.value}' in: ${source}`);
  }
  function comparison() {
    let left = primary();
    while (peek()?.value === '==' || peek()?.value === '!=') {
      const operator = take().value;
      left = { kind: operator === '==' ? 'eq' : 'ne', left, right: primary() };
    }
    return left;
  }
  function and() {
    let left = comparison();
    while (peek()?.value === '&&') { take('&&'); left = { kind: 'and', left, right: comparison() }; }
    return left;
  }
  function or() {
    let left = and();
    while (peek()?.value === '||') { take('||'); left = { kind: 'or', left, right: and() }; }
    return left;
  }
  const ast = or();
  if (position !== tokens.length) throw new Error(`trailing tokens in: ${source}`);
  return ast;
}

const STATUS_FUNCTIONS = new Set(['success', 'failure', 'always', 'cancelled']);

function usesStatusFunction(ast) {
  if (!ast || typeof ast !== 'object') return false;
  if (ast.kind === 'call' && STATUS_FUNCTIONS.has(ast.name)) return true;
  return Object.values(ast).some((value) => (
    Array.isArray(value) ? value.some(usesStatusFunction) : usesStatusFunction(value)
  ));
}

const truthy = (value) => !(value === false || value === 0 || value === '' || value === null || value === undefined || Number.isNaN(value));

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (value.trim() === '') return 0;
  return Number(value);
}

function looseEqual(left, right) {
  const l = left ?? null;
  const r = right ?? null;
  if (typeof l === 'string' && typeof r === 'string') return l.toLowerCase() === r.toLowerCase();
  if (l === null && r === null) return true;
  const ln = toNumber(l);
  const rn = toNumber(r);
  return !Number.isNaN(ln) && !Number.isNaN(rn) && ln === rn;
}

function evaluate(ast, context) {
  switch (ast.kind) {
    case 'literal': return ast.value;
    case 'path': return context.lookup(ast.path);
    case 'not': return !truthy(evaluate(ast.operand, context));
    case 'and': {
      const left = evaluate(ast.left, context);
      return truthy(left) ? evaluate(ast.right, context) : left;
    }
    case 'or': {
      const left = evaluate(ast.left, context);
      return truthy(left) ? left : evaluate(ast.right, context);
    }
    case 'eq': return looseEqual(evaluate(ast.left, context), evaluate(ast.right, context));
    case 'ne': return !looseEqual(evaluate(ast.left, context), evaluate(ast.right, context));
    case 'call': {
      const args = ast.args.map((argument) => evaluate(argument, context));
      switch (ast.name) {
        case 'startsWith': return String(args[0] ?? '').toLowerCase().startsWith(String(args[1] ?? '').toLowerCase());
        case 'contains': return String(args[0] ?? '').toLowerCase().includes(String(args[1] ?? '').toLowerCase());
        case 'always': return true;
        case 'cancelled': return false;
        case 'success': return context.success();
        case 'failure': return context.failure();
        default: throw new Error(`unsupported function ${ast.name}()`);
      }
    }
    default: throw new Error(`unsupported node ${ast.kind}`);
  }
}

// ── Simulation ─────────────────────────────────────────────────────────────
function topologicalOrder(graph) {
  const order = [];
  const state = new Map();
  const visit = (name) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`needs cycle at ${name}`);
    if (!graph[name]) throw new Error(`unknown job ${name} in needs`);
    state.set(name, 'visiting');
    for (const need of graph[name].needs) visit(need);
    state.set(name, 'done');
    order.push(name);
  };
  Object.keys(graph).forEach(visit);
  return order;
}

function ancestors(graph, name, seen = new Set()) {
  for (const need of graph[name].needs) {
    if (!seen.has(need)) {
      seen.add(need);
      ancestors(graph, need, seen);
    }
  }
  return seen;
}

// scenario: { github, inputs, vars, failures:Set, outputs:(job, results)=>object, behaviour:{[job]:(results)=>result} }
// statusModel: 'direct' (success() looks at direct needs) or 'transitive'
// (success() looks at every ancestor) — the runner's documented behaviour is
// the latter; both are evaluated so an equivalence claim holds under either.
export function simulate(graph, scenario, statusModel) {
  const results = {};
  const outputs = {};
  const parsed = {};
  for (const [name, job] of Object.entries(graph)) {
    const ast = job.if === null ? null : parseExpression(job.if);
    parsed[name] = ast === null
      ? { kind: 'call', name: 'success', args: [] }
      : (usesStatusFunction(ast) ? ast : { kind: 'and', left: { kind: 'call', name: 'success', args: [] }, right: ast });
  }
  for (const name of topologicalOrder(graph)) {
    const scope = statusModel === 'transitive' ? [...ancestors(graph, name)] : graph[name].needs;
    const context = {
      lookup(path) {
        const [root, ...rest] = path.split('.');
        if (root === 'needs') {
          const [job, field, key] = rest;
          if (!graph[name].needs.includes(job)) throw new Error(`${name} reads needs.${job} without needing it`);
          if (field === 'result') return results[job];
          if (field === 'outputs') return outputs[job]?.[key] ?? '';
          throw new Error(`unsupported needs field ${path}`);
        }
        let value = scenario[root];
        for (const segment of rest) value = value?.[segment];
        return value ?? null;
      },
      success: () => scope.every((job) => results[job] === 'success'),
      failure: () => scope.some((job) => results[job] === 'failure'),
    };
    if (!truthy(evaluate(parsed[name], context))) {
      results[name] = 'skipped';
      outputs[name] = {};
      continue;
    }
    const behaviour = scenario.behaviour?.[name];
    results[name] = scenario.failures?.has(name) ? 'failure' : (behaviour ? behaviour(results) : 'success');
    outputs[name] = results[name] === 'success' ? (scenario.outputs?.(name) ?? {}) : {};
  }
  return results;
}
