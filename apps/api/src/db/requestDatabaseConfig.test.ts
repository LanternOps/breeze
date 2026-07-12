import { describe, expect, it, vi } from 'vitest';
import {
  deriveAppConnectionString,
  logRequestDatabaseConfigSource,
  resolveRequestDatabaseConfig,
} from './requestDatabaseConfig';

describe('requestDatabaseConfig', () => {
  describe('deriveAppConnectionString', () => {
    it('derives the breeze_app URL from the admin URL and app password', () => {
      expect(
        deriveAppConnectionString(
          'postgresql://admin:admin-secret@db:5432/breeze',
          'request-secret',
        ),
      ).toBe('postgresql://breeze_app:request-secret@db:5432/breeze');
    });

    it('preserves query parameters, host, port, database, and scheme', () => {
      expect(
        deriveAppConnectionString(
          'postgres://admin:admin-secret@request-db:6432/production?sslmode=require',
          'request-secret',
        ),
      ).toBe(
        'postgres://breeze_app:request-secret@request-db:6432/production?sslmode=require',
      );
    });

    it('URL-encodes special characters in the password', () => {
      const result = deriveAppConnectionString(
        'postgresql://admin:admin-secret@db:5432/breeze',
        'p@ss/word:with spaces',
      );

      expect(result).not.toBeNull();
      const parsed = new URL(result!);
      expect(parsed.username).toBe('breeze_app');
      expect(decodeURIComponent(parsed.password)).toBe('p@ss/word:with spaces');
    });

    it('returns null without a password', () => {
      expect(
        deriveAppConnectionString('postgresql://admin:admin-secret@db:5432/breeze', undefined),
      ).toBeNull();
      expect(
        deriveAppConnectionString('postgresql://admin:admin-secret@db:5432/breeze', ''),
      ).toBeNull();
    });

    it('returns null for a malformed admin URL', () => {
      expect(deriveAppConnectionString('not a url', 'request-secret')).toBeNull();
    });
  });

  describe('resolveRequestDatabaseConfig', () => {
    it('derives the request URL using BREEZE_APP_DB_PASSWORD', () => {
      expect(
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        }).url,
      ).toBe('postgresql://breeze_app:request-secret@db:5432/breeze');
    });

    it('prefers an explicit request URL', () => {
      expect(
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
          DATABASE_URL_APP:
            'postgresql://explicit:explicit-secret@request-db:6432/breeze?sslmode=require',
          BREEZE_APP_DB_PASSWORD: 'ignored',
        }),
      ).toEqual({
        url: 'postgresql://explicit:explicit-secret@request-db:6432/breeze?sslmode=require',
        source: 'explicit',
      });
    });

    it('rejects a malformed explicit request URL without leaking credentials', () => {
      const username = 'request-url-user';
      const password = 'request-url-password';

      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP:
            `postgresql://${username}:${password}@request-db:not-a-port/breeze`,
        }),
      ).toThrowError(
        expect.objectContaining({
          message: expect.not.stringContaining(username),
        }),
      );

      try {
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP:
            `postgresql://${username}:${password}@request-db:not-a-port/breeze`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/DATABASE_URL_APP.*valid.*single database\/HA endpoint/i);
        expect(message).not.toContain(username);
        expect(message).not.toContain(password);
        expect(message).not.toContain('request-db:not-a-port');
      }
    });

    it.each([
      'postgresql://request-user:request-password@db-one,db-two/breeze',
      'postgresql://request-user:request-password@db-one:5432,db-two:5432/breeze',
    ])('rejects an explicit multi-host request URL without leaking credentials: %s', (url) => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP: url,
        }),
      ).toThrow(/DATABASE_URL_APP.*single database\/HA endpoint/i);

      try {
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP: url,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('request-user');
        expect(message).not.toContain('request-password');
        expect(message).not.toContain('db-one');
        expect(message).not.toContain('db-two');
      }
    });

    it.each([
      'postgresql://request-user:request-password@db-one%2Cdb-two/breeze',
      'postgresql://request-user:request-password@db-one%2cdb-two%3A6432/breeze',
    ])('rejects an explicit encoded multi-host request URL without leaking credentials: %s', (url) => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP: url,
        }),
      ).toThrow(/DATABASE_URL_APP.*single database\/HA endpoint/i);

      try {
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL_APP: url,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('request-user');
        expect(message).not.toContain('request-password');
        expect(message).not.toContain('db-one');
        expect(message).not.toContain('db-two');
      }
    });

    it('derives the request URL using POSTGRES_PASSWORD', () => {
      expect(
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
          POSTGRES_PASSWORD: 'postgres-secret',
        }),
      ).toEqual({
        url: 'postgresql://breeze_app:postgres-secret@db:5432/breeze',
        source: 'derived',
      });
    });

    it('prefers BREEZE_APP_DB_PASSWORD when both app password sources are present', () => {
      expect(
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
          BREEZE_APP_DB_PASSWORD: 'app-specific-secret',
          POSTGRES_PASSWORD: 'shared-postgres-secret',
        }),
      ).toEqual({
        url: 'postgresql://breeze_app:app-specific-secret@db:5432/breeze',
        source: 'derived',
      });
    });

    it.each([
      'postgresql://admin:admin-secret@db-one,db-two/breeze',
      'postgresql://admin:admin-secret@db-one:5432,db-two:5432/breeze',
    ])('rejects a derived multi-host request URL without leaking credentials: %s', (url) => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: url,
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        }),
      ).toThrow(/single database\/HA endpoint/i);

      try {
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: url,
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('admin');
        expect(message).not.toContain('admin-secret');
        expect(message).not.toContain('request-secret');
        expect(message).not.toContain('db-one');
        expect(message).not.toContain('db-two');
      }
    });

    it.each([
      'postgresql://admin:admin-secret@db-one%2Cdb-two/breeze',
      'postgresql://admin:admin-secret@db-one%2cdb-two:5432/breeze',
    ])('rejects a derived encoded multi-host request URL without leaking credentials: %s', (url) => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: url,
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        }),
      ).toThrow(/DATABASE_URL.*single database\/HA endpoint/i);

      try {
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: url,
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain('admin');
        expect(message).not.toContain('admin-secret');
        expect(message).not.toContain('request-secret');
        expect(message).not.toContain('db-one');
        expect(message).not.toContain('db-two');
      }
    });

    it('refuses a production request pool without an unprivileged URL or password', () => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
        }),
      ).toThrow(/DATABASE_URL_APP.*BREEZE_APP_DB_PASSWORD.*POSTGRES_PASSWORD/);
    });

    it('refuses a production request pool when DATABASE_URL is malformed', () => {
      expect(() =>
        resolveRequestDatabaseConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'not a url',
          BREEZE_APP_DB_PASSWORD: 'request-secret',
        }),
      ).toThrow(/DATABASE_URL_APP.*BREEZE_APP_DB_PASSWORD.*POSTGRES_PASSWORD/);
    });

    it('returns the warned non-production compatibility fallback', () => {
      expect(
        resolveRequestDatabaseConfig({
          NODE_ENV: 'development',
          DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
        }),
      ).toEqual({
        url: 'postgresql://admin:admin-secret@db:5432/breeze',
        source: 'development-fallback',
      });
    });
  });

  describe('logRequestDatabaseConfigSource', () => {
    it('warns for the non-production fallback using only its source label', () => {
      const logger = { log: vi.fn(), warn: vi.fn() };
      const url = 'postgresql://fallback-user:fallback-password@fallback-db:5432/breeze';

      logRequestDatabaseConfigSource(
        { url, source: 'development-fallback' },
        logger,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        '[database] Request pool configuration source: development-fallback',
      );
      expect(logger.log).not.toHaveBeenCalled();
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).not.toContain(url);
      expect(logged).not.toContain('fallback-user');
      expect(logged).not.toContain('fallback-password');
    });
  });
});
