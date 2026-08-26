import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureAppRole } from './ensureAppRole';

// ensureAppRole() returns `false` and skips all DDL *before* opening a
// Postgres connection when neither password env var is set — see
// ensureAppRole.ts:23-28. That early-return means this test needs no
// database and no mocking of the `postgres` client: it only has to control
// the two env vars ensureAppRole() reads.
describe('ensureAppRole', () => {
  let originalBreezeAppDbPassword: string | undefined;
  let originalPostgresPassword: string | undefined;

  beforeEach(() => {
    originalBreezeAppDbPassword = process.env.BREEZE_APP_DB_PASSWORD;
    originalPostgresPassword = process.env.POSTGRES_PASSWORD;
    delete process.env.BREEZE_APP_DB_PASSWORD;
    delete process.env.POSTGRES_PASSWORD;
  });

  afterEach(() => {
    if (originalBreezeAppDbPassword === undefined) {
      delete process.env.BREEZE_APP_DB_PASSWORD;
    } else {
      process.env.BREEZE_APP_DB_PASSWORD = originalBreezeAppDbPassword;
    }
    if (originalPostgresPassword === undefined) {
      delete process.env.POSTGRES_PASSWORD;
    } else {
      process.env.POSTGRES_PASSWORD = originalPostgresPassword;
    }
    vi.restoreAllMocks();
  });

  it('returns false and warns, without attempting a database connection, when neither password env var is set (#4048)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureAppRole()).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Neither BREEZE_APP_DB_PASSWORD nor POSTGRES_PASSWORD is set',
      ),
    );
  });
});
