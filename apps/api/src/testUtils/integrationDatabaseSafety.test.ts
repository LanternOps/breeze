import { describe, expect, it, vi } from 'vitest';
import { assertTestDatabaseUrlSafe } from './integrationDatabaseSafety';

const SAFE_URL =
  'postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test';

describe('assertTestDatabaseUrlSafe', () => {
  it('accepts an explicitly test-mode local database on a non-default port', () => {
    expect(() =>
      assertTestDatabaseUrlSafe(SAFE_URL, 'setup', { nodeEnv: 'test' }),
    ).not.toThrow();
  });

  it('accepts an exact BREEZE_TEST_DB_URL opt-in outside test mode', () => {
    expect(() =>
      assertTestDatabaseUrlSafe(SAFE_URL, 'setup', {
        nodeEnv: 'development',
        breezeTestDbUrl: SAFE_URL,
      }),
    ).not.toThrow();
  });

  it.each([
    ['an unparseable URL', 'not a database url'],
    [
      'a production-like database name',
      'postgresql://production-user:production-password@127.0.0.1:55432/breeze',
    ],
    [
      'a remote host',
      'postgresql://production-user:production-password@production-db.example.com:55432/breeze_test',
    ],
    [
      'the default PostgreSQL port',
      'postgresql://production-user:production-password@127.0.0.1:5432/breeze_test',
    ],
  ])('refuses %s before the client or DDL path', (_description, connectionUrl) => {
    const clientAndDdlPath = vi.fn();

    expect(() => {
      assertTestDatabaseUrlSafe(connectionUrl, 'request database role setup', {
        nodeEnv: 'test',
      });
      clientAndDdlPath();
    }).toThrow(/Integration test request database role setup refused/i);

    expect(clientAndDdlPath).not.toHaveBeenCalled();
  });

  it('requires NODE_ENV=test or an exact explicit URL opt-in', () => {
    expect(() =>
      assertTestDatabaseUrlSafe(SAFE_URL, 'setup', {
        nodeEnv: 'development',
        breezeTestDbUrl:
          'postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test_other',
      }),
    ).toThrow(/operator opt-in/i);
  });

  it('does not include credentials or the supplied URL in refusal errors', () => {
    const username = 'production-user';
    const password = 'production-password';
    const connectionUrl =
      `postgresql://${username}:${password}@production-db.example.com:5432/production`;

    let caught: unknown;
    try {
      assertTestDatabaseUrlSafe(connectionUrl, 'setup', { nodeEnv: 'test' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toMatch(/Integration test setup refused/i);
    expect(message).not.toContain(connectionUrl);
    expect(message).not.toContain(username);
    expect(message).not.toContain(password);
  });
});
