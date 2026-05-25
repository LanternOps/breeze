import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';

const mockState = vi.hoisted(() => ({
  /** Per-table mocked rows. Default: 0 rows. */
  rowsByTable: new Map<string, unknown[]>(),
  /** Tables that should throw 42P01 (table doesn't exist). */
  missingTables: new Set<string>(),
}));

function sqlToText(q: unknown): string {
  // Drizzle's sql template stringifies as `[object Object]`. We
  // recursively walk `queryChunks` to materialise the raw text fragments
  // so test mocks can match on table names emitted via `sql.raw(...)`.
  if (q && typeof q === 'object' && 'queryChunks' in q) {
    const chunks = (q as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((c) => {
        if (c && typeof c === 'object') {
          if ('value' in c && Array.isArray((c as { value: unknown[] }).value)) {
            return ((c as { value: string[] }).value).join('');
          }
          if ('queryChunks' in c) {
            return sqlToText(c);
          }
        }
        return '';
      })
      .join(' ');
  }
  return String(q);
}

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn(<T,>(fn: () => Promise<T>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    execute: vi.fn((q: unknown) => {
      const text = sqlToText(q);
      // Match `FROM "table"` (preferred — emitted by quoteIdent) or
      // `FROM table` (raw, for the organizations branch).
      const match = text.match(/FROM\s+"?([a-z_][a-z0-9_]*)"?/i);
      const table: string = match && match[1] ? match[1] : '';
      if (mockState.missingTables.has(table)) {
        const err: any = new Error(`relation "${table}" does not exist`);
        err.code = '42P01';
        return Promise.reject(err);
      }
      return Promise.resolve(mockState.rowsByTable.get(table) ?? []);
    }),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
  },
}));

import { buildOrgExportZip } from './tenantExport';
import { ORG_CASCADE_DELETE_ORDER } from './tenantCascade';

describe('buildOrgExportZip', () => {
  beforeEach(() => {
    mockState.rowsByTable = new Map();
    mockState.missingTables = new Set();
  });

  it('returns a valid ZIP containing one file per cascade table plus manifest.json', async () => {
    const { zipBuffer, manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
      'admin@example.com',
    );

    expect(zipBuffer).toBeInstanceOf(Buffer);
    expect(zipBuffer.length).toBeGreaterThan(0);

    const zip = await JSZip.loadAsync(zipBuffer);
    const fileNames = Object.keys(zip.files);
    expect(fileNames).toContain('manifest.json');
    // Every cascade table that didn't throw should be present.
    for (const table of ORG_CASCADE_DELETE_ORDER) {
      expect(fileNames).toContain(`${table}.json`);
    }
    expect(manifest.actor).toBe('00000000-0000-0000-0000-000000000002');
    expect(manifest.actorEmail).toBe('admin@example.com');
    expect(manifest.orgId).toBe('00000000-0000-0000-0000-000000000001');
    expect(manifest.files.length).toBe(ORG_CASCADE_DELETE_ORDER.length);
  });

  it('manifest sha256 matches the file body contents', async () => {
    mockState.rowsByTable.set('devices', [
      { id: 'd1', name: 'host-1', org_id: '00000000-0000-0000-0000-000000000001' },
    ]);
    const { zipBuffer, manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );

    const zip = await JSZip.loadAsync(zipBuffer);
    const devicesEntry = manifest.files.find((f) => f.name === 'devices.json');
    expect(devicesEntry).toBeDefined();
    expect(devicesEntry?.rowCount).toBe(1);

    const devicesContent = await zip.files['devices.json']!.async('string');
    const { createHash } = await import('node:crypto');
    const actualHash = createHash('sha256').update(devicesContent).digest('hex');
    expect(devicesEntry?.sha256).toBe(actualHash);
  });

  it('skips tables that do not exist in this deployment (42P01)', async () => {
    mockState.missingTables.add('plugins');
    const { manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    const fileNames = manifest.files.map((f) => f.name);
    expect(fileNames).not.toContain('plugins.json');
    // Other tables still present.
    expect(fileNames).toContain('devices.json');
  });

  it('manifest counts rows from per-table query results', async () => {
    mockState.rowsByTable.set('alerts', [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]);
    mockState.rowsByTable.set('devices', [{ id: 'd1' }]);
    const { manifest } = await buildOrgExportZip(
      '00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002',
    );
    expect(manifest.files.find((f) => f.name === 'alerts.json')?.rowCount).toBe(3);
    expect(manifest.files.find((f) => f.name === 'devices.json')?.rowCount).toBe(1);
    // Tables we didn't populate are present with rowCount 0.
    expect(manifest.files.find((f) => f.name === 'users.json')?.rowCount).toBe(0);
  });
});
