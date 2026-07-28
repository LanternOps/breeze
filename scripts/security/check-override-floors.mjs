#!/usr/bin/env node
/**
 * check-override-floors.mjs — keep `pnpm.overrides` honest.
 *
 * WHY THIS EXISTS (issue #2716)
 * ----------------------------
 * The root `package.json` pins ~50 transitive dependencies under
 * `pnpm.overrides`. Those pins are hand-maintained, and they rot. The failure
 * mode that keeps re-redding Trivy is that **a stale pin is indistinguishable
 * from real coverage by inspection**: reading the overrides block tells you a
 * package is pinned, not that the pin still binds anything.
 *
 * This guard asserts the pins we *did* write are still binding, and reports the
 * ones that have quietly stopped applying.
 *
 * ENFORCED (exit 1)
 * -----------------
 *   LOCK_DESYNC    `pnpm-lock.yaml`'s recorded `overrides:` block disagrees
 *                  with `package.json`. Someone edited the pins and never
 *                  re-ran `pnpm install`, so nothing was re-resolved.
 *   NOT_HONOURED   The lockfile still resolves a version an override's selector
 *                  was supposed to replace. The pin is declared and inert —
 *                  lockfile stickiness. (The second fossil in #2783.)
 *   BELOW_FLOOR    A resolved version sits below the highest floor declared for
 *                  its own version line. Catches overrides for one package
 *                  disagreeing with each other, and exact pins going
 *                  one-patch-short.
 *   NON_ADVANCING  An override's replacement can resolve to a version still
 *                  inside the selector it is meant to escape, so pnpm is free
 *                  to pick the bad version straight back. This is the
 *                  "it's a floor, not a ceiling" bug in structural form.
 *   DEAD           The override's target package resolves nowhere in the
 *                  lockfile, so the pin covers nothing at all.
 *   UNPARSEABLE    A selector or replacement outside this script's grammar.
 *                  Fails closed on purpose: an unrecognised shape must never
 *                  read as a pass.
 *
 * REPORTED, NOT ENFORCED (`--report`)
 * -----------------------------------
 *   NO_LONGER_BINDING  The target still resolves, but nothing resolves in the
 *                      line this override addresses (e.g. a `<12.3.2` pin on a
 *                      package the tree has since taken to 14.x). Usually
 *                      deliberate cheap insurance against a future transitive
 *                      reintroduction, so it is not a failure — but it is
 *                      exactly the "looks like protection" state the issue
 *                      names, so it is surfaced rather than hidden.
 *   UNCOVERED_LINE     A version line with resolutions that no override
 *                      addresses (e.g. `ws@7.5.x` while only 8.x is pinned).
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It cannot tell you a version is vulnerable — that needs an advisory DB, and
 * that is Trivy's and osv-scanner's job. A newly published CVE against a
 * version at or above every declared floor is still a Trivy finding, not a
 * finding here. Nor does it require bounded replacements: whether every
 * `>=X`-style override should carry a ceiling is the open design question in
 * #2684, not something this guard decides.
 *
 * Deliberately dependency-free (no `semver`, no YAML package) so it runs
 * before, or entirely without, `pnpm install`.
 *
 * Usage:
 *   node scripts/security/check-override-floors.mjs            # enforce
 *   node scripts/security/check-override-floors.mjs --report    # + full table
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Overrides that intentionally resolve *into* the range they select — a
 * deliberate downgrade rather than a floor. Without a waiver these fail
 * NON_ADVANCING, because that shape is normally a typo'd pin.
 *
 * Keyed by the exact `pnpm.overrides` key, so rewording a selector re-triggers
 * review instead of silently inheriting the waiver. Every entry needs a reason.
 *
 * Currently empty — kept as the documented escape hatch for NON_ADVANCING.
 */
export const INTENTIONAL_DOWNGRADES = {};

/**
 * Overrides deliberately kept even though their target package resolves
 * nowhere — preemptive pins that must survive a future reintroduction.
 * Anything else that resolves nowhere is a fossil and fails DEAD.
 *
 * Currently empty: the one fossil found when this guard was introduced
 * (`is-generator-function@>=1.1.0`, left over from #507 after the package left
 * the tree entirely) was deleted rather than waived.
 */
