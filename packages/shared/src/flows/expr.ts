/**
 * Flow expression grammar (spec §6.2). Hand-written tokenizer + recursive-descent
 * parser + iterative evaluator. No eval/Function, no regex-built code. Browser safe.
 *
 * Grammar, precedence low -> high:
 *   ||   &&   == !=   < <= > >= in   unary !   primary
 * primary: literal | path | fn(arg) | ( expr )
 *
 * `parseExpr`, `parsePath` and `evaluateExpr` never throw.
 */

export type FlowValue = null | boolean | number | string | FlowValue[] | { [k: string]: FlowValue };
export type FlowRoot = 'trigger' | 'inputs' | 'steps' | 'item' | 'flow' | 'now';
export interface FlowPath { root: FlowRoot; segments: Array<string | number> }

export type ExprNode =
  | { kind: 'lit'; value: null | boolean | number | string }
  | { kind: 'path'; path: FlowPath }
  | { kind: 'not'; arg: ExprNode }
  | { kind: 'bin'; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'in'; left: ExprNode; right: ExprNode }
  | { kind: 'call'; fn: 'length' | 'exists' | 'lower'; arg: ExprNode };

export const EXPR_LIMITS = { maxDepth: 32, maxEvalNodes: 10_000, maxSourceLength: 2048 } as const;

export type ExprParseResult =
  | { ok: true; ast: ExprNode; paths: FlowPath[] }
  | { ok: false; error: string; offset: number };

export type FlowScope = Partial<Record<FlowRoot, FlowValue>>;
export type ExprEvalResult = { ok: true; value: FlowValue } | { ok: false; error: 'budget_exceeded' };

const ROOTS: readonly string[] = ['trigger', 'inputs', 'steps', 'item', 'flow', 'now'];
const FORBIDDEN_SEGMENTS: readonly string[] = ['__proto__', 'prototype', 'constructor'];
const FUNCTIONS: readonly string[] = ['length', 'exists', 'lower'];

// ── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { t: 'num'; v: number; off: number }
  | { t: 'str'; v: string; off: number }
  | { t: 'id'; v: string; off: number }
  | { t: 'p'; v: string; off: number }
  | { t: 'eof'; v: ''; off: number };

class ParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdPart = (c: string) => isIdStart(c) || isDigit(c);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    const off = i;
    if (isDigit(c) || (c === '-' && i + 1 < n && isDigit(src[i + 1]!))) {
      let j = c === '-' ? i + 1 : i;
      while (j < n && isDigit(src[j]!)) j++;
      if (j + 1 < n && src[j] === '.' && isDigit(src[j + 1]!)) {
        j++;
        while (j < n && isDigit(src[j]!)) j++;
      }
      out.push({ t: 'num', v: Number(src.slice(i, j)), off });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j]!)) j++;
      out.push({ t: 'id', v: src.slice(i, j), off });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < n) {
        const d = src[j]!;
        if (d === c) { closed = true; j++; break; }
        if (d === '\\') {
          const e = src[j + 1];
          if (e === '\\' || e === "'" || e === '"') s += e;
          else if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else throw new ParseError('invalid string escape', j);
          j += 2;
          continue;
        }
        s += d;
        j++;
      }
      if (!closed) throw new ParseError('unterminated string', off);
      out.push({ t: 'str', v: s, off });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      out.push({ t: 'p', v: two, off });
      i += 2;
      continue;
    }
    if ('<>!()[].,'.includes(c)) {
      out.push({ t: 'p', v: c, off });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character '${c}'`, i);
  }
  out.push({ t: 'eof', v: '', off: n });
  return out;
}

// ── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  private depth = 0;
  readonly paths: FlowPath[] = [];

  constructor(private readonly toks: Token[]) {}

  private get tok(): Token { return this.toks[this.pos]!; }
  private isP(v: string): boolean { return this.tok.t === 'p' && this.tok.v === v; }
  private isKw(v: string): boolean { return this.tok.t === 'id' && this.tok.v === v; }

  private expectP(v: string): void {
    if (!this.isP(v)) throw new ParseError(`expected '${v}'`, this.tok.off);
    this.pos++;
  }

  private enter(): void {
    this.depth++;
    if (this.depth > EXPR_LIMITS.maxDepth) {
      throw new ParseError(`expression nesting exceeds depth ${EXPR_LIMITS.maxDepth}`, this.tok.off);
    }
  }

  private leave(): void { this.depth--; }

  parseAll(): ExprNode {
    const ast = this.parseOr();
    if (this.tok.t !== 'eof') throw new ParseError(`unexpected '${this.tok.v}'`, this.tok.off);
    return ast;
  }

  parsePathOnly(): FlowPath {
    const p = this.parsePathTokens();
    if (this.tok.t !== 'eof') throw new ParseError(`unexpected '${this.tok.v}'`, this.tok.off);
    return p;
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.isP('||')) {
      this.pos++;
      left = { kind: 'bin', op: '||', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseEq();
    while (this.isP('&&')) {
      this.pos++;
      left = { kind: 'bin', op: '&&', left, right: this.parseEq() };
    }
    return left;
  }

  private parseEq(): ExprNode {
    let left = this.parseRel();
    while (this.isP('==') || this.isP('!=')) {
      const op = this.tok.v as '==' | '!=';
      this.pos++;
      left = { kind: 'bin', op, left, right: this.parseRel() };
    }
    return left;
  }

  private parseRel(): ExprNode {
    let left = this.parseUnary();
    for (;;) {
      if (this.isP('<') || this.isP('<=') || this.isP('>') || this.isP('>=')) {
        const op = this.tok.v as '<' | '<=' | '>' | '>=';
        this.pos++;
        left = { kind: 'bin', op, left, right: this.parseUnary() };
      } else if (this.isKw('in')) {
        this.pos++;
        left = { kind: 'bin', op: 'in', left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): ExprNode {
    if (this.isP('!')) {
      this.pos++;
      this.enter();
      const arg = this.parseUnary();
      this.leave();
      return { kind: 'not', arg };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const tk = this.tok;
    if (tk.t === 'num') { this.pos++; return { kind: 'lit', value: tk.v }; }
    if (tk.t === 'str') { this.pos++; return { kind: 'lit', value: tk.v }; }
    if (tk.t === 'p' && tk.v === '(') {
      this.pos++;
      this.enter();
      const inner = this.parseOr();
      this.leave();
      this.expectP(')');
      return inner;
    }
    if (tk.t === 'id') {
      if (tk.v === 'null') { this.pos++; return { kind: 'lit', value: null }; }
      if (tk.v === 'true') { this.pos++; return { kind: 'lit', value: true }; }
      if (tk.v === 'false') { this.pos++; return { kind: 'lit', value: false }; }
      const next = this.toks[this.pos + 1]!;
      if (next.t === 'p' && next.v === '(') return this.parseCall(tk);
      const path = this.parsePathTokens();
      this.paths.push(path);
      return { kind: 'path', path };
    }
    throw new ParseError(tk.t === 'eof' ? 'unexpected end of expression' : `unexpected '${tk.v}'`, tk.off);
  }

  private parseCall(nameTok: Token): ExprNode {
    const fn = String(nameTok.v);
    if (!FUNCTIONS.includes(fn)) throw new ParseError(`unknown function '${fn}'`, nameTok.off);
    this.pos += 2; // name, '('
    let arg: ExprNode;
    if (fn === 'exists') {
      if (this.tok.t !== 'id') throw new ParseError('exists() requires a path argument', this.tok.off);
      const path = this.parsePathTokens();
      this.paths.push(path);
      arg = { kind: 'path', path };
    } else {
      this.enter();
      arg = this.parseOr();
      this.leave();
    }
    this.expectP(')');
    return { kind: 'call', fn: fn as 'length' | 'exists' | 'lower', arg };
  }

  private parsePathTokens(): FlowPath {
    const first = this.tok;
    if (first.t !== 'id') throw new ParseError('expected a path', first.off);
    if (!ROOTS.includes(first.v)) throw new ParseError(`unknown path root '${first.v}'`, first.off);
    this.pos++;
    const segments: Array<string | number> = [];
    for (;;) {
      if (this.isP('.')) {
        this.pos++;
        const seg = this.tok;
        if (seg.t !== 'id') throw new ParseError("expected a name after '.'", seg.off);
        if (FORBIDDEN_SEGMENTS.includes(seg.v)) throw new ParseError(`path segment '${seg.v}' is not allowed`, seg.off);
        segments.push(seg.v);
        this.pos++;
      } else if (this.isP('[')) {
        this.pos++;
        const idx = this.tok;
        if (idx.t !== 'num' || !Number.isInteger(idx.v) || idx.v < 0 || !Number.isSafeInteger(idx.v)) {
          throw new ParseError('expected a non-negative integer index', idx.off);
        }
        this.pos++;
        this.expectP(']');
        segments.push(idx.v);
      } else {
        break;
      }
    }
    return { root: first.v as FlowRoot, segments };
  }
}

function fail(e: unknown): { ok: false; error: string; offset: number } {
  if (e instanceof ParseError) return { ok: false, error: e.message, offset: e.offset };
  return { ok: false, error: 'invalid expression', offset: 0 };
}

export function parseExpr(src: string): ExprParseResult {
  try {
    if (typeof src !== 'string') return { ok: false, error: 'expression must be a string', offset: 0 };
    if (src.length > EXPR_LIMITS.maxSourceLength) {
      return { ok: false, error: `expression exceeds ${EXPR_LIMITS.maxSourceLength} characters`, offset: EXPR_LIMITS.maxSourceLength };
    }
    const parser = new Parser(tokenize(src));
    const ast = parser.parseAll();
    return { ok: true, ast, paths: parser.paths };
  } catch (e) {
    return fail(e);
  }
}

export function parsePath(src: string): { ok: true; path: FlowPath } | { ok: false; error: string } {
  try {
    if (typeof src !== 'string') return { ok: false, error: 'path must be a string' };
    if (src.length > EXPR_LIMITS.maxSourceLength) return { ok: false, error: 'path too long' };
    const path = new Parser(tokenize(src)).parsePathOnly();
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: fail(e).error };
  }
}

// ── Evaluation ───────────────────────────────────────────────────────────────

/** Own-property path lookup. `found` distinguishes an explicit null from an absent key. */
export function resolveFlowPath(path: FlowPath, scope: FlowScope): { found: boolean; value: FlowValue } {
  const missing = { found: false, value: null } as const;
  if (!Object.hasOwn(scope, path.root)) return missing;
  let cur: unknown = scope[path.root];
  if (cur === undefined) return missing;
  for (const seg of path.segments) {
    if (cur === null || typeof cur !== 'object') return missing;
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number' || !Object.hasOwn(cur, seg)) return missing;
    } else if (typeof seg !== 'string' || !Object.hasOwn(cur, seg)) {
      return missing;
    }
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return { found: true, value: cur === undefined ? null : (cur as FlowValue) };
}

export function isTruthy(v: FlowValue): boolean {
  return v === true;
}

const isComposite = (v: FlowValue): boolean => typeof v === 'object' && v !== null;

function strictEq(l: FlowValue, r: FlowValue): boolean {
  if (isComposite(l) || isComposite(r)) return false;
  return l === r;
}

function compare(op: '<' | '<=' | '>' | '>=', l: FlowValue, r: FlowValue): boolean {
  const ok = (typeof l === 'number' && typeof r === 'number') || (typeof l === 'string' && typeof r === 'string');
  if (!ok) return false;
  const a = l as number | string;
  const b = r as number | string;
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    default: return a >= b;
  }
}

function applyBin(op: string, l: FlowValue, r: FlowValue): FlowValue {
  switch (op) {
    case '==': return strictEq(l, r);
    case '!=': return !strictEq(l, r);
    case '<': case '<=': case '>': case '>=': return compare(op, l, r);
    case 'in': {
      if (!Array.isArray(r) || isComposite(l)) return false;
      return r.some((e) => !isComposite(e) && e === l);
    }
    default: throw new Error('bad op');
  }
}

function applyCall(fn: string, v: FlowValue): FlowValue {
  if (fn === 'length') {
    if (typeof v === 'string') return Array.from(v).length;
    if (Array.isArray(v)) return v.length;
    return null;
  }
  if (fn === 'lower') return typeof v === 'string' ? v.toLowerCase() : null;
  throw new Error('bad fn');
}

interface Task { n: ExprNode; phase: 0 | 1 | 2 | 3 }

export function evaluateExpr(ast: ExprNode, scope: FlowScope): ExprEvalResult {
  const budget = { ok: false, error: 'budget_exceeded' } as const;
  try {
    const tasks: Task[] = [{ n: ast, phase: 0 }];
    const vals: FlowValue[] = [];
    let count = 0;
    while (tasks.length > 0) {
      const { n, phase } = tasks.pop()!;
      if (phase === 0) {
        if (++count > EXPR_LIMITS.maxEvalNodes) return budget;
        switch (n.kind) {
          case 'lit': vals.push(n.value); break;
          case 'path': vals.push(resolveFlowPath(n.path, scope).value); break;
          case 'not': tasks.push({ n, phase: 1 }, { n: n.arg, phase: 0 }); break;
          case 'call':
            if (n.fn === 'exists') {
              if (n.arg.kind !== 'path') return budget;
              count++;
              vals.push(resolveFlowPath(n.arg.path, scope).found);
            } else {
              tasks.push({ n, phase: 1 }, { n: n.arg, phase: 0 });
            }
            break;
          case 'bin':
            if (n.op === '&&' || n.op === '||') tasks.push({ n, phase: 1 }, { n: n.left, phase: 0 });
            else tasks.push({ n, phase: 2 }, { n: n.right, phase: 0 }, { n: n.left, phase: 0 });
            break;
          default: return budget;
        }
      } else if (phase === 1) {
        const v = vals.pop() as FlowValue;
        if (n.kind === 'not') vals.push(!isTruthy(v));
        else if (n.kind === 'call') vals.push(applyCall(n.fn, v));
        else if (n.kind === 'bin') {
          const l = isTruthy(v);
          if (n.op === '&&' && !l) vals.push(false);
          else if (n.op === '||' && l) vals.push(true);
          else tasks.push({ n, phase: 3 }, { n: n.right, phase: 0 });
        } else return budget;
      } else if (phase === 2) {
        const r = vals.pop() as FlowValue;
        const l = vals.pop() as FlowValue;
        if (n.kind !== 'bin') return budget;
        vals.push(applyBin(n.op, l, r));
      } else {
        vals.push(isTruthy(vals.pop() as FlowValue));
      }
    }
    return vals.length === 1 ? { ok: true, value: vals[0]! } : budget;
  } catch {
    return budget;
  }
}
