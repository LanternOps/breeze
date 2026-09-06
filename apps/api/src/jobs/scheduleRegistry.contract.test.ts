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
 * TypeScript AST, resolves each repeat option to a concrete value, and expands
 * the cron patterns with the SAME cron parser BullMQ uses. It is not a
 * mock-shape assertion: adding `repeat: { every: 24 * 60 * 60 * 1000 }` to any
 * file under apps/api/src or ee/ fails it, and so does re-using an already
 * allocated cron slot.
 *
 * BOTH registration idioms are scanned — the legacy `queue.add(…, { repeat })`
 * and `queue.upsertJobScheduler(id, repeatOpts, …)`, which the codebase is
 * migrating toward and which puts the repeat options at the top level rather
 * than under a `repeat` key. A guard blind to the idiom everyone adopts next is
 * a guard with an expiry date.
 *
 * Anything the resolver cannot read statically is reported as UNRESOLVED and
 * fails the suite. That is deliberate and it is fail-CLOSED: `repeat: helper()`,
 * `repeat: SHARED_CONST`, shorthand `{ repeat }` and a spread that could carry
 * `every` are all flagged, not skipped.
 */

import { describe, it, expect, vi } from 'vitest';
import ts from 'typescript';
import parser from 'cron-parser';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JOB_SCHEDULES,
  COARSE_REPEAT_INTERVAL_MS,
  DAILY_REPEAT_INTERVAL_MS,
  isStructurallyValidCron,
  jobSchedule,
} from './scheduleRegistry';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(API_SRC, '../../..');
const SCAN_ROOTS = [API_SRC, path.join(REPO_ROOT, 'ee')];

/**
 * Fixed reference window. Containers run UTC on every deployment.
 *
 * 400 days from a leap year, because `parseExpression` is exclusive of
 * `currentDate`: a shorter window expands `0 0 1 * *`, `0 3 29 2 *` and
 * `0 3 31 * *` to ZERO fire times, which sails through a collision check
 * against nothing. Any monthly billing or month-end anchor job added later
 * has to be genuinely verified, so the window must span every day-of-month
 * and a 29 February.
 */
const REFERENCE_START = new Date('2024-01-01T00:00:00.000Z');
/** Enough to cover every day-of-week for a pattern with no calendar constraint. */
const WEEKLY_WINDOW_DAYS = 7;
/** Every day-of-month, every month, and a 29 February. */
const CALENDAR_WINDOW_DAYS = 400;
const GAP_PROBE_FIRES = 60;

// ---------------------------------------------------------------- source scan

interface RepeatSite {
  file: string;
  line: number;
  /** Which registration idiom this site uses. */
  api: 'queue.add' | 'upsertJobScheduler';
  /** Every candidate value the expression can take (>1 when `||` or a param). */
  patterns: string[];
  intervals: number[];
  /** Raw source of the unresolved sub-expression, when resolution failed. */
  unresolved: string | null;
}

const UNRESOLVED = Symbol('unresolved');
type Resolved = Array<string | number | typeof UNRESOLVED>;

