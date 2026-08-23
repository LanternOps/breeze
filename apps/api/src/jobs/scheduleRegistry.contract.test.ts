/**
 * Contract test for BullMQ repeatable schedules.
 *
 * Guards the nightly pool stampede fixed in `scheduleRegistry.ts`. BullMQ
 * computes the next run of `repeat: { every: N }` as
 * `Math.floor(now / N) * N + N`, anchored to the Unix epoch — so every job
 * sharing an `every` value fires on the same wall-clock instant forever, and
 * every `every: 24h` job fires at exactly 00:00:00.000 UTC. Production Redis
 * (US, 2026-08-23) held 18 of 97 repeat entries on the single millisecond
 * 1787529600000.
 *
 * This suite reads the REAL source of every job registration with the
 * TypeScript AST, resolves each `repeat` option to a concrete value, and
 * expands the cron patterns with the SAME cron parser BullMQ uses. It is not a
 * mock-shape assertion: adding `repeat: { every: 24 * 60 * 60 * 1000 }` to any
 * file under apps/api/src or ee/ fails it, and so does re-using an already
 * allocated cron slot.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import parser from 'cron-parser';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOB_SCHEDULES,
  COARSE_REPEAT_INTERVAL_MS,
  DAILY_REPEAT_INTERVAL_MS,
} from './scheduleRegistry';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(API_SRC, '../../..');
const SCAN_ROOTS = [API_SRC, path.join(REPO_ROOT, 'ee')];

/** Fixed, DST-free reference window. Containers run UTC on every deployment. */
const REFERENCE_START = new Date('2026-01-01T00:00:00.000Z');
const COLLISION_WINDOW_DAYS = 28;
const GAP_PROBE_FIRES = 60;

// ---------------------------------------------------------------- source scan

interface RepeatSite {
  file: string;
  line: number;
  /** Every candidate value the expression can take (>1 when `||` or a param). */
  patterns: string[];
  intervals: number[];
  /** Raw source of the unresolved sub-expression, when resolution failed. */
  unresolved: string | null;
}

const UNRESOLVED = Symbol('unresolved');
type Resolved = Array<string | number | typeof UNRESOLVED>;

function listTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') listTsFiles(full, out);
    } else if (
      entry.endsWith('.ts')
      && !entry.endsWith('.d.ts')
      && !entry.endsWith('.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function collectFileConsts(source: ts.SourceFile): Map<string, ts.Expression> {
  const consts = new Map<string, ts.Expression>();
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      // First declaration wins; shadowing inside functions is not used by any
      // registration site and a duplicate would show up as an unresolved value.
      if (!consts.has(node.name.text)) consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return consts;
}

function isProcessEnvAccess(node: ts.Node): boolean {
  return (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'env'
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === 'process'
  );
}

/**
 * Resolve the values a repeat-option expression can take at runtime.
 *
 * Deliberately narrow: literals, arithmetic, same-file consts, `jobSchedule()`,
 * the `parsePositiveIntEnv(name, default)` / `envInt(name, default)` helpers,
 * `Math.max`/`Math.min`, `process.env.X || <literal>`, and function parameters
 * resolved from their call sites in the same file. Anything else resolves to
 * UNRESOLVED, which fails the suite — that is intentional: a schedule nobody can
 * read statically is a schedule nobody can prove collision-free.
 */
function resolveExpression(
  expr: ts.Expression,
  source: ts.SourceFile,
  consts: Map<string, ts.Expression>,
  seen: Set<string>,
): Resolved {
  if (ts.isParenthesizedExpression(expr)) {
    return resolveExpression(expr.expression, source, consts, seen);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isNumericLiteral(expr)) return [Number(expr.text.replace(/_/g, ''))];

  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const right = resolveExpression(expr.right, source, consts, seen);
      // `process.env.X || fallback`: the env side is an operator override that
      // cannot be checked statically; the checked-in default is the fallback.
      if (isProcessEnvAccess(expr.left)) return right;
      return [...resolveExpression(expr.left, source, consts, seen), ...right];
    }
    const lefts = resolveExpression(expr.left, source, consts, seen);
    const rights = resolveExpression(expr.right, source, consts, seen);
    const out: Resolved = [];
    for (const l of lefts) {
      for (const r of rights) {
        if (typeof l !== 'number' || typeof r !== 'number') {
          out.push(UNRESOLVED);
          continue;
        }
        if (op === ts.SyntaxKind.AsteriskToken) out.push(l * r);
        else if (op === ts.SyntaxKind.PlusToken) out.push(l + r);
        else if (op === ts.SyntaxKind.MinusToken) out.push(l - r);
        else if (op === ts.SyntaxKind.SlashToken) out.push(l / r);
        else out.push(UNRESOLVED);
      }
    }
    return out;
  }

  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const calleeName = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? `${callee.expression.getText()}.${callee.name.text}`
        : '';

    if (calleeName === 'jobSchedule') {
      const arg = expr.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        const value = (JOB_SCHEDULES as Record<string, string>)[arg.text];
        return value ? [value] : [UNRESOLVED];
      }
      return [UNRESOLVED];
    }
    // `helper(ENV_NAME, defaultValue)` — the default is the checked-in schedule.
    if (calleeName === 'parsePositiveIntEnv' || calleeName === 'envInt' || calleeName === 'parseIntEnv') {
      const fallback = expr.arguments[1];
      return fallback ? resolveExpression(fallback, source, consts, seen) : [UNRESOLVED];
    }
    if (calleeName === 'Math.max' || calleeName === 'Math.min') {
      const parts = expr.arguments.map((a) => resolveExpression(a, source, consts, seen));
      if (parts.some((p) => p.some((v) => typeof v !== 'number'))) return [UNRESOLVED];
      const nums = parts.map((p) => p as number[]);
      const pick = calleeName === 'Math.max' ? Math.max : Math.min;
      // Worst case over every combination of candidate values.
      let acc: number[] = [calleeName === 'Math.max' ? -Infinity : Infinity];
      for (const values of nums) {
        const next: number[] = [];
        for (const a of acc) for (const v of values) next.push(pick(a, v));
        acc = next;
      }
      return acc;
    }
    return [UNRESOLVED];
  }

  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (seen.has(name)) return [UNRESOLVED];
    const nextSeen = new Set(seen).add(name);

    const declared = consts.get(name);
    if (declared) return resolveExpression(declared, source, consts, nextSeen);

    // A parameter of the enclosing function: resolve every call site's argument.
    const fromParam = resolveFromEnclosingParameter(expr, source, consts, nextSeen);
    if (fromParam) return fromParam;
    return [UNRESOLVED];
  }

  return [UNRESOLVED];
}

function resolveFromEnclosingParameter(
  ident: ts.Identifier,
  source: ts.SourceFile,
  consts: Map<string, ts.Expression>,
  seen: Set<string>,
): Resolved | null {
  let fn: ts.Node | undefined = ident.parent;
  while (fn && !ts.isFunctionDeclaration(fn) && !ts.isFunctionExpression(fn) && !ts.isArrowFunction(fn)) {
    fn = fn.parent;
  }
  if (!fn || !ts.isFunctionDeclaration(fn) || !fn.name) return null;
  const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === ident.text);
  if (index < 0) return null;

  const fnName = fn.name.text;
  const out: Resolved = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === fnName
    ) {
      const arg = node.arguments[index];
      if (!arg) out.push(UNRESOLVED);
      else out.push(...resolveExpression(arg, source, consts, seen));
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return out.length ? out : null;
}

