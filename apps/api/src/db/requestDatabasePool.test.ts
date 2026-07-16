import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { postgresFactory, requestClient } = vi.hoisted(() => {
  const requestClient = Object.assign(vi.fn(), {
    options: { parsers: {}, serializers: {} },
  });
  return { postgresFactory: vi.fn(() => requestClient), requestClient };
});

vi.mock('postgres', () => ({ default: postgresFactory }));
const originalEnv = { ...process.env };

describe('exported request database pool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://admin:admin-secret@database.example.test:5432/breeze';
    delete process.env.DATABASE_URL_APP;
    process.env.BREEZE_APP_DB_PASSWORD = 'request-secret';
    delete process.env.POSTGRES_PASSWORD;
  });
  afterEach(() => { process.env = { ...originalEnv }; });

  it('constructs the exported pool with the canonical derived request URL', async () => {
    await import('./index');
    expect(postgresFactory).toHaveBeenCalledWith(
      'postgresql://breeze_app:request-secret@database.example.test:5432/breeze',
      expect.objectContaining({ max: 30 }),
    );
  }, 15_000);

  it('returns a fixed secret-free error when the exact request-pool probe fails', async () => {
    requestClient.mockRejectedValue(new Error(
      'connect ECONNREFUSED postgresql://request-user:request-password@database.example.test:5432/breeze',
    ));
    const { getRequestDatabaseRole } = await import('./index');
    let message = '';
    try { await getRequestDatabaseRole(); } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('[database] Could not query the effective request database role.');
    expect(message).not.toMatch(/request-user|request-password|database\.example\.test|postgresql:\/\//u);
  });

  it('fails closed when pg_roles returns no row for current_user', async () => {
    requestClient.mockResolvedValueOnce([]);
    const { getRequestDatabaseRole } = await import('./index');
    await expect(getRequestDatabaseRole()).rejects.toThrow(/pg_roles returned no row for current_user/i);
  });
});
