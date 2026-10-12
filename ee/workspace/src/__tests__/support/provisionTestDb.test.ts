import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProvisionedUrls,
  listWorkspaceMigrationFiles,
  makeProvisionedDbName,
  provisionTestDb,
  resolveProvisionServer,
} from './provisionTestDb';

// Mirrors apps/api/src/testUtils/integrationDatabaseSafety.ts's name rule
// (used by the API integration setup), so a provisioned DB stays within it.
const API_SAFE_NAME = /^breeze_test(_[a-z0-9]+)?$/u;

describe('makeProvisionedDbName', () => {
  it('is accepted by the API test-DB safety guard', () => {
    expect(makeProvisionedDbName()).toMatch(API_SAFE_NAME);
  });
  it('is unique per call', () => {
    const names = new Set(Array.from({ length: 50 }, () => makeProvisionedDbName()));
    expect(names.size).toBe(50);
  });
  it('stays under the 63-byte Postgres identifier limit', () => {
    expect(makeProvisionedDbName().length).toBeLessThanOrEqual(63);
  });
});

describe('resolveProvisionServer', () => {
  it('defaults to the local :5433 test stack', () => {
    const s = resolveProvisionServer({});
    expect(s.adminUrl).toBe('postgresql://breeze_test:breeze_test@localhost:5433/breeze_test');
    expect(s.appUser).toBe('breeze_app');
    expect(s.appPassword).toBe('breeze_test');
  });
  it('honours an explicit server override and app password', () => {
    const s = resolveProvisionServer({
      WORKSPACE_IT_PG_ADMIN_URL: 'postgresql://u:p@127.0.0.1:6000/breeze_test',
      BREEZE_APP_DB_PASSWORD: 'pw',
    });
    expect(s.adminUrl).toBe('postgresql://u:p@127.0.0.1:6000/breeze_test');
    expect(s.appPassword).toBe('pw');
  });
});

describe('provisionTestDb safety', () => {
  it('refuses to run against the default :5432 port', async () => {
    await expect(
      provisionTestDb({ WORKSPACE_IT_PG_ADMIN_URL: 'postgresql://u:p@localhost:5432/breeze_test' }),
    ).rejects.toThrow(/refusing to provision on :5432/);
  });
});

describe('buildProvisionedUrls', () => {
  it('points admin and app URLs at the new DB on the same server', () => {
    const server = resolveProvisionServer({
      WORKSPACE_IT_PG_ADMIN_URL: 'postgresql://breeze_test:breeze_test@localhost:32843/breeze_test',
    });
    const urls = buildProvisionedUrls(server, 'breeze_test_ws1a2b');
    expect(urls.databaseUrl).toBe('postgresql://breeze_test:breeze_test@localhost:32843/breeze_test_ws1a2b');
    expect(urls.databaseUrlApp).toBe('postgresql://breeze_app:breeze_test@localhost:32843/breeze_test_ws1a2b');
  });
});

describe('listWorkspaceMigrationFiles', () => {
  it('returns only .sql files in lexical (apply) order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsmig-'));
    for (const f of ['2026-07-12-b.sql', '2026-07-10-a.sql', 'README.md', '2026-08-01-c.sql']) {
      writeFileSync(join(dir, f), '-- x');
    }
    expect(listWorkspaceMigrationFiles(dir).map((f) => f.filename)).toEqual([
      '2026-07-10-a.sql', '2026-07-12-b.sql', '2026-08-01-c.sql',
    ]);
  });
  it('lists the real workspace migrations', () => {
    expect(listWorkspaceMigrationFiles().length).toBeGreaterThan(0);
  });
});
