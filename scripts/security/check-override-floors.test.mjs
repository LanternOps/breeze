import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditOverrides,
  compareVersions,
  parseLockOverrides,
  parseLockResolutions,
  parseOverrideKey,
  parseOverrideValue,
  parseRange,
  parseVersion,
  rangeCeiling,
  rangeFloor,
  satisfies,
  splitSelectorPath,
  versionLine,
} from './check-override-floors.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Build the `resolutions` map from a plain `{ name: [versions] }` object. */
const resolutionsOf = (obj) =>
  new Map(Object.entries(obj).map(([name, versions]) => [name, new Set(versions)]));

const audit = (overrides, resolved, lockOverrides = null) =>
  auditOverrides({ overrides, lockOverrides, resolutions: resolutionsOf(resolved) });

const kinds = (list) => list.map((v) => v.kind).sort();

// ---------------------------------------------------------------------------
// semver primitives
// ---------------------------------------------------------------------------

test('parseVersion accepts plain, prerelease and build-metadata versions', () => {
  assert.deepEqual(
    { ...parseVersion('1.2.3'), raw: undefined },
    { major: 1, minor: 2, patch: 3, prerelease: [], raw: undefined },
  );
  assert.deepEqual(parseVersion('2.0.0-rc.1').prerelease, ['rc', '1']);
  assert.equal(parseVersion('1.2.3+build7').patch, 3);
  assert.equal(parseVersion('v1.2.3').major, 1);
  for (const bad of ['1.2', 'latest', '*', '1.x', '', 'next']) {
    assert.equal(parseVersion(bad), null, `expected "${bad}" to be unparseable`);
  }
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.9', '1.2.10'), -1, '9 must sort below 10');
  assert.equal(compareVersions('5.0.7', '5.0.6'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('compareVersions ranks a release above its prereleases', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1, 'numeric ids sort below alphanumeric');
});

test('versionLine follows caret semantics: 0.x minors are their own line', () => {
  assert.equal(versionLine('1.2.3'), '1');
  assert.equal(versionLine('10.0.0'), '10');
  assert.equal(versionLine('0.8.13'), '0.8');
  assert.equal(versionLine('0.9.10'), '0.9');
});

// ---------------------------------------------------------------------------
// range parsing
// ---------------------------------------------------------------------------

test('parseRange rejects shapes outside the grammar instead of guessing', () => {
  for (const bad of ['*', '>=1.x', 'latest', '>= ', '1.2', '^1']) {
    assert.throws(() => parseRange(bad), /unsupported comparator|empty range/, `"${bad}"`);
  }
});

test('satisfies handles the comparator shapes used by pnpm.overrides', () => {
  assert.ok(satisfies('5.10.1', '>=5.10.1'));
  assert.ok(!satisfies('5.9.3', '>=5.10.1'));
  assert.ok(satisfies('5.6.0', '>=5.6.4 <=5.8.0') === false);
  assert.ok(satisfies('5.7.0', '>=5.6.4 <=5.8.0'));
  assert.ok(satisfies('5.8.0', '>=5.6.4 <=5.8.0'), '<= is inclusive');
  assert.ok(!satisfies('5.8.1', '>=5.6.4 <=5.8.0'));
  assert.ok(satisfies('6.27.0', '>=6.27.0 <7.0.0'));
  assert.ok(!satisfies('7.0.0', '>=6.27.0 <7.0.0'), '< is exclusive');
  assert.ok(satisfies('4.0.0', '=4.0.0'));
  assert.ok(satisfies('3.1.0', '^3.1.0'));
  assert.ok(!satisfies('4.0.0', '^3.1.0'));
  assert.ok(satisfies('0.8.20', '^0.8.13'), '^0.8.x stays inside 0.8');
  assert.ok(!satisfies('0.9.0', '^0.8.13'));
  assert.ok(satisfies('1.2.9', '~1.2.3'));
  assert.ok(!satisfies('1.3.0', '~1.2.3'));
  assert.ok(satisfies('9.9.9', '>=1.0.0 <2.0.0 || >=9.0.0'), '|| alternatives');
});

test('rangeFloor returns the lowest accepted version and flags exclusivity', () => {
  assert.equal(rangeFloor('>=5.10.1').version.raw, '5.10.1');
  assert.equal(rangeFloor('>=5.10.1').inclusive, true);
  assert.equal(rangeFloor('>2.0.0').inclusive, false);
  assert.equal(rangeFloor('5.0.7').version.raw, '5.0.7', 'a bare version is an exact pin');
  assert.equal(rangeFloor('>=6.27.0 <7.0.0').version.raw, '6.27.0');
  assert.equal(rangeFloor('^3.1.0').version.raw, '3.1.0');
  // A `||` range only guarantees its lowest alternative.
  assert.equal(rangeFloor('>=9.0.0 || >=2.0.0').version.raw, '2.0.0');
});

test('rangeFloor refuses a value with no lower bound rather than inventing one', () => {
  // `<2.0.0` as a *replacement* cannot express a floor; treating it as one
  // would silently pass every version below 2.
  assert.throws(() => rangeFloor('<2.0.0'), /no lower bound/);
  assert.throws(() => rangeFloor('<=1.15.11'), /no lower bound/);
});

test('rangeCeiling is null when any alternative is unbounded above', () => {
  assert.equal(rangeCeiling('>=5.10.1'), null);
  assert.equal(rangeCeiling('<5.10.1').version.raw, '5.10.1');
  assert.equal(rangeCeiling('<5.10.1').inclusive, false);
  assert.equal(rangeCeiling('<=6.15.1').inclusive, true);
  assert.equal(rangeCeiling('>=6.0.0 <6.27.0').version.raw, '6.27.0');
  assert.equal(rangeCeiling('>=1.0.0 <2.0.0 || >=9.0.0'), null);
});

// ---------------------------------------------------------------------------
// override key/value parsing
// ---------------------------------------------------------------------------

test('splitSelectorPath tells a nested selector apart from a >= comparator', () => {
  // The bug this guards: naively splitting on ">" mangles every range.
  assert.deepEqual(splitSelectorPath('micromatch@4.0.8>picomatch'), [
    'micromatch@4.0.8',
    'picomatch',
  ]);
  assert.deepEqual(splitSelectorPath('brace-expansion@>=2.0.0 <2.1.2'), [
    'brace-expansion@>=2.0.0 <2.1.2',
  ]);
  assert.deepEqual(splitSelectorPath('lodash@>=4.0.0 <=4.17.22'), ['lodash@>=4.0.0 <=4.17.22']);
  assert.deepEqual(splitSelectorPath('foo@>1.0.0'), ['foo@>1.0.0'], 'bare > after @ is a comparator');
  assert.deepEqual(splitSelectorPath('a@1.0.0>b@2.0.0>c'), ['a@1.0.0', 'b@2.0.0', 'c']);
});

test('parseOverrideKey extracts the target package, including scoped names', () => {
  assert.deepEqual(parseOverrideKey('adm-zip@<0.6.0'), {
    name: 'adm-zip',
    range: '<0.6.0',
    parents: [],
  });
  assert.deepEqual(parseOverrideKey('@xmldom/xmldom@<0.8.13'), {
    name: '@xmldom/xmldom',
    range: '<0.8.13',
    parents: [],
  });
  assert.deepEqual(parseOverrideKey('@babel/core@<7.29.6').name, '@babel/core');
  assert.deepEqual(parseOverrideKey('lodash'), { name: 'lodash', range: null, parents: [] });
  const nested = parseOverrideKey('micromatch@4.0.8>picomatch');
  assert.equal(nested.name, 'picomatch');
  assert.deepEqual(nested.parents, ['micromatch@4.0.8']);
});

test('parseOverrideValue distinguishes alias, range and local replacements', () => {
  assert.deepEqual(parseOverrideValue('npm:neoip@^3.1.0'), {
    kind: 'alias',
    name: 'neoip',
    range: '^3.1.0',
  });
  assert.deepEqual(parseOverrideValue('>=5.10.1'), { kind: 'range', range: '>=5.10.1' });
  assert.equal(parseOverrideValue('link:../local').kind, 'local');
});

// ---------------------------------------------------------------------------
// lockfile parsing
// ---------------------------------------------------------------------------

const SAMPLE_LOCK = `lockfileVersion: '9.0'

overrides:
  adm-zip@<0.6.0: '>=0.6.0'
  '@babel/core@<7.29.6': '>=7.29.6 <8.0.0'
  ip@<=2.0.1: npm:neoip@^3.1.0

importers:

  .:
    dependencies:
      adm-zip:
        specifier: ^0.6.0
        version: 0.6.0

packages:

  '@babel/core@7.29.7':
    resolution: {integrity: sha512-aaa==}
    engines: {node: '>=6.9.0'}

  adm-zip@0.6.0:
    resolution: {integrity: sha512-bbb==}

  neoip@3.1.0:
    resolution: {integrity: sha512-ccc==}

  some-pkg@https://example.invalid/tarball.tgz:
    resolution: {tarball: https://example.invalid/tarball.tgz}

snapshots:

  adm-zip@0.6.0: {}
`;

test('parseLockOverrides reads the overrides block and unquotes keys', () => {
  assert.deepEqual(parseLockOverrides(SAMPLE_LOCK), {
    'adm-zip@<0.6.0': '>=0.6.0',
    '@babel/core@<7.29.6': '>=7.29.6 <8.0.0',
    'ip@<=2.0.1': 'npm:neoip@^3.1.0',
  });
});

test('parseLockResolutions collects packages-section versions only', () => {
  const resolutions = parseLockResolutions(SAMPLE_LOCK);
  assert.deepEqual([...resolutions.get('@babel/core')], ['7.29.7'], 'scoped name kept intact');
  assert.deepEqual([...resolutions.get('adm-zip')], ['0.6.0']);
  assert.deepEqual([...resolutions.get('neoip')], ['3.1.0']);
  assert.equal(resolutions.has('some-pkg'), false, 'non-semver resolutions are skipped');
  // `importers:` precedes `packages:`; its version lines must not leak in.
  assert.equal(resolutions.size, 3);
});

test('parseLockResolutions fails closed when there is no packages section', () => {
  assert.throws(() => parseLockResolutions("lockfileVersion: '9.0'\n"), /no `packages:` section/);
});

// ---------------------------------------------------------------------------
// audit — the enforced classes
// ---------------------------------------------------------------------------

test('a healthy overrides block produces no violations', () => {
  const { violations, notices } = audit(
    { 'adm-zip@<0.6.0': '>=0.6.0', 'axios@>=1.0.0 <1.15.2': '>=1.15.2' },
    { 'adm-zip': ['0.6.0'], axios: ['1.18.0'] },
  );
  assert.deepEqual(violations, []);
  assert.deepEqual(notices, []);
});

test('NOT_HONOURED fires when the lockfile still resolves a selected version', () => {
  // #2783's second fossil: the override was declared, lockfile stickiness kept
  // a matching version, and the pin did nothing.
  const { violations } = audit(
    { 'brace-expansion@>=2.0.0 <2.1.2': '>=2.1.2' },
    { 'brace-expansion': ['2.0.1', '5.0.8'] },
  );
  // 2.0.1 both matches the selector and sits below the 2.x floor, so both
  // classes fire on the same root cause. Either one is enough to red CI.
  assert.deepEqual(kinds(violations), ['BELOW_FLOOR', 'NOT_HONOURED']);
  assert.match(
    violations.find((v) => v.kind === 'NOT_HONOURED').detail,
    /still resolves brace-expansion@2\.0\.1/,
  );
});

test('BELOW_FLOOR catches an exact pin that went one patch short', () => {
  // Two overrides for one package disagree: the 5.0.6 pin was bumped to 5.0.8
  // while another path stuck at 5.0.7.
  const { violations } = audit(
    { 'brace-expansion@5.0.6': '5.0.8', 'brace-expansion@<1.1.16': '>=1.1.16' },
    { 'brace-expansion': ['5.0.7'] },
  );
  assert.deepEqual(kinds(violations), ['BELOW_FLOOR']);
  assert.match(violations[0].detail, /resolves brace-expansion@5\.0\.7 in the same 5\.x line/);
});

test('BELOW_FLOOR is scoped per version line, so deliberately unpinned lines pass', () => {
  // The repo pins undici per major on purpose. A global "highest floor wins"
  // model would flag the 6.x resolution against the 7.x floor.
  const { violations } = audit(
    {
      'undici@>=6.0.0 <6.27.0': '>=6.27.0 <7.0.0',
      'undici@>=7.0.0 <7.28.0': '>=7.28.0 <8.0.0',
      'ws@>=8.0.0 <8.20.1': '>=8.20.1',
    },
    { undici: ['6.27.0', '7.28.0'], ws: ['7.5.13', '8.21.1'] },
  );
  assert.deepEqual(violations, []);
});

test('BELOW_FLOOR still fires inside a pinned line', () => {
  const { violations } = audit({ 'undici@>=7.0.0 <7.28.0': '>=7.28.0 <8.0.0' }, {
    undici: ['7.28.0', '7.29.0', '6.10.0'],
  });
  assert.deepEqual(violations, [], 'a 6.x resolution is outside the pinned 7.x line');

  const drifted = audit({ 'undici@5.1.0': '5.2.0' }, { undici: ['5.1.9'] });
  assert.deepEqual(kinds(drifted.violations), ['BELOW_FLOOR']);
});

test('NON_ADVANCING catches a replacement that cannot escape its own selector', () => {
  // The structural form of the issue's headline bug: the replacement is a floor
  // that the selected range already satisfies, so pnpm may re-pick the bad one.
  const { violations } = audit({ 'foo@>=1.0.0 <2.0.0': '>=1.5.0' }, { foo: ['1.9.0'] });
  assert.ok(kinds(violations).includes('NON_ADVANCING'));
  assert.match(violations.find((v) => v.kind === 'NON_ADVANCING').detail, /still inside the selector/);
});

test('NON_ADVANCING does not fire on an unbounded selector', () => {
  const { violations } = audit({ 'foo@<2.0.0': '>=2.0.0' }, { foo: ['2.1.0'] });
  assert.equal(violations.filter((v) => v.kind === 'NON_ADVANCING').length, 0);
});

test('DEAD fires when the target package resolves nowhere', () => {
  // The real fossil this guard found: is-generator-function had left the tree
  // entirely, so the pin was pure decoration.
  const { violations } = audit({ 'is-generator-function@>=1.1.0': '1.0.10' }, { lodash: ['4.18.1'] });
  assert.deepEqual(kinds(violations), ['DEAD']);
  assert.match(violations[0].detail, /resolves in pnpm-lock\.yaml/);
});

test('UNPARSEABLE fails closed on a shape the grammar does not cover', () => {
  const { violations } = audit({ 'foo@*': 'latest' }, { foo: ['1.0.0'] });
  assert.deepEqual(kinds(violations), ['UNPARSEABLE']);
});

test('a replacement with no lower bound is UNPARSEABLE, never a silent pass', () => {
  const { violations } = audit({ 'foo@>=1.0.0': '<2.0.0' }, { foo: ['0.1.0'] });
  assert.deepEqual(kinds(violations), ['UNPARSEABLE']);
});

test('LOCK_DESYNC catches an overrides edit that was never re-resolved', () => {
  const overrides = { 'adm-zip@<0.6.0': '>=0.6.0', 'axios@>=1.0.0 <1.15.2': '>=1.15.2' };
  const resolved = { 'adm-zip': ['0.6.0'], axios: ['1.18.0'] };

  const missing = audit(overrides, resolved, { 'adm-zip@<0.6.0': '>=0.6.0' });
  assert.deepEqual(kinds(missing.violations), ['LOCK_DESYNC']);
  assert.match(missing.violations[0].detail, /not recorded in pnpm-lock\.yaml/);

  const changed = audit(overrides, resolved, { ...overrides, 'adm-zip@<0.6.0': '>=0.5.0' });
  assert.match(changed.violations[0].detail, /recorded ">=0\.5\.0"/);

  const leftover = audit(overrides, resolved, { ...overrides, 'gone@<1.0.0': '>=1.0.0' });
  assert.match(
    leftover.violations.find((v) => v.key === 'gone@<1.0.0').detail,
    /no longer in package\.json/,
  );

  assert.deepEqual(audit(overrides, resolved, overrides).violations, []);
});

// ---------------------------------------------------------------------------
// audit — aliases, waivers and notices
// ---------------------------------------------------------------------------

test('an alias replacement is checked against the alias target', () => {
  const clean = audit({ 'ip@<=2.0.1': 'npm:neoip@^3.1.0' }, { neoip: ['3.1.0'] });
  assert.deepEqual(clean.violations, []);

  // The original package surviving at a selected version means the alias never took.
  const stale = audit({ 'ip@<=2.0.1': 'npm:neoip@^3.1.0' }, { neoip: ['3.1.0'], ip: ['2.0.1'] });
  assert.deepEqual(kinds(stale.violations), ['NOT_HONOURED']);
});

test('a nested selector is audited against its child package', () => {
  const { violations } = audit({ 'micromatch@4.0.8>picomatch': '4.0.4' }, { picomatch: ['4.0.4'] });
  assert.deepEqual(violations, []);

  const drifted = audit({ 'micromatch@4.0.8>picomatch': '4.0.4' }, { picomatch: ['4.0.3'] });
  assert.deepEqual(kinds(drifted.violations), ['BELOW_FLOOR']);
});

test('NO_LONGER_BINDING is a notice, not a failure', () => {
  // Cheap insurance against a future reintroduction — worth surfacing, not worth
  // blocking CI over.
  const { violations, notices } = audit({ 'markdown-it@<12.3.2': '>=12.3.2' }, {
    'markdown-it': ['14.3.0'],
  });
  assert.deepEqual(violations, []);
  assert.deepEqual(kinds(notices), ['NO_LONGER_BINDING', 'UNCOVERED_LINE']);
});

test('UNCOVERED_LINE reports resolutions in a line no override pins', () => {
  const { violations, notices } = audit({ 'ws@>=8.0.0 <8.20.1': '>=8.20.1' }, {
    ws: ['7.5.13', '8.21.1'],
  });
  assert.deepEqual(violations, []);
  const uncovered = notices.find((n) => n.kind === 'UNCOVERED_LINE');
  assert.match(uncovered.detail, /ws@7\.5\.13/);
});

// ---------------------------------------------------------------------------
// historical regressions
// ---------------------------------------------------------------------------

test('regression #2714: a floor satisfied by a higher vulnerable version is only a notice', () => {
  // Documents a real limit rather than overclaiming. `fast-xml-parser@<5.7.0:
  // '>=5.7.0'` was satisfied by 5.9.3, which carried GHSA-8r6m-32jq-jx6q.
  // Nothing local can know 5.9.3 is vulnerable — that is Trivy's job. What this
  // guard *can* say is that the pin no longer constrains the resolved version.
  const { violations, notices } = audit({ 'fast-xml-parser@<5.7.0': '>=5.7.0' }, {
    'fast-xml-parser': ['5.9.3'],
  });
  assert.deepEqual(violations, [], 'not a failure: 5.9.3 is above the declared floor');
  assert.equal(
    notices.filter((n) => n.kind === 'UNCOVERED_LINE').length,
    0,
    '5.9.3 is inside the pinned 5.x line',
  );

  // Once the bounded entry from #2714 is added, drift below it does fail.
  const bounded = audit(
    { 'fast-xml-parser@<5.7.0': '>=5.7.0', 'fast-xml-parser@<5.10.1': '>=5.10.1' },
    { 'fast-xml-parser': ['5.9.3'] },
  );
  assert.deepEqual(kinds(bounded.violations), ['BELOW_FLOOR', 'NOT_HONOURED']);
});

test('regression: the real repo package.json and lockfile pass the audit', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const lockText = readFileSync(resolve(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8');
  const overrides = pkg.pnpm.overrides;

  assert.ok(Object.keys(overrides).length > 40, 'expected the transitive pin block to be present');

  const { violations } = auditOverrides({
    overrides,
    lockOverrides: parseLockOverrides(lockText),
    resolutions: parseLockResolutions(lockText),
  });
  assert.deepEqual(
    violations.map((v) => `${v.kind} ${v.key}`),
    [],
    'pnpm.overrides has drifted — run `node scripts/security/check-override-floors.mjs --report`',
  );
});