export const ALLOWED_DEAD_OVERRIDES = {};

// ---------------------------------------------------------------------------
// Minimal semver
// ---------------------------------------------------------------------------

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_RE =
  /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(raw) {
  const m = VERSION_RE.exec(String(raw).trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    raw: String(raw).trim(),
  };
}

function comparePrerelease(a, b) {
  // A release outranks any prerelease of the same tuple (1.0.0 > 1.0.0-rc.1).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) throw new Error(`cannot compare versions: ${a} <> ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

/**
 * The compatibility line a version belongs to, following caret semantics:
 * `1.x` → "1", but `0.8.x` → "0.8" because 0.x minors are breaking.
 *
 * Floors are compared within a line, never across. The overrides block pins
 * per line on purpose (`undici` carries separate 6.x and 7.x entries), so a
 * global "highest floor wins" model would flag every deliberately unpinned
 * line as drift.
 */
export function versionLine(version) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) throw new Error(`unparseable version "${version}"`);
  return v.major === 0 ? `0.${v.minor}` : String(v.major);
}

/**
 * Parse a semver range into `||`-separated alternatives of comparator lists.
 * Throws on anything outside the small grammar the overrides block uses —
 * failing closed beats guessing.
 */
export function parseRange(raw) {
  const text = String(raw).trim();
  if (!text) throw new Error('empty range');
  return text.split('||').map((alt) => {
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) throw new Error(`empty range alternative in "${raw}"`);
    return parts.map((part) => {
      const m = COMPARATOR_RE.exec(part);
      if (!m) throw new Error(`unsupported comparator "${part}" in range "${raw}"`);
      const version = parseVersion(`${m[2]}.${m[3]}.${m[4]}${m[5] ? `-${m[5]}` : ''}`);
      return { op: m[1] || '=', version };
    });
  });
}

const nextMajor = (v) => parseVersion(`${v.major + 1}.0.0`);
const nextMinor = (v) => parseVersion(`${v.major}.${v.minor + 1}.0`);

/** Expand `^`/`~` into explicit `>=` / `<` comparators. */
function expandComparator(cmp) {
  if (cmp.op === '^') {
    const v = cmp.version;
    let upper;
    if (v.major !== 0) upper = nextMajor(v);
    else if (v.minor !== 0) upper = nextMinor(v);
    else upper = parseVersion(`0.0.${v.patch + 1}`);
    return [
      { op: '>=', version: v },
      { op: '<', version: upper },
    ];
  }
  if (cmp.op === '~') {
    return [
      { op: '>=', version: cmp.version },
      { op: '<', version: nextMinor(cmp.version) },
    ];
  }
  return [cmp];
}

function satisfiesComparator(version, cmp) {
  const c = compareVersions(version, cmp.version);
  switch (cmp.op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '=':
      return c === 0;
    default:
      throw new Error(`unsupported operator "${cmp.op}"`);
  }
}

export function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v) throw new Error(`unparseable version "${version}"`);
  const alternatives = typeof range === 'string' ? parseRange(range) : range;
  return alternatives.some((alt) =>
    alt.flatMap(expandComparator).every((cmp) => satisfiesComparator(v, cmp)),
  );
}

/**
 * Lowest version a range accepts, as `{ version, inclusive }`.
 * Throws when a range has no lower bound (a bare `<2.0.0`): such a value cannot
 * express a floor and must not be silently treated as one.
 */
export function rangeFloor(raw) {
  const alternatives = typeof raw === 'string' ? parseRange(raw) : raw;
  let best = null;
  for (const alt of alternatives) {
    let altFloor = null;
    for (const cmp of alt.flatMap(expandComparator)) {
      if (cmp.op !== '>=' && cmp.op !== '>' && cmp.op !== '=') continue;
      const candidate = { version: cmp.version, inclusive: cmp.op !== '>' };
      if (!altFloor || compareVersions(candidate.version, altFloor.version) > 0) {
        altFloor = candidate;
      }
    }
    if (!altFloor) throw new Error(`range "${raw}" has no lower bound, so it cannot pin a floor`);
    // A `||` range is only guaranteed to hold at its *lowest* alternative.
    if (!best || compareVersions(altFloor.version, best.version) < 0) best = altFloor;
  }
  return best;
}

