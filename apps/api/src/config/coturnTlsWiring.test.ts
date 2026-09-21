import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * Both shipped Compose files started coturn with `--tls-listening-port=5349`
 * but never gave it a certificate. coturn skips the TLS listener SILENTLY when
 * `--cert`/`--pkey` are absent, so `turns:` was unusable in every self-hosted
 * deployment and nothing in the logs said why (#6163).
 *
 * The fix is opt-in: `TURN_TLS_DIR` is bind-mounted at /etc/coturn/tls and the
 * existing entrypoint wrapper appends `--cert`/`--pkey` at runtime only when
 * the pair is actually readable — Compose cannot make a flag conditional inside
 * a static `command:` list. Unset `TURN_TLS_DIR` keeps today's behaviour, minus
 * the silence: the wrapper logs why 5349 will not listen.
 *
 * This guard pins all four properties in the required test-api job so the
 * advertised-but-dead listener cannot come back.
 */
const COMPOSE_FILES = [
  'docker-compose.yml',
  'deploy/docker-compose.prod.yml',
  // The dev override defines its OWN standalone coturn service: Compose does
  // not deep-merge a `command:` list, so the base fix never reaches it and it
  // shipped the same dead 5349 listener until #6163.
  'docker-compose.override.yml.dev',
];

function coturnBlock(composeFile: string): string {
  const text = readFileSync(path.join(REPO_ROOT, composeFile), 'utf8');
  const start = text.indexOf('\n  coturn:');
  expect(start, `${composeFile} has no coturn service`).toBeGreaterThan(-1);
  // Until the next top-level-service (two-space) key, or EOF.
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe.each(COMPOSE_FILES)('coturn TLS wiring (%s)', (composeFile) => {
  const block = coturnBlock(composeFile);

  it('still advertises the TLS listening port', () => {
    expect(block).toContain('--tls-listening-port=5349');
  });

  it('bind-mounts TURN_TLS_DIR read-only at /etc/coturn/tls', () => {
    expect(block).toMatch(/\$\{TURN_TLS_DIR:-[^}]+\}:\/etc\/coturn\/tls:ro/);
  });

  it('passes --cert and --pkey from the mounted directory', () => {
    expect(block).toContain('--cert=/etc/coturn/tls/cert.pem');
    expect(block).toContain('--pkey=/etc/coturn/tls/privkey.pem');
  });

  it('gates the TLS flags on the certificate pair being readable, and says so when it is not', () => {
    // Readability matters: coturn drops to `nobody` (65534) and Caddy writes its
    // certificate 0600 root, so a naive mount of Caddy's directory yields an
    // unreadable pair — which must not be passed as --cert.
    expect(block).toContain('-r /etc/coturn/tls/cert.pem');
    expect(block).toContain('-r /etc/coturn/tls/privkey.pem');
    expect(block).toMatch(/TURNS \(5349\) (is )?(disabled|not)/i);
  });
});

describe('TURN TLS documentation', () => {
  it('documents TURN_TLS_DIR and TURN_TLS_HOST in .env.example', () => {
    const env = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    expect(env).toContain('TURN_TLS_DIR');
    expect(env).toContain('TURN_TLS_HOST');
  });
});

/**
 * The gate above is shell embedded in YAML, so the string assertions cannot tell
 * us whether it actually *works*. Extract it and run it under a real `/bin/sh`
 * with a stub `turnserver` on PATH, so the argument splicing (`set -- "$@" …`
 * inside a script whose $0 is `turnserver`) and the readability branch are
 * executed, not just pattern-matched.
 */
function runGate(certState: 'none' | 'readable' | 'unreadable' | 'expired'): {
  args: string[];
  stderr: string;
} {
  const composeText = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const start = composeText.indexOf('        if [ -r /etc/coturn/tls/cert.pem ]');
  expect(start, 'TLS gate not found in docker-compose.yml').toBeGreaterThan(-1);
  const end = composeText.indexOf('exec turnserver', start);
  // `$$` is Compose's escape for a literal `$`; the container's shell sees `$`.
  const gate = composeText.slice(start, end).replace(/\$\$/g, '$');

  const dir = mkdtempSync(path.join(tmpdir(), 'coturn-tls-'));
  const tlsDir = path.join(dir, 'tls');
  const binDir = path.join(dir, 'bin');
  execFileSync('mkdir', ['-p', tlsDir, binDir]);

  if (certState !== 'none') {
    // A real self-signed pair: `openssl x509 -checkend 0` must be able to parse
    // it, so a fixture string would not exercise the expiry branch at all.
    const days = certState === 'expired' ? undefined : '3650';
    if (days) {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', days,
        '-subj', '/CN=turn.example.test',
        '-keyout', path.join(tlsDir, 'privkey.pem'),
        '-out', path.join(tlsDir, 'cert.pem'),
      ], { stdio: 'ignore' });
    } else {
      // No portable way to mint an already-expired cert with `req -x509`, so
      // stand in an unparseable certificate: the gate must treat it the same.
      writeFileSync(path.join(tlsDir, 'cert.pem'), 'not a certificate\n');
      writeFileSync(path.join(tlsDir, 'privkey.pem'), 'not a key\n');
    }
    if (certState === 'unreadable') chmodSync(path.join(tlsDir, 'privkey.pem'), 0o000);
  }

  const argsFile = path.join(dir, 'args');
  writeFileSync(
    path.join(binDir, 'turnserver'),
    `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > ${argsFile}\n`,
  );
  chmodSync(path.join(binDir, 'turnserver'), 0o755);

  const script = `${gate.replace(/\/etc\/coturn\/tls/g, tlsDir)}\nexec turnserver "$@"\n`;
  const run = spawnSync('/bin/sh', ['-ec', script, 'turnserver', '--listening-port=3478'], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  expect(run.status, `gate script failed: ${run.stderr}`).toBe(0);

  return { args: readFileSync(argsFile, 'utf8').split('\n').filter(Boolean), stderr: run.stderr };
}

describe('coturn TLS gate — executed, not just pattern-matched', () => {
  it('passes the original flags through untouched and adds nothing when there is no certificate', () => {
    const { args, stderr } = runGate('none');
    expect(args).toEqual(['--listening-port=3478']);
    expect(stderr).toMatch(/TURNS \(5349\) is disabled/);
  });

  it('appends --cert/--pkey AFTER the original flags when the pair is readable', () => {
    const { args, stderr } = runGate('readable');
    expect(args).toEqual([
      '--listening-port=3478',
      expect.stringContaining('--cert='),
      expect.stringContaining('--pkey='),
    ]);
    expect(stderr).toContain('TLS certificate found');
    expect(stderr).not.toMatch(/EXPIRED/);
  });

  it('stays disabled when the key exists but is unreadable (the nobody-vs-root trap)', () => {
    // Running as root defeats the point: root can read a 0000 file.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const { args, stderr } = runGate('unreadable');
    expect(args).toEqual(['--listening-port=3478']);
    expect(stderr).toMatch(/TURNS \(5349\) is disabled/);
  });

  it('still enables TLS on an expired/unparseable certificate but says so loudly', () => {
    const { args, stderr } = runGate('expired');
    expect(args).toHaveLength(3);
    expect(stderr).toMatch(/WARNING — .*EXPIRED/);
  });
});