function listTsFiles(dir: string, includeFixtures: boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') listTsFiles(full, includeFixtures, out);
    } else if (
      entry.endsWith('.ts')
      && !entry.endsWith('.d.ts')
      && !entry.endsWith('.test.ts')
      // Deliberately-bad registrations that exist only to prove the scanner
      // finds them (see __tests__/fixtures/epochAlignedRepeat.fixture.ts).
      // Excluded from the production scan; included when the negative-control
      // test points the scanner at the fixture directory on purpose.
      && (includeFixtures || !entry.endsWith('.fixture.ts'))
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

    // `cronFromEnv('ENV', '<key>')` — the env override is an operator escape
    // hatch that cannot be checked statically; the checked-in value is the slot.
    if (calleeName === 'cronFromEnv') {
      const keyArg = expr.arguments[1];
      if (keyArg && ts.isStringLiteral(keyArg)) {
        const value = (JOB_SCHEDULES as Record<string, string>)[keyArg.text];
        return value ? [value] : [UNRESOLVED];
      }
      return [UNRESOLVED];
    }
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

function scanRepeatSites(roots: string[] = SCAN_ROOTS, includeFixtures = false): RepeatSite[] {
  const sites: RepeatSite[] = [];
  const files = roots.flatMap((root) => listTsFiles(root, includeFixtures));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // Both registration idioms: the legacy `queue.add(..., { repeat })` and the
    // Job Scheduler API the codebase is migrating toward, which puts the repeat
    // options at the TOP level of its second argument rather than under a
    // `repeat` key (see jobs/fleetRemediationDispatch.ts and its comment on why
    // the legacy getRepeatableJobs() API leaks entries).
    if (!text.includes('repeat:') && !text.includes('upsertJobScheduler')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const consts = collectFileConsts(source);
    const relative = path.relative(REPO_ROOT, file);

    const newSite = (node: ts.Node, api: RepeatSite['api']): RepeatSite => ({
      file: relative,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      api,
      patterns: [],
      intervals: [],
      unresolved: null,
    });

    /**
     * Read `{ every }` / `{ pattern }` out of a repeat-options expression.
     *
     * Anything that is not a plain object literal — a helper call, a shared
     * const, a spread that could carry `every` — is recorded as UNRESOLVED
     * rather than skipped. Skipping is fail-OPEN: it would let
     * `repeat: buildRepeat()` slip past every assertion below without a word.
     */
    const readOptions = (expr: ts.Expression, site: RepeatSite): void => {
      if (!ts.isObjectLiteralExpression(expr)) {
        site.unresolved = expr.getText().replace(/\s+/g, ' ').slice(0, 120);
        return;
      }
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) {
          // A spread can carry `every`/`pattern` from anywhere.
          site.unresolved = `...${prop.expression.getText().replace(/\s+/g, ' ')}`;
          continue;
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          const key = prop.name.text;
          if (key === 'pattern' || key === 'every' || key === 'cron') {
            site.unresolved = `shorthand { ${key} }`;
          }
          continue;
        }
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
        const key = prop.name.text;
        if (key !== 'pattern' && key !== 'every' && key !== 'cron') continue;
        for (const value of resolveExpression(prop.initializer, source, consts, new Set())) {
          if (value === UNRESOLVED) site.unresolved = prop.initializer.getText().replace(/\s+/g, ' ');
          else if (typeof value === 'string') site.patterns.push(value);
          else site.intervals.push(value);
        }
      }
    };

    const keep = (site: RepeatSite): void => {
      if (site.patterns.length || site.intervals.length || site.unresolved) sites.push(site);
    };

    const visit = (node: ts.Node): void => {
      // ---- legacy: `{ repeat: … }` -----------------------------------------
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'repeat') {
        const site = newSite(node, 'queue.add');
        site.unresolved = 'shorthand { repeat }';
        keep(site);
      } else if (
        ts.isPropertyAssignment(node)
        && ts.isIdentifier(node.name)
        && node.name.text === 'repeat'
      ) {
        const site = newSite(node, 'queue.add');
        readOptions(node.initializer, site);
        keep(site);
      }

      // ---- Job Scheduler API: `upsertJobScheduler(id, repeatOpts, …)` ------
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'upsertJobScheduler'
      ) {
        const site = newSite(node, 'upsertJobScheduler');
        const options = node.arguments[1];
        if (!options) site.unresolved = 'upsertJobScheduler() with no repeat argument';
        else readOptions(options, site);
        keep(site);
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

/**
 * A pattern with `*` for both day-of-month and month repeats on a 7-day cycle,
 * so a one-week expansion characterises it completely. Anything else (a monthly
 * anchor, a 29-February job) needs the full calendar window — cron-parser costs
 * roughly half a millisecond per iteration, so expanding an hourly job over 400
 * days takes ~40s and is not something to do when a week is provably enough.
 */
function isWeeklyCyclic(pattern: string): boolean {
  const fields = pattern.trim().split(/\s+/);
  const five = fields.length === 6 ? fields.slice(1) : fields;
  return five[2] === '*' && five[3] === '*';
}

/** `dow:hh:mm` — the identity of a fire time for a weekly-cyclic pattern. */
function weeklySlot(at: number): string {
  const d = new Date(at);
  return `${d.getUTCDay()}:${d.getUTCHours()}:${d.getUTCMinutes()}`;
}

/** Order-independent identity for a colliding pair of patterns. */
const pairKey = (a: string, b: string): string => [a, b].sort().join(' | ');

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
    // The Job Scheduler idiom is live in the tree; the scan must see it.
    expect(
      SITES.some((s) => s.api === 'upsertJobScheduler'),
      'no upsertJobScheduler registration discovered — the scan is blind to the '
      + 'API the codebase is migrating toward',
    ).toBe(true);
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

    // Fine-grained patterns may also live in the registry when another
    // subsystem needs one canonical cadence (partner trust does this for its
    // 15-minute sweep/promote pair). They are intentionally outside this
    // contract's coarse collision grid.
    const unused = registryValues.filter(
      (p) => minimumGapMs(p) >= COARSE_REPEAT_INTERVAL_MS && !usage.has(p),
    );
    expect(unused, 'registry slots that no job registers (delete them)').toEqual([]);
  });

  it('never fires two coarse schedules in the same minute', () => {
    // ONE pass over BOTH tiers, with no allowlist. Splitting it by tier was the
    // bug the first round of this test shipped with: it proved daily-vs-daily
    // and hourly-vs-hourly while the hourly jobs quietly took out eleven daily
    // slots parked on minute 0 and three more on minute 15, every single day.
    const coarse = [...new Set(SITES.flatMap((s) => s.patterns))].filter(
      (p) => minimumGapMs(p) >= COARSE_REPEAT_INTERVAL_MS,
    );
    expect(coarse.length).toBeGreaterThan(40);

    const collisions = new Set<string>();
    const record = (a: string, b: string): void => {
      if (a !== b) collisions.add(pairKey(a, b));
    };

    // Weekly-cyclic patterns (no day-of-month / month constraint) are compared
    // by `dow:hh:mm`; that is exact for them and ~40x cheaper than expanding a
    // year of hourly fires.
    const [weekly, calendar] = [
      coarse.filter(isWeeklyCyclic),
      coarse.filter((p) => !isWeeklyCyclic(p)),
    ];

    const weeklyOccupancy = new Map<string, string>();
    for (const pattern of weekly) {
      const fires = fireTimes(pattern, WEEKLY_WINDOW_DAYS);
      expect(fires.length, `'${pattern}' never fires in a week yet claims a coarse gap`)
        .toBeGreaterThan(0);
      for (const at of fires) {
        const slot = weeklySlot(at);
        const holder = weeklyOccupancy.get(slot);
        if (holder) record(holder, pattern);
        else weeklyOccupancy.set(slot, pattern);
      }
    }

    // Calendar-constrained patterns (a monthly billing anchor, a 29-February
    // job) get the full window, compared against each other by absolute minute
    // and against the weekly grid by projection. Without this branch such a
    // pattern expands to ZERO fires in a short window and sails through
    // unchecked — which is exactly what a 28-day window did.
    const calendarOccupancy = new Map<number, string>();
    for (const pattern of calendar) {
      const fires = fireTimes(pattern, CALENDAR_WINDOW_DAYS);
      expect(fires.length, `'${pattern}' has no fire times in ${CALENDAR_WINDOW_DAYS} days`)
        .toBeGreaterThan(0);
      for (const at of fires) {
        const minute = Math.floor(at / 60_000);
        const holder = calendarOccupancy.get(minute);
        if (holder) record(holder, pattern);
        else calendarOccupancy.set(minute, pattern);
        const overlapped = weeklyOccupancy.get(weeklySlot(at));
        if (overlapped) record(overlapped, pattern);
      }
    }

    // No allowlist. Every coarse schedule in the API has its own minute.
    expect(
      [...collisions],
      'Two coarse jobs co-firing is what saturated the 30-connection pool. Move '
      + 'one to a free minute in jobs/scheduleRegistry.ts — daily jobs use the '
      + '(mod 5) == 3 lane, sub-daily jobs the (mod 5) == 2 lane. Do not add a '
      + 'waiver list; the last one hid fourteen daily collisions.',
    ).toEqual([]);
  });

  it('would catch a calendar-constrained job that a short window misses', () => {
    // Guards the branch above rather than the data: a 28-day window starting
    // 2026-01-01 expanded all three of these to nothing, so they were admitted
    // to the daily tier and checked against precisely zero other schedules.
    for (const pattern of ['0 0 1 * *', '0 3 29 2 *', '0 3 31 * *']) {
      expect(isWeeklyCyclic(pattern), `'${pattern}' must take the calendar path`).toBe(false);
      expect(fireTimes(pattern, CALENDAR_WINDOW_DAYS).length).toBeGreaterThan(0);
    }
    // …and the fast path really is only taken by patterns a week characterises.
    expect(isWeeklyCyclic('0 * * * *')).toBe(true);
    expect(isWeeklyCyclic('38 3 * * 0')).toBe(true);
  });

  it('finds and flags bad registrations in a fixture the scanner has never seen', () => {
    // The real negative control. Mutating a call site the scanner already found
    // proves only that the assertions work; it says nothing about DISCOVERY,
    // which is the half that silently rots when a new registration idiom
    // appears. This points the same scanner at a directory of deliberately-bad
    // registrations and requires it to find every one.
    const fixtureRoot = path.join(API_SRC, '__tests__/fixtures');
    const found = scanRepeatSites([fixtureRoot], true).filter((s) => s.file.includes('epochAlignedRepeat'));

    expect(found.length, 'scanner found no sites in the fixture at all').toBe(3);

    const legacy = found.find((s) => s.api === 'queue.add' && s.intervals.length);
    expect(legacy?.intervals, 'legacy `repeat: { every: 24h }` not discovered')
      .toEqual([24 * 60 * 60 * 1000]);

    const scheduler = found.find((s) => s.api === 'upsertJobScheduler');
    expect(scheduler?.intervals, 'upsertJobScheduler repeat options not discovered')
      .toEqual([6 * 60 * 60 * 1000]);

    const opaque = found.find((s) => s.unresolved !== null);
    expect(opaque?.unresolved, 'an opaque repeat option was skipped instead of flagged')
      .toBe('fixtureOpaqueRepeat');

    // And the coarse-interval rule really does reject them.
    const offenders = found.flatMap((s) => s.intervals.filter((ms) => ms >= COARSE_REPEAT_INTERVAL_MS));
    expect(offenders).toHaveLength(2);
  });

  it('never accepts an override the real cron parser would reject', () => {
    // `isStructurallyValidCron` cannot use cron-parser (devDependency, and it
    // runs inside the production API), so the safety direction is checked here
    // against the real thing: anything the validator ACCEPTS, the parser must
    // also accept. A false accept is the dangerous direction — it reaches
    // BullMQ's getNextMillis, which parses outside its try/catch.
    const shouldAccept = [
      ...Object.values(JOB_SCHEDULES),
      '*/5 * * * *', '0 0 1 * *', '30 4 * * 1-5', '0 3 29 2 *',
      '15 2,14 * * *', '0 0 * * SUN', '5 4 * jan *', '*/15 9-17 * * 1-5',
      '0 */6 * * *', '0 0 * * 7', '30 */2 1-15 3,6,9,12 *',
    ];
    for (const pattern of shouldAccept) {
      let parserAccepts = true;
      try {
        parser.parseExpression(pattern, { currentDate: REFERENCE_START, tz: 'UTC' });
      } catch {
        parserAccepts = false;
      }
      expect(parserAccepts, `corpus entry '${pattern}' is not actually valid cron`).toBe(true);
      expect(
        isStructurallyValidCron(pattern),
        `isStructurallyValidCron rejects the valid pattern '${pattern}'`,
      ).toBe(true);
    }

    const shouldReject = [
      'not a cron', '99 * * * *', '0 25 * * *', '0 0 32 * *', '0 0 * 13 *',
      '0 0 * * 9', '0 0 * * * * *', '5-1 * * * *', '0 0 * * mon-xyz',
      '*/0 * * * *', '0 0 1 * * extra field',
    ];
    for (const pattern of shouldReject) {
      expect(
        isStructurallyValidCron(pattern),
        `isStructurallyValidCron accepts the invalid pattern '${pattern}'`,
      ).toBe(false);
    }
  });

  it('rejects short patterns that cron-parser silently reinterprets', () => {
    // Discovered while writing this: cron-parser 4.9.0 does NOT reject an
    // under-length expression — it pads the missing fields. `*/5` parses fine
    // and means "day-of-month step 5 at midnight", roughly monthly, NOT "every
    // five minutes"; the empty string parses as "every minute". So the realistic
    // operator typo is not a crash the API can catch, it is a silently wrong
    // cadence that no error ever surfaces.
    //
    // That is why the validator requires a full 5- or 6-field expression: being
    // STRICTER than the parser is the safe direction. The override falls back
    // to the allocated slot with a loud error instead of quietly turning an
    // hourly sweep into a monthly one.
    for (const pattern of ['*/5', '5', '* * * *', '', '   ']) {
      let parserAccepts = true;
      try {
        parser.parseExpression(pattern, { currentDate: REFERENCE_START, tz: 'UTC' });
      } catch {
        parserAccepts = false;
      }
      expect(parserAccepts, `cron-parser unexpectedly rejects '${pattern}'`).toBe(true);
      expect(
        isStructurallyValidCron(pattern),
        `'${pattern}' must be rejected despite cron-parser accepting it`,
      ).toBe(false);
    }

    // Nail down the misreading, so this stays evidence rather than folklore.
    // An operator writing `*/5` means "every five minutes". cron-parser pads the
    // missing fields and lands the day-of-month constraint instead: the first
    // fire is FOUR DAYS out, and once there it repeats every minute. Wrong in
    // both directions, and completely silent.
    const fiveOnly = parser.parseExpression('*/5', { currentDate: REFERENCE_START, tz: 'UTC' });
    const first = fiveOnly.next().getTime();
    const second = fiveOnly.next().getTime();
    expect(first - REFERENCE_START.getTime()).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(second - first).not.toBe(5 * 60 * 1000);
  });

  it('falls back to the allocated slot instead of bricking the API', async () => {
    // BullMQ's getNextMillis calls parseExpression OUTSIDE its try/catch, so an
    // invalid pattern rejects queue.add, which propagates to the initializer
    // catch in index.ts — and that pins /ready to not-ready for the process
    // lifetime. A cadence typo must never cost the whole API.
    const { cronFromEnv } = await import('./scheduleRegistry');
    const slot = jobSchedule('user-risk-scan');
    const previous = process.env.BREEZE_TEST_CRON_OVERRIDE;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      process.env.BREEZE_TEST_CRON_OVERRIDE = '*/5';
      expect(cronFromEnv('BREEZE_TEST_CRON_OVERRIDE', 'user-risk-scan')).toBe(slot);
      expect(errorSpy).toHaveBeenCalled();

      process.env.BREEZE_TEST_CRON_OVERRIDE = '17 5 * * *';
      expect(cronFromEnv('BREEZE_TEST_CRON_OVERRIDE', 'user-risk-scan')).toBe('17 5 * * *');

      delete process.env.BREEZE_TEST_CRON_OVERRIDE;
      expect(cronFromEnv('BREEZE_TEST_CRON_OVERRIDE', 'user-risk-scan')).toBe(slot);

      // A self-hoster still setting the removed *_INTERVAL_MS knob gets told.
      process.env.BREEZE_TEST_LEGACY_INTERVAL_MS = '3600000';
      cronFromEnv('BREEZE_TEST_CRON_OVERRIDE', 'user-risk-scan', 'BREEZE_TEST_LEGACY_INTERVAL_MS');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('BREEZE_TEST_LEGACY_INTERVAL_MS is no longer read'),
      );
    } finally {
      delete process.env.BREEZE_TEST_LEGACY_INTERVAL_MS;
      if (previous === undefined) delete process.env.BREEZE_TEST_CRON_OVERRIDE;
      else process.env.BREEZE_TEST_CRON_OVERRIDE = previous;
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
