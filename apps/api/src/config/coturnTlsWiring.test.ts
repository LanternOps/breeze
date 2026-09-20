import { readFileSync } from 'node:fs';
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
const COMPOSE_FILES = ['docker-compose.yml', 'deploy/docker-compose.prod.yml'];

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
