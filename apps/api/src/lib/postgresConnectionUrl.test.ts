import { describe, expect, it } from 'vitest';
import { canonicalizeSingleEndpointPostgresUrl } from './postgresConnectionUrl';

const GENERIC_ERROR = 'The PostgreSQL connection URL is invalid.';

describe('canonicalizeSingleEndpointPostgresUrl', () => {
  it('canonicalizes one endpoint while preserving encoded credentials, path, and query', () => {
    expect(
      canonicalizeSingleEndpointPostgresUrl(
        'POSTGRESQL://db-user:p%40ss@localhost:55432/breeze%20test?application_name=breeze%20api&sslmode=require',
        GENERIC_ERROR,
      ),
    ).toBe(
      'postgresql://db-user:p%40ss@localhost:55432/breeze%20test?application_name=breeze%20api&sslmode=require',
    );
  });

  it.each([
    'mysql://db-user:db-password@localhost:55432/breeze',
    'postgresql:///breeze',
    'postgresql://db-user:db-password@localhost:55432/breeze#',
    'postgresql://db-user:db-password@localhost:55432/breeze#primary%2Cunsafe',
    'postgresql://db-user:db-password@primary@localhost:55432/breeze',
    'postgresql://db-user:db-password@primary,unsafe/breeze',
    'postgresql://db-user:db-password@primary%2Cunsafe/breeze',
    'postgresql://db-user:db-password@primary%252Cunsafe/breeze',
    'postgresql://db-user:db-password@primary%ZZunsafe/breeze',
    'postgresql://db%ZZuser:db-password@localhost:55432/breeze',
    'postgresql://db-user:db%ZZpassword@localhost:55432/breeze',
  ])('rejects unsafe or malformed input with only the generic message: %s', (url) => {
    expect(() =>
      canonicalizeSingleEndpointPostgresUrl(url, GENERIC_ERROR),
    ).toThrowError(GENERIC_ERROR);

    try {
      canonicalizeSingleEndpointPostgresUrl(url, GENERIC_ERROR);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe(GENERIC_ERROR);
      for (const inputPart of [
        'db-user',
        'db-password',
        'localhost',
        'primary',
        'unsafe',
        'primary%ZZunsafe',
      ]) {
        expect(message).not.toContain(inputPart);
      }
    }
  });
});
