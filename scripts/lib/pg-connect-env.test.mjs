// Regression coverage for #4497: scripts/backup.sh and scripts/restore.sh
// used to pass DATABASE_URL (password included) directly on pg_dump's /
// pg_restore's / psql's argv, which is visible to any local user via `ps`
// for the whole duration of the dump/restore.
//
// Two things are covered here:
//   1. pg_url_to_env (scripts/lib/pg-connect-env.sh) correctly splits a
//      postgres:// URL into PG* environment variables, including percent-
//      decoding and the sslmode query parameter.
//   2. A static regression guard: neither script may interpolate
//      DATABASE_URL directly into a pg_dump/pg_restore/psql argument list
//      again.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = join(REPO_ROOT, 'scripts', 'lib', 'pg-connect-env.sh');
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts', 'backup.sh');
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts', 'restore.sh');

// Runs `pg_url_to_env "<url>"` in a fresh bash subshell and returns the PG*
// vars it exported, or { error: <stderr> } if parsing failed.
function parseUrl(url) {
  const script = `
    set -euo pipefail
    source "${LIB}"
    if ! pg_url_to_env "$1"; then
      exit 1
    fi
    printf 'PGHOST=%s\\n' "\${PGHOST:-}"
    printf 'PGPORT=%s\\n' "\${PGPORT:-}"
    printf 'PGUSER=%s\\n' "\${PGUSER:-}"
    printf 'PGPASSWORD=%s\\n' "\${PGPASSWORD:-}"
    printf 'PGDATABASE=%s\\n' "\${PGDATABASE:-}"
    printf 'PGSSLMODE=%s\\n' "\${PGSSLMODE:-}"
  `;
  const result = spawnSync('bash', ['-c', script, 'bash', url], { encoding: 'utf8' });

  if (result.status !== 0) {
    return { error: result.stderr.trim(), status: result.status };
  }

  const vars = {};
  for (const line of result.stdout.trim().split('\n')) {
    const idx = line.indexOf('=');
    vars[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return vars;
}

test('parses a full URL with an encoded password and sslmode', () => {
  const vars = parseUrl(
    'postgresql://breeze:s3cr%40t%2Fp%40ss@db-primary-01.db.example:25060/breeze?sslmode=require',
  );
  assert.equal(vars.PGHOST, 'db-primary-01.db.example');
  assert.equal(vars.PGPORT, '25060');
  assert.equal(vars.PGUSER, 'breeze');
  assert.equal(vars.PGPASSWORD, 's3cr@t/p@ss');
  assert.equal(vars.PGDATABASE, 'breeze');
  assert.equal(vars.PGSSLMODE, 'require');
});

test('handles a URL with no password and no explicit port', () => {
  const vars = parseUrl('postgres://appuser@localhost/mydb');
  assert.equal(vars.PGHOST, 'localhost');
  assert.equal(vars.PGPORT, '');
  assert.equal(vars.PGUSER, 'appuser');
  assert.equal(vars.PGPASSWORD, '');
  assert.equal(vars.PGDATABASE, 'mydb');
});

test('handles a URL with no userinfo at all', () => {
  const vars = parseUrl('postgresql://localhost:5432/breeze');
  assert.equal(vars.PGHOST, 'localhost');
  assert.equal(vars.PGPORT, '5432');
  assert.equal(vars.PGUSER, '');
  assert.equal(vars.PGDATABASE, 'breeze');
});

test('rejects a URL that is not a postgres connection string', () => {
  const vars = parseUrl('not-a-url');
  assert.equal(vars.status, 1);
  assert.match(vars.error, /could not parse connection URL/);
});

test('rejects a URL missing a database name', () => {
  const vars = parseUrl('postgresql://user:pass@localhost:5432');
  assert.equal(vars.status, 1);
  assert.match(vars.error, /missing a database name/);
});

test('parses a bracketed IPv6 host, stripping the brackets for PGHOST', () => {
  const vars = parseUrl('postgresql://user:pass@[::1]:5432/breeze');
  assert.equal(vars.PGHOST, '::1');
  assert.equal(vars.PGPORT, '5432');
  assert.equal(vars.PGUSER, 'user');
  assert.equal(vars.PGDATABASE, 'breeze');
});

test('parses a bracketed IPv6 host with no explicit port', () => {
  const vars = parseUrl('postgresql://user@[2001:db8::1]/breeze');
  assert.equal(vars.PGHOST, '2001:db8::1');
  assert.equal(vars.PGDATABASE, 'breeze');
});

test('parses a bracketed IPv6 host together with a query string', () => {
  const vars = parseUrl('postgresql://user:pass@[::1]:5432/breeze?sslmode=require&connect_timeout=5');
  assert.equal(vars.PGHOST, '::1');
  assert.equal(vars.PGDATABASE, 'breeze');
  assert.equal(vars.PGSSLMODE, 'require');
});

test('percent-decodes a user containing an escaped special character', () => {
  const vars = parseUrl('postgresql://us%40er:pass@host:5432/db');
  assert.equal(vars.PGUSER, 'us@er');
});

test('percent-decodes a database name containing an escaped space', () => {
  const vars = parseUrl('postgresql://user:pass@host:5432/my%20db');
  assert.equal(vars.PGDATABASE, 'my db');
});

test('distinguishes an explicit empty password from no password at all', () => {
  const withColon = parseUrl('postgresql://user:@host:5432/db');
  assert.equal(withColon.PGUSER, 'user');
  assert.equal(withColon.PGPASSWORD, '');

  const withoutColon = parseUrl('postgresql://user@host:5432/db');
  assert.equal(withoutColon.PGUSER, 'user');
  assert.equal(withoutColon.PGPASSWORD, '');
});

test('rejects a password with a truncated percent-escape instead of silently mangling it', () => {
  // A trailing bare '%' used to reach `printf %b` unchecked, which either
  // errored non-obviously or (platform-dependent) produced a corrupted
  // PGPASSWORD value while pg_url_to_env still reported success.
  const vars = parseUrl('postgresql://user:abc%@host:5432/db');
  assert.equal(vars.status, 1);
  assert.match(vars.error, /invalid password/);
});

test('rejects a password with non-hex percent-escape digits', () => {
  const vars = parseUrl('postgresql://user:abc%zzpass@host:5432/db');
  assert.equal(vars.status, 1);
  assert.match(vars.error, /invalid password/);
});

test('warns (but still connects) when the query string has parameters beyond sslmode', () => {
  const script = `
    set -euo pipefail
    source "${LIB}"
    pg_url_to_env "$1"
    printf 'PGHOST=%s\\n' "\${PGHOST:-}"
  `;
  const result = spawnSync(
    'bash',
    ['-c', script, 'bash', 'postgresql://user:pass@host:5432/db?sslmode=require&connect_timeout=10'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /PGHOST=host/);
  assert.match(result.stderr, /ignoring unsupported connection URL parameter.*connect_timeout/);
});

test('does not warn when the query string only has sslmode', () => {
  const script = `
    set -euo pipefail
    source "${LIB}"
    pg_url_to_env "$1"
  `;
  const result = spawnSync(
    'bash',
    ['-c', script, 'bash', 'postgresql://user:pass@host:5432/db?sslmode=require'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('reports multiple extra query parameters together, comma-joined', () => {
  const script = `
    set -euo pipefail
    source "${LIB}"
    pg_url_to_env "$1"
  `;
  const result = spawnSync(
    'bash',
    [
      '-c',
      script,
      'bash',
      'postgresql://user:pass@host:5432/db?sslmode=require&connect_timeout=5&application_name=backup',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.match(result.stderr, /connect_timeout,application_name/);
});

// --- Static regression guard -----------------------------------------------
//
// Mirrors the philosophy of scripts/check-selfhost-db-urls.sh: assert the
// ABSENCE of the vulnerable pattern, not merely the presence of the fix, so
// a future edit that reintroduces `pg_dump "$DATABASE_URL"` (or similar)
// fails loudly instead of silently shipping the credential-on-argv bug again.
//
// Like any grep-based guard (same limitation as check-selfhost-db-urls.sh),
// this catches the direct/literal pattern but not deliberate indirection —
// e.g. assigning DATABASE_URL to a local var first, a line continuation
// between the command and the URL, or `eval`. It's meant to catch an
// accidental regression during a normal edit, not a determined bypass.
const ARGV_SECRET_PATTERNS = [
  /pg_dump\s+"?\$\{?DATABASE_URL\}?"?/,
  /pg_restore\b[^\n]*-d\s+"?\$\{?DATABASE_URL\}?"?/,
  /psql\s+"?\$\{?DATABASE_URL\}?"?/,
];

for (const scriptPath of [BACKUP_SCRIPT, RESTORE_SCRIPT]) {
  test(`${scriptPath.slice(REPO_ROOT.length + 1)} never puts DATABASE_URL on a pg_dump/pg_restore/psql argv`, () => {
    const contents = readFileSync(scriptPath, 'utf8');
    for (const pattern of ARGV_SECRET_PATTERNS) {
      assert.doesNotMatch(contents, pattern);
    }
    assert.match(
      contents,
      /source ".*lib\/pg-connect-env\.sh"/,
      'expected the script to source scripts/lib/pg-connect-env.sh',
    );
  });
}
