import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { backupConfigs } from './backup';
import { decryptSecret, isEncryptedSecret } from '../../services/secretCrypto';

/**
 * backup_configs.provider_config holds destination credentials. The column
 * seals them on write and opens them on read, so the at-rest guarantee holds
 * for every Drizzle reader and writer without each one doing it by hand.
 */

const column = backupConfigs.providerConfig;

const S3 = {
  bucket: 'acme-backups',
  region: 'us-east-1',
  endpoint: 'https://s3.example.com',
  accessKey: 'AKIAEXAMPLEACCESS',
  secretKey: 'plain-s3-secret-key',
};

function toStored(value: unknown): Record<string, unknown> {
  const driverValue = column.mapToDriverValue(value);
  return (typeof driverValue === 'string' ? JSON.parse(driverValue) : driverValue) as Record<string, unknown>;
}

describe('backup_configs.provider_config column', () => {
  it('is stored as jsonb', () => {
    expect(column.getSQLType()).toBe('jsonb');
  });

  it('writes ciphertext for the credentials and plaintext for the destination', () => {
    const stored = toStored(S3);
    expect(isEncryptedSecret(stored.secretKey as string)).toBe(true);
    expect(isEncryptedSecret(stored.accessKey as string)).toBe(true);
    expect(decryptSecret(stored.secretKey as string, { aad: 'backup_configs.provider_config' })).toBe(S3.secretKey);
    expect(stored.bucket).toBe(S3.bucket);
    expect(stored.endpoint).toBe(S3.endpoint);
    expect(JSON.stringify(stored)).not.toContain('plain-');
  });

  it('reads back the plaintext config every reader expects', () => {
    const driverValue = column.mapToDriverValue(S3);
    expect(column.mapFromDriverValue(driverValue as never)).toEqual(S3);
    // postgres.js may also hand the decoder an already-parsed object.
    expect(column.mapFromDriverValue(JSON.parse(driverValue as string) as never)).toEqual(S3);
  });

  it('still reads a row stored before sealing (plaintext) unchanged', () => {
    expect(column.mapFromDriverValue(JSON.stringify(S3) as never)).toEqual(S3);
    expect(column.mapFromDriverValue(S3 as never)).toEqual(S3);
  });
});

// ---------------------------------------------------------------------------
// Guard: the sealed column is the only way provider_config is read or written.
// Raw SQL against provider_config would bypass the column's seal/open, so any
// reference outside the files that own the at-rest format fails here.
// ---------------------------------------------------------------------------

const API_SRC = join(__dirname, '..', '..');

const PROVIDER_CONFIG_SQL_OWNERS = new Set([
  'db/schema/backup.ts',
  'services/backupProviderConfigSealing.ts',
  'services/backupProviderConfigBackfill.ts',
  // Column classification only (provider_config is excludedOpen).
  'services/tenantExportPolicyRegistry.ts',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n');
}

describe('provider_config access guard', () => {
  const files = sourceFiles(API_SRC).map((file) => ({
    path: relative(API_SRC, file).split('\\').join('/'),
    code: codeOnly(readFileSync(file, 'utf8')),
  }));

  it('scans the API source tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.path === 'routes/backup/configs.ts')).toBe(true);
  });

  it('keeps the column on the sealed type, not plain jsonb', () => {
    const schema = files.find((f) => f.path === 'db/schema/backup.ts')!;
    expect(schema.code).not.toMatch(/jsonb\(\s*['"]provider_config['"]\s*\)/);
  });

  it('has no raw SQL naming provider_config outside the files that own its stored format', () => {
    const offenders = files
      .filter((f) => !PROVIDER_CONFIG_SQL_OWNERS.has(f.path))
      .filter((f) => /\bprovider_config\b/.test(f.code)
        // ai_connections.provider_config is a different, unrelated column.
        && !/^db\/schema\/aiModelRegistry\.ts$/.test(f.path))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('never interpolates the column into a sql`` template (that bypasses the seal/open)', () => {
    const offenders = files
      .filter((f) => /\$\{\s*backupConfigs\.providerConfig\s*\}/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
