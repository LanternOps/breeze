import { describe, expect, it } from 'vitest';
import {
  deriveAppConnectionString,
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
});
