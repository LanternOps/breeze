import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const IMAGE_DIGEST = `example.invalid/breeze@sha256:${'0'.repeat(64)}`;

function renderApiEnvironment(appPassword: string): Record<string, string> {
  const rendered = execFileSync(
    'docker',
    [
      'compose',
      '--project-directory',
      REPOSITORY_ROOT,
      '-f',
      path.join(REPOSITORY_ROOT, 'docker-compose.yml'),
      'config',
      '--format',
      'json',
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_ENROLLMENT_SECRET: 'compose-agent-enrollment-secret',
        APP_ENCRYPTION_KEY: 'compose-app-encryption-key',
        BREEZE_API_IMAGE_REF: IMAGE_DIGEST,
        BREEZE_APP_DB_PASSWORD: appPassword,
        BREEZE_BINARIES_IMAGE_REF: IMAGE_DIGEST,
        BREEZE_DOMAIN: 'breeze.example.test',
        BREEZE_PORTAL_IMAGE_REF: IMAGE_DIGEST,
        BREEZE_VERSION: 'test-version',
        BREEZE_WEB_IMAGE_REF: IMAGE_DIGEST,
        CADDY_IMAGE_REF: IMAGE_DIGEST,
        COTURN_IMAGE_REF: IMAGE_DIGEST,
        ENROLLMENT_KEY_PEPPER: 'compose-enrollment-key-pepper',
        JWT_SECRET: 'compose-jwt-secret',
        MFA_ENCRYPTION_KEY: 'compose-mfa-encryption-key',
        MFA_RECOVERY_CODE_PEPPER: 'compose-mfa-recovery-code-pepper',
        POSTGRES_IMAGE_REF: IMAGE_DIGEST,
        POSTGRES_PASSWORD: 'compose-postgres-password',
        REDIS_IMAGE_REF: IMAGE_DIGEST,
        TURN_SECRET: 'compose-turn-secret',
      },
    },
  );
  const config = JSON.parse(rendered) as {
    services: { api: { environment: Record<string, string> } };
  };
  return config.services.api.environment;
}

describe('standard Compose request database configuration', () => {
  it('derives the request URL from POSTGRES_PASSWORD by default', () => {
    const environment = renderApiEnvironment('');

    expect(Object.hasOwn(environment, 'DATABASE_URL_APP')).toBe(false);
    expect(environment.POSTGRES_PASSWORD === 'compose-postgres-password').toBe(true);
  });

  it('derives the request URL from BREEZE_APP_DB_PASSWORD when overridden', () => {
    const environment = renderApiEnvironment('compose-app-role-password');

    expect(Object.hasOwn(environment, 'DATABASE_URL_APP')).toBe(false);
    expect(environment.BREEZE_APP_DB_PASSWORD === 'compose-app-role-password').toBe(true);
    expect(environment.POSTGRES_PASSWORD === 'compose-postgres-password').toBe(true);
  });
});