/** Highest version a range accepts, or null when any alternative is unbounded above. */
export function rangeCeiling(raw) {
  const alternatives = typeof raw === 'string' ? parseRange(raw) : raw;
  let best = null;
  for (const alt of alternatives) {
    let altCeil = null;
    for (const cmp of alt.flatMap(expandComparator)) {
      if (cmp.op !== '<=' && cmp.op !== '<' && cmp.op !== '=') continue;
      const candidate = { version: cmp.version, inclusive: cmp.op !== '<' };
      if (!altCeil || compareVersions(candidate.version, altCeil.version) < 0) altCeil = candidate;
    }
    if (!altCeil) return null;
    if (!best || compareVersions(altCeil.version, best.version) > 0) best = altCeil;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Override key / value parsing
// ---------------------------------------------------------------------------

const PKG_WITH_RANGE_RE = /^(@[^/@\s]+\/[^@\s]+|[^@\s]+?)(?:@(.+))?$/;

/**
 * Split a pnpm override key on the `parent>child` separator without mangling
 * `>=` / `>` comparators inside a range. The separator `>` is never preceded by
 * `@` or whitespace and never followed by `=`, which distinguishes
 * `micromatch@4.0.8>picomatch` from `brace-expansion@>=2.0.0 <2.1.2`.
 */
export function splitSelectorPath(key) {
  const segments = [];
  let start = 0;
  for (let i = 0; i < key.length; i += 1) {
    if (key[i] !== '>') continue;
    if (key[i + 1] === '=') continue; // `>=` comparator
    const prev = key[i - 1];
    if (prev === undefined || prev === '@' || /\s/.test(prev)) continue; // `>` comparator
    segments.push(key.slice(start, i));
    start = i + 1;
  }
  segments.push(key.slice(start));
  if (segments.some((s) => s.trim() === '')) {
    throw new Error(`cannot split override key "${key}" into selector segments`);
  }
  return segments.map((s) => s.trim());
}

/** `{ name, range, parents }` for the *target* (last) segment of an override key. */
export function parseOverrideKey(key) {
  const segments = splitSelectorPath(key);
  const target = segments[segments.length - 1];
  const m = PKG_WITH_RANGE_RE.exec(target);
  if (!m) throw new Error(`cannot parse override target "${target}" from key "${key}"`);
  return { name: m[1], range: m[2] ?? null, parents: segments.slice(0, -1) };
}

/** `{ kind: 'alias' | 'range' | 'local', ... }` for an override replacement value. */
export function parseOverrideValue(value) {
  const text = String(value).trim();
  if (text.startsWith('npm:')) {
    const m = PKG_WITH_RANGE_RE.exec(text.slice('npm:'.length));
    if (!m) throw new Error(`cannot parse alias replacement "${value}"`);
    return { kind: 'alias', name: m[1], range: m[2] ?? null };
  }
  if (/^(link|file|workspace|catalog):/.test(text)) return { kind: 'local', spec: text };
  return { kind: 'range', range: text };
}

// ---------------------------------------------------------------------------
// Lockfile parsing (targeted, no YAML dependency)
// ---------------------------------------------------------------------------

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** The top-level `overrides:` block of pnpm-lock.yaml, as a plain object. */
export function parseLockOverrides(lockText) {
  const out = {};
  let inBlock = false;
  for (const line of lockText.split('\n')) {
    if (/^overrides:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break; // next top-level key ends the block
    if (line.trim() === '') continue;
    const m = /^ {2}(.+?):\s*(.*)$/.exec(line);
    if (!m) throw new Error(`cannot parse lockfile overrides line: ${line}`);
    out[unquote(m[1])] = unquote(m[2]);
  }
  return out;
}

/**
 * Every `name@version` key under `packages:` — the canonical set of resolved
 * versions, as `Map<name, Set<version>>`.
 *
 * `packages:` is used rather than `snapshots:` because its keys carry no
 * peer-dependency suffix, so the version is unambiguous.
 */
export function parseLockResolutions(lockText) {
  const resolutions = new Map();
  let inBlock = false;
  for (const line of lockText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break;
    const m = /^ {2}(\S.*):\s*$/.exec(line);
    if (!m) continue; // nested resolution/engines/cpu/os lines
    const spec = unquote(m[1]);
    const at = spec.lastIndexOf('@');
    if (at <= 0) throw new Error(`cannot parse packages key "${spec}"`);
    const version = spec.slice(at + 1);
    if (!parseVersion(version)) continue; // git/tarball resolution, no semver to compare
    const name = spec.slice(0, at);
    if (!resolutions.has(name)) resolutions.set(name, new Set());
    resolutions.get(name).add(version);
  }
  if (!inBlock) throw new Error('pnpm-lock.yaml has no `packages:` section');
  return resolutions;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {Record<string,string>} args.overrides       package.json pnpm.overrides
 * @param {Record<string,string>} [args.lockOverrides] overrides recorded in pnpm-lock.yaml
 * @param {Map<string,Set<string>>} args.resolutions   resolved versions by package name
 * @returns {{ violations: object[], notices: object[], entries: object[] }}
 */
export function auditOverrides({ overrides, lockOverrides, resolutions }) {
  const violations = [];
  const notices = [];
  const entries = [];

  const resolvedFor = (name) => [...(resolutions.get(name) ?? [])].sort(compareVersions);

  // LOCK_DESYNC — the lockfile must have been resolved against exactly these pins.
  if (lockOverrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in lockOverrides)) {
        violations.push({
          kind: 'LOCK_DESYNC',
          key,
          detail: 'in package.json but not recorded in pnpm-lock.yaml',
        });
      } else if (String(lockOverrides[key]) !== String(value)) {
        violations.push({
          kind: 'LOCK_DESYNC',
          key,
          detail: `package.json pins "${value}" but pnpm-lock.yaml recorded "${lockOverrides[key]}"`,
        });
      }
    }
    for (const key of Object.keys(lockOverrides)) {
      if (!(key in overrides)) {
        violations.push({
          kind: 'LOCK_DESYNC',
          key,
          detail: 'recorded in pnpm-lock.yaml but no longer in package.json',
        });
      }
    }
  }

  // Pass 1 — parse every entry and derive the floor it claims to enforce.
  const parsed = [];
  for (const [key, value] of Object.entries(overrides)) {
    try {
      const target = parseOverrideKey(key);
      const replacement = parseOverrideValue(value);
      const floor =
        replacement.kind === 'range'
          ? rangeFloor(replacement.range)
          : replacement.kind === 'alias' && replacement.range
            ? rangeFloor(replacement.range)
            : null;
      parsed.push({ key, value, target, replacement, floor });
    } catch (err) {
      violations.push({ kind: 'UNPARSEABLE', key, detail: err.message }); // fail closed
    }
  }

  // Highest floor per (package, version line). Alias replacements redirect to a
  // different package, so they are keyed by the alias target's name.
  const floorsByLine = new Map(); // `${name} ${line}` -> { floor, key }
  for (const entry of parsed) {
    if (!entry.floor) continue;
    if (INTENTIONAL_DOWNGRADES[entry.key]) continue;
    const name = entry.replacement.kind === 'alias' ? entry.replacement.name : entry.target.name;
    const mapKey = `${name} ${versionLine(entry.floor.version)}`;
    const current = floorsByLine.get(mapKey);
    if (!current || compareVersions(entry.floor.version, current.floor.version) > 0) {
      floorsByLine.set(mapKey, { floor: entry.floor, key: entry.key, name });
    }
  }

  // Pass 2 — per-entry shape and liveness checks.
  for (const { key, value, target, replacement, floor } of parsed) {
    const name = replacement.kind === 'alias' ? replacement.name : target.name;
    const resolved = resolvedFor(name);
    const record = { key, value, name, resolved, status: 'ok', notes: [] };
    entries.push(record);

    const fail = (kind, detail) => {
      record.status = 'violation';
      violations.push({ kind, key, detail });
    };

    // NON_ADVANCING — the replacement does not actually escape its own selector.
    if (!INTENTIONAL_DOWNGRADES[key] && replacement.kind === 'range' && target.range && floor) {
      const ceiling = rangeCeiling(target.range);
      if (ceiling && compareVersions(floor.version, ceiling.version) < 0) {
        fail(
          'NON_ADVANCING',
          `replacement "${value}" can resolve as low as ${floor.version.raw}, still inside the ` +
            `selector "${target.range}" it is meant to escape — pnpm may pick the bad version ` +
            'straight back (waive via INTENTIONAL_DOWNGRADES if the downgrade is deliberate)',
        );
      }
    }

    // An alias replacement must have actually displaced the original package.
    if (replacement.kind === 'alias' && target.range) {
      const stillMatching = resolvedFor(target.name).filter((v) => satisfies(v, target.range));
      if (stillMatching.length > 0) {
        fail(
          'NOT_HONOURED',
          `pnpm-lock.yaml still resolves ${target.name}@${stillMatching.join(', ')} despite the ` +
            `alias replacement "${value}"`,
        );
      }
    }

    // DEAD — nothing for this package resolves anywhere.
    if (resolved.length === 0) {
      if (ALLOWED_DEAD_OVERRIDES[key]) {
        record.status = 'allowed-dead';
        record.notes.push(`preemptive: ${ALLOWED_DEAD_OVERRIDES[key].reason}`);
      } else {
        fail(
          'DEAD',
          `no version of "${name}" resolves in pnpm-lock.yaml, so this override covers nothing — ` +
            'delete it, or record it in ALLOWED_DEAD_OVERRIDES with a reason',
        );
      }
      continue;
    }

    // NOT_HONOURED — a resolved version still matches the selector.
    if (target.range && replacement.kind === 'range') {
      const stillMatching = resolved.filter((v) => satisfies(v, target.range));
      if (stillMatching.length > 0) {
        fail(
          'NOT_HONOURED',
          `pnpm-lock.yaml still resolves ${name}@${stillMatching.join(', ')}, which the selector ` +
            `"${target.range}" was supposed to replace with "${value}" — re-run \`pnpm install\` ` +
            '(lockfile stickiness) or narrow the selector',
        );
      }
    }

    // NO_LONGER_BINDING (notice) — the pin's line has no resolutions left.
    if (record.status === 'ok' && floor) {
      const line = versionLine(floor.version);
      const inLine = resolved.filter((v) => versionLine(v) === line);
      const matchesSelector = target.range && resolved.some((v) => satisfies(v, target.range));
      if (inLine.length === 0 && !matchesSelector) {
        record.status = 'inert';
        notices.push({
          kind: 'NO_LONGER_BINDING',
          key,
          detail:
            `addresses the ${name}@${line}.x line, but the tree resolves only ` +
            `${resolved.join(', ')} — the pin currently constrains nothing`,
        });
      }
    }
  }

  // BELOW_FLOOR — checked per version line so a lagging path is caught even when
  // it falls outside every selector, without flagging deliberately unpinned lines.
  for (const [, { floor, key, name }] of floorsByLine) {
    const line = versionLine(floor.version);
    const below = resolvedFor(name).filter((v) => {
      if (versionLine(v) !== line) return false;
      const c = compareVersions(v, floor.version);
      return floor.inclusive ? c < 0 : c <= 0;
    });
    if (below.length > 0) {
      violations.push({
        kind: 'BELOW_FLOOR',
        key,
        detail:
          `${name} is pinned to ${floor.inclusive ? '>=' : '>'}${floor.version.raw} by "${key}", ` +
          `but pnpm-lock.yaml resolves ${name}@${below.join(', ')} in the same ${line}.x line`,
      });
    }
  }

  // UNCOVERED_LINE (notice) — resolutions in a line no override addresses.
  for (const { name } of floorsByLine.values()) {
    const covered = new Set(
      [...floorsByLine.values()].filter((f) => f.name === name).map((f) => versionLine(f.floor.version)),
    );
    const uncovered = [...new Set(resolvedFor(name).filter((v) => !covered.has(versionLine(v))))];
    if (uncovered.length > 0 && !notices.some((n) => n.kind === 'UNCOVERED_LINE' && n.key === name)) {
      notices.push({
        kind: 'UNCOVERED_LINE',
        key: name,
        detail:
          `resolves ${name}@${uncovered.join(', ')} in version line(s) no override pins ` +
          `(pinned lines: ${[...covered].sort().join(', ')})`,
      });
    }
  }

  const byKind = (a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key);
  violations.sort(byKind);
  notices.sort(byKind);
  return { violations, notices, entries };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const KIND_HELP = {
  LOCK_DESYNC:
    'pnpm-lock.yaml was not re-resolved after the overrides block changed. Run `pnpm install`.',
  UNPARSEABLE:
    'This script does not understand the selector or replacement. Extend the grammar in check-override-floors.mjs rather than loosening the check.',
  NOT_HONOURED: 'The override is declared but the lockfile ignored it.',
  BELOW_FLOOR: 'A resolution sits below the highest floor declared for its own version line.',
  NON_ADVANCING: 'The replacement does not actually escape the range it selects.',
  DEAD: 'The override matches nothing in the tree and reads as coverage it does not provide.',
};

export function main(argv = []) {
  const reportOnly = argv.includes('--report');
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const overrides = pkg?.pnpm?.overrides;
  if (!overrides || Object.keys(overrides).length === 0) {
    console.error('FAIL: package.json has no pnpm.overrides block — expected transitive pins.');
    return 1;
  }
  const lockText = readFileSync(resolve(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');

  let result;
  try {
    result = auditOverrides({
      overrides,
      lockOverrides: parseLockOverrides(lockText),
      resolutions: parseLockResolutions(lockText),
    });
  } catch (err) {
    console.error(`FAIL: could not audit pnpm.overrides: ${err.message}`);
    return 1;
  }

  const { violations, notices, entries } = result;

  if (reportOnly) {
    for (const e of entries) {
      console.log(
        `${e.status.padEnd(12)} ${e.key} -> ${e.value}  [resolved: ${e.resolved.join(', ') || '(none)'}]`,
      );
      for (const note of e.notes) console.log(`             ${note}`);
    }
    console.log('');
  }

  console.log(
    `Checked ${Object.keys(overrides).length} pnpm.overrides entries against pnpm-lock.yaml.`,
  );

  if (notices.length > 0) {
    if (reportOnly) {
      console.log(`\n${notices.length} advisory notice(s) — not failures:`);
      for (const n of notices) console.log(`  [${n.kind}] ${n.key}: ${n.detail}`);
    } else {
      // Kept out of the passing-CI log on purpose: these are review material,
      // not actionable failures, and 15 lines of them trains people to skim.
      console.log(
        `${notices.length} advisory notice(s) about pins that currently constrain nothing ` +
          '(re-run with --report for detail).',
      );
    }
  }

  if (violations.length === 0) {
    console.log('\nPASS: every override still binds — no stale floors, no dead pins.');
    return 0;
  }

  console.error(`\nFAIL: ${violations.length} pnpm.overrides problem(s):\n`);
  let lastKind = null;
  for (const v of violations) {
    if (v.kind !== lastKind) {
      console.error(`[${v.kind}] ${KIND_HELP[v.kind] ?? ''}`);
      lastKind = v.kind;
    }
    console.error(`  - ${v.key}: ${v.detail}`);
  }
  console.error(
    '\nA stale pin is indistinguishable from real coverage by inspection — that is why this ' +
      'fails CI now instead of waiting for the next Trivy DB refresh (issue #2716).',
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