function scanRepeatSites(): RepeatSite[] {
  const sites: RepeatSite[] = [];
  const files = SCAN_ROOTS.flatMap((root) => listTsFiles(root));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('repeat:')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const consts = collectFileConsts(source);

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'repeat'
        && ts.isObjectLiteralExpression(node.initializer)
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        const site: RepeatSite = {
          file: path.relative(REPO_ROOT, file),
          line,
          patterns: [],
          intervals: [],
          unresolved: null,
        };
        for (const prop of node.initializer.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          const key = prop.name.text;
          if (key !== 'pattern' && key !== 'every' && key !== 'cron') continue;
          for (const value of resolveExpression(prop.initializer, source, consts, new Set())) {
            if (value === UNRESOLVED) site.unresolved = prop.initializer.getText().replace(/\s+/g, ' ');
            else if (typeof value === 'string') site.patterns.push(value);
            else site.intervals.push(value);
          }
        }
        if (site.patterns.length || site.intervals.length || site.unresolved) sites.push(site);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

// ------------------------------------------------------------- cron expansion

const fireTimeCache = new Map<string, number[]>();

function fireTimes(pattern: string, days: number): number[] {
  const cacheKey = `${days}|${pattern}`;
  const cached = fireTimeCache.get(cacheKey);
  if (cached) return cached;
  const end = REFERENCE_START.getTime() + days * 24 * 60 * 60 * 1000;
  const it = parser.parseExpression(pattern, { currentDate: REFERENCE_START, tz: 'UTC' });
  const out: number[] = [];
  for (;;) {
    const next = it.next().getTime();
    if (next > end) break;
    out.push(next);
  }
  fireTimeCache.set(cacheKey, out);
  return out;
}

const gapCache = new Map<string, number>();

/** Smallest gap between consecutive fires — the schedule's effective period. */
function minimumGapMs(pattern: string): number {
  const cached = gapCache.get(pattern);
  if (cached !== undefined) return cached;
  const it = parser.parseExpression(pattern, { currentDate: REFERENCE_START, tz: 'UTC' });
  let previous = it.next().getTime();
  let smallest = Infinity;
  for (let i = 0; i < GAP_PROBE_FIRES; i += 1) {
    const next = it.next().getTime();
    smallest = Math.min(smallest, next - previous);
    previous = next;
  }
  gapCache.set(pattern, smallest);
  return smallest;
}

const label = (site: RepeatSite): string => `${site.file}:${site.line}`;

const SITES = scanRepeatSites();

// ------------------------------------------------------------------- the suite

describe('BullMQ repeatable schedule registry', { timeout: 60_000 }, () => {
  // Cron expansion over a 28-day window for ~50 schedules; well under this bound
  // on CI, but the default 5s is not enough headroom.
  it('finds the job registrations it is meant to police', () => {
    // A refactor that moves job registration somewhere this scan cannot see
    // would otherwise turn every assertion below into a vacuous pass.
    expect(SITES.length).toBeGreaterThan(80);
    expect(SITES.some((s) => s.file.endsWith('apps/api/src/jobs/deviceMetricsRetention.ts'))).toBe(true);
    expect(SITES.some((s) => s.file.endsWith('apps/api/src/jobs/vulnerabilityJobs.ts'))).toBe(true);
  });

  it('resolves every repeat option statically', () => {
    const unresolved = SITES.filter((s) => s.unresolved).map((s) => `${label(s)} -> ${s.unresolved}`);
    expect(
      unresolved,
      'A repeat option must be statically readable so its fire times can be proven '
      + 'collision-free. Use a literal, a same-file const, or jobSchedule(<key>).',
    ).toEqual([]);
  });

  it('reproduces the epoch alignment that caused the stampede', () => {
    // The root cause, asserted directly against BullMQ's own formula. If this
    // ever stops holding, the ban below can be relaxed — until then it cannot.
    const every = 24 * 60 * 60 * 1000;
    for (const now of [
      Date.parse('2026-08-23T13:47:19.281Z'),
      Date.parse('2026-08-23T00:00:00.001Z'),
      Date.parse('2026-02-14T22:03:00.000Z'),
    ]) {
      const nextRun = Math.floor(now / every) * every + every;
      expect(new Date(nextRun).toISOString()).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it('registers no repeatable job with an hour-or-coarser `every` interval', () => {
    const offenders = SITES.flatMap((site) =>
      site.intervals
        .filter((ms) => ms >= COARSE_REPEAT_INTERVAL_MS)
        .map((ms) => `${label(site)} -> every ${ms}ms (${ms / 3_600_000}h)`),
    );
    expect(
      offenders,
      'BullMQ anchors `every` to the Unix epoch, so coarse intervals collide on a '
      + 'shared wall-clock boundary (all 24h jobs land on 00:00:00.000 UTC). Allocate '
      + 'a cron slot in jobs/scheduleRegistry.ts and use `repeat: { pattern }`.',
    ).toEqual([]);
  });

  it('allocates every coarse cron pattern through the registry, exactly once', () => {
    const registryValues = Object.values(JOB_SCHEDULES) as string[];
    expect(new Set(registryValues).size, 'two registry keys share a cron pattern').toBe(
      registryValues.length,
    );

    const usage = new Map<string, string[]>();
    for (const site of SITES) {
      for (const pattern of site.patterns) {
        if (minimumGapMs(pattern) < COARSE_REPEAT_INTERVAL_MS) continue; // fine-grained tick
        usage.set(pattern, [...(usage.get(pattern) ?? []), label(site)]);
      }
    }

    const unregistered = [...usage.keys()].filter((p) => !registryValues.includes(p));
    expect(
      unregistered,
      'Coarse schedules must come from JOB_SCHEDULES so slot conflicts are visible '
      + 'in one place. Add a key to jobs/scheduleRegistry.ts.',
    ).toEqual([]);

    const duplicated = [...usage.entries()]
      .filter(([, sites]) => sites.length > 1)
      .map(([pattern, sites]) => `${pattern} used by ${sites.join(', ')}`);
    expect(duplicated, 'one slot, one job').toEqual([]);

    const unused = registryValues.filter((p) => !usage.has(p));
    expect(unused, 'registry slots that no job registers (delete them)').toEqual([]);
  });

  it('never fires two daily-or-coarser jobs in the same minute', () => {
    const daily = [...new Set(SITES.flatMap((s) => s.patterns))].filter(
      (p) => minimumGapMs(p) >= DAILY_REPEAT_INTERVAL_MS,
    );
    expect(daily.length).toBeGreaterThan(30);

    const occupied = new Map<number, string>();
    const collisions: string[] = [];
    for (const pattern of daily) {
      for (const at of fireTimes(pattern, COLLISION_WINDOW_DAYS)) {
        const minute = Math.floor(at / 60_000);
        const holder = occupied.get(minute);
        if (holder && holder !== pattern) {
          collisions.push(`${new Date(minute * 60_000).toISOString()}: '${holder}' vs '${pattern}'`);
        } else {
          occupied.set(minute, pattern);
        }
      }
    }
    expect(
      [...new Set(collisions)],
      'Daily jobs co-firing is what saturated the 30-connection pool. Move one of '
      + 'them to a free (hour, minute) in jobs/scheduleRegistry.ts.',
    ).toEqual([]);
  });

  it('gives every sub-daily coarse schedule its own minute of the hour', () => {
    const subDaily = [...new Set(SITES.flatMap((s) => s.patterns))].filter((p) => {
      const gap = minimumGapMs(p);
      return gap >= COARSE_REPEAT_INTERVAL_MS && gap < DAILY_REPEAT_INTERVAL_MS;
    });
    expect(subDaily.length).toBeGreaterThan(5);

    const owner = new Map<number, string>();
    const collisions: string[] = [];
    for (const pattern of subDaily) {
      const minutes = new Set(
        fireTimes(pattern, 2).map((at) => new Date(at).getUTCMinutes()),
      );
      for (const minute of minutes) {
        const holder = owner.get(minute);
        if (holder && holder !== pattern) collisions.push(`:${minute} — '${holder}' vs '${pattern}'`);
        else owner.set(minute, pattern);
      }
    }
    expect(
      [...new Set(collisions)],
      'Hourly and 6-hourly sweeps used to pile on :00 the same way the daily jobs '
      + 'piled on 00:00. Pick a free minute in jobs/scheduleRegistry.ts.',
    ).toEqual([]);
  });

  it('detects a re-introduced collision (negative control)', () => {
    // Proves the collision check above is doing work rather than passing vacuously.
    const occupied = new Map<number, string>();
    const collisions: string[] = [];
    for (const pattern of ['0 0 * * *', '0 0 * * *'.replace('0 0', '00 0')]) {
      for (const at of fireTimes(pattern, 3)) {
        const minute = Math.floor(at / 60_000);
        const holder = occupied.get(minute);
        if (holder && holder !== pattern) collisions.push(`${minute}`);
        else occupied.set(minute, pattern);
      }
    }
    expect(collisions.length).toBeGreaterThan(0);
  });
});
