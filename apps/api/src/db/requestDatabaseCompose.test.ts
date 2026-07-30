import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const IMAGE_DIGEST = `example.invalid/breeze@sha256:${'0'.repeat(64)}`;

// Every test here spawns `docker compose config`. The FIRST spawn on a cold
// CI runner also bootstraps the compose plugin, which has been observed at
// 5.3s — over vitest's 5s default timeout — while warm invocations take
// ~130ms (flaked on PR #2943's run; the assertions were never wrong, the
// subprocess was slow). Warm the plugin once, and give the docker-spawning
// tests an explicit budget so runner load can't fail a correct contract.
const DOCKER_SPAWN_TIMEOUT_MS = 60_000;

beforeAll(() => {
  execFileSync('docker', ['compose', 'version'], { cwd: REPOSITORY_ROOT, encoding: 'utf8' });
}, DOCKER_SPAWN_TIMEOUT_MS);

function renderApiEnvironment(overrides: Record<string, string>): Record<string, string> {
  const rendered = execFileSync('docker', [
    'compose', '--project-directory', REPOSITORY_ROOT,
    '-f', path.join(REPOSITORY_ROOT, 'docker-compose.yml'),
    'config', '--format', 'json',
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_ENROLLMENT_SECRET: 'compose-agent-enrollment-secret',
      APP_ENCRYPTION_KEY: 'compose-app-encryption-key',
      BREEZE_API_IMAGE_REF: IMAGE_DIGEST,
      BREEZE_BINARIES_IMAGE_REF: IMAGE_DIGEST,
      BREEZE_DOMAIN: 'breeze.example.test',
      BREEZE_PORTAL_IMAGE_REF: IMAGE_DIGEST,
      BREEZE_VERSION: 'test-version',
      BREEZE_WEB_IMAGE_REF: IMAGE_DIGEST,
      CADDY_IMAGE_REF: IMAGE_DIGEST,
      COTURN_IMAGE_REF: IMAGE_DIGEST,
      ENROLLMENT_KEY_PEPPER: 'compose-enrollment-key-pepper',
      // The event-socket permission epoch mode is required-with-no-default
      // (`${VAR:?}`) in docker-compose.yml, so `config` cannot render without
      // it. Value mirrors .env.example.
      EVENT_PERMISSION_EPOCH_MODE: 'compat',
      JWT_SECRET: 'compose-jwt-secret',
      MFA_ENCRYPTION_KEY: 'compose-mfa-encryption-key',
      MFA_RECOVERY_CODE_PEPPER: 'compose-mfa-recovery-code-pepper',
      PARTNER_API_CURSOR_SIGNING_KEY: 'compose-partner-api-cursor-signing-key',
      POSTGRES_IMAGE_REF: IMAGE_DIGEST,
      POSTGRES_PASSWORD: 'compose-postgres-password',
      REDIS_IMAGE_REF: IMAGE_DIGEST,
      // Remote-access admission/lease configuration is required-with-no-default
      // (`${VAR:?}`) in docker-compose.yml, so `config` cannot render without
      // it. Values mirror .env.example.
      REMOTE_ACCESS_ADMISSION_MODE: 'open',
      REMOTE_WS_AUTH_MODE: 'post_upgrade',
      REMOTE_WS_REDIS_TOPOLOGY: 'standalone-single-primary',
      TURN_SECRET: 'compose-turn-secret',
      ...overrides,
    },
  });
  return (JSON.parse(rendered) as { services: { api: { environment: Record<string, string> } } })
    .services.api.environment;
}

describe('standard Compose request database configuration', () => {
  // When DATABASE_URL_APP is unset, compose maps it to an empty string. The
  // resolver treats a blank value as "not set" (resolveRequestDatabaseConfig
  // trims and checks truthiness) and derives the breeze_app URL from the
  // effective role password, so the empty mapping must not shadow derivation.
  it.each([
    ['', 'compose-postgres-password'],
    ['compose-app-role-password', 'compose-app-role-password'],
  ])('maps DATABASE_URL_APP as blank and derives with the effective role password %s', (appPassword, expected) => {
    const environment = renderApiEnvironment({ BREEZE_APP_DB_PASSWORD: appPassword });
    expect(environment.DATABASE_URL_APP).toBe('');
    expect(environment.BREEZE_APP_DB_PASSWORD || environment.POSTGRES_PASSWORD).toBe(expected);
  }, DOCKER_SPAWN_TIMEOUT_MS);

  it('passes an explicit DATABASE_URL_APP through to the api service', () => {
    // The reason this mapping exists: a value set in .env must reach the api
    // service, or multi-host/HA operators (whose URL cannot be derived) have no
    // way to point the request pool at an explicit role.
    const explicit = 'postgresql://breeze_app:secret@h1:5432,h2:5432/breeze';
    const environment = renderApiEnvironment({ DATABASE_URL_APP: explicit });
    expect(environment.DATABASE_URL_APP).toBe(explicit);
  }, DOCKER_SPAWN_TIMEOUT_MS);
});
