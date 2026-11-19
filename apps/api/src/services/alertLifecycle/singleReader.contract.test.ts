/**
 * Settings rule 5 — ONE resolver for alert lifecycle values (spec
 * 2026-10-29-alert-rearm-lifecycle §6.3, plan Task 12).
 *
 * Cooldown and auto-resolve resolve partner default → org override → monitor
 * override for monitor-managed rules, and rule override → template for legacy
 * rules. Every runtime read goes through `services/alertLifecycle/resolve.ts`.
 * A hand-rolled `overrides?.cooldownMinutes ?? template.cooldownMinutes` is
 * exactly how the 15-vs-5 fallback split and the compile-time (org-agnostic)
 * answer for partner-wide monitors crept in, so this test fails on any new one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

/** Reading the lifecycle fields off a rule override, template or monitor row. */
const ROW_NAMES = '(?:overrides|overrideSettings|template|tpl|tmpl|monitor|def|definition|existing)';
const READ_PATTERNS: RegExp[] = [
  new RegExp(`\\b${ROW_NAMES}\\??\\.(?:cooldownMinutes|autoResolve)\\b`),
  /\b(?:cooldownMinutes|autoResolve)\s+as\s+(?:number|boolean)\b/,
  // const { cooldownMinutes } = template / monitor / overrides
  new RegExp(`\\{[^}]*\\b(?:cooldownMinutes|autoResolve)\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?${ROW_NAMES}\\b`),
];

/** Whole paths (relative to apps/api/src, `/`-separated) that are not runtime readers. */
const EXCLUDED_PREFIXES = [
  'db/schema/', // column declarations
  'services/alertLifecycle/', // the resolver itself
  'services/monitors/conversion/', // legacy-rule → monitor conversion maps authored values, never resolves
];

/**
 * Files that touch the fields for a reason other than deciding an alert's
 * lifecycle. Each entry must still match (a stale entry fails the test).
 */
const ALLOWED: Record<string, string> = {
  'services/monitors/monitorCompiler.ts':
    'copies the monitor override `?? BUILTIN` into the NOT NULL compiled template columns; runtime reads come from the loader',
  'services/monitors/monitorService.ts':
    'persists the authored monitor override on create/update (omitted keeps the stored value)',
  'services/monitors/builtInMonitors.ts':
    'seeds the built-in monitors with their authored cooldown',
  'db/seed.ts':
    'dev seed: writes alert template rows from fixture values',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === '__tests__' ? [] : walk(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') && !/\.test\.ts$/.test(path) ? [path] : [];
  });
}

function offendingLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .filter((line) => READ_PATTERNS.some((pattern) => pattern.test(line)));
}

describe('alert lifecycle single reader', () => {
  const files = walk(SRC).map((path) => ({
    rel: relative(SRC, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }));

  it('no file outside alertLifecycle reads cooldownMinutes or autoResolve off a rule, template or monitor row', () => {
    const offenders = files
      .filter(({ rel }) => !EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix)))
      .filter(({ rel }) => !(rel in ALLOWED))
      .flatMap(({ rel, source }) => offendingLines(source).map((line) => `${rel}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('every allowlisted file still matches (no stale exemptions)', () => {
    for (const rel of Object.keys(ALLOWED)) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} is allowlisted but missing`).toBeDefined();
      expect(offendingLines(file!.source).length, `${rel} no longer reads the fields — drop its exemption`).toBeGreaterThan(0);
    }
  });

  it('the patterns catch the hand-rolled fallback shapes they exist for', () => {
    const shapes = [
      'const cooldownMinutes = (overrides?.cooldownMinutes as number) ??',
      '  template?.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES;',
      'const autoResolve = (overrides?.autoResolve as boolean) ?? template.autoResolve;',
      'effectiveCooldownMinutes: monitor.cooldownMinutes,',
      'cooldownMinutes: def.cooldownMinutes,',
      'const { cooldownMinutes, autoResolve } = template;',
      'const cooldown = tpl?.cooldownMinutes;',
    ];
    for (const shape of shapes) expect(offendingLines(shape), shape).toHaveLength(1);
    // A resolved value or an unrelated field is not a row read.
    for (const ok of ['lifecycle.cooldownMinutes', 'row.pending.cooldownMinutes', 'autoResolveConditions: def.autoResolveConditions']) {
      expect(offendingLines(ok), ok).toHaveLength(0);
    }
  });
});
