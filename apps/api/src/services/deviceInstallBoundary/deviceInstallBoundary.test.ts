/**
 * #8318 wave 1a — static contracts of the install incarnation boundary. The
 * live-schema contract (every FK to devices classified) and the all-category
 * proof run against Postgres in
 * __tests__/integration/installBoundaryContract.integration.test.ts and
 * installBoundary.integration.test.ts.
 */
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { devices } from '../../db/schema';
import {
  BOUNDARY_HANDLER_IDS,
  INSTALL_BOUNDARY_HANDLERS,
  runInstallIncarnationBoundary,
} from './index';
import { INSTALL_BOUNDARY_RESET_COLUMNS } from './handlers/deviceRow';
import {
  classifiedTablesByHandler,
  FK_LESS_DEVICE_REFERENCES,
  INSTALL_BOUNDARY_CLASSIFICATION,
} from './classification';

describe('install boundary handlers', () => {
  it('runs every handler once, the device row first and the commands second', () => {
    const ids = INSTALL_BOUNDARY_HANDLERS.map((h) => h.id);
    expect([...ids].sort()).toEqual([...BOUNDARY_HANDLER_IDS].sort());
    expect(ids[0]).toBe('device_row');
    expect(ids[1]).toBe('commands');
  });

  it('every table a handler lists is classified as handled by it, and vice versa', () => {
    const byManifest = classifiedTablesByHandler();
    for (const handler of INSTALL_BOUNDARY_HANDLERS) {
      expect([...handler.tables].sort(), handler.id).toEqual([...(byManifest.get(handler.id) ?? [])].sort());
    }
    const known = new Set<string>([...BOUNDARY_HANDLER_IDS, 'rebind_confirm']);
    for (const handlerId of byManifest.keys()) expect(known.has(handlerId), handlerId).toBe(true);
  });

  it('every FK-less reference names a classified table', () => {
    for (const ref of FK_LESS_DEVICE_REFERENCES) {
      expect(INSTALL_BOUNDARY_CLASSIFICATION[ref.table], ref.table).toBeDefined();
    }
  });

  it('refuses to run outside a system DB context', async () => {
    await expect(
      runInstallIncarnationBoundary({ deviceId: '00000000-0000-0000-0000-000000000001', expectedIncarnation: 1, actorUserId: null }),
    ).rejects.toThrow(/withSystemDbAccessContext/);
  });
});

/**
 * Protocol columns the boundary deliberately keeps. Wave 1b's
 * `rebindProtocolVersion` will join: the new install reports it at enroll, so
 * it is not reset at the boundary (§4.1).
 */
const NOT_RESET_AT_BOUNDARY: ReadonlySet<string> = new Set<string>([]);

describe('device row reset (§5.5 capability columns)', () => {
  it('resets every declared protocol capability of the old install', () => {
    const capabilityColumns = Object.keys(getTableColumns(devices))
      .filter((key) => /ProtocolVersion$/.test(key) && !NOT_RESET_AT_BOUNDARY.has(key));
    expect(capabilityColumns.length).toBeGreaterThan(10);
    const reset = Object.keys(INSTALL_BOUNDARY_RESET_COLUMNS);
    const missing = capabilityColumns.filter((key) => !reset.includes(key));
    expect(missing, 'a new *ProtocolVersion column must join INSTALL_BOUNDARY_RESET_COLUMNS').toEqual([]);
  });

  it('resets each column to its "not declared" value', () => {
    const columns = getTableColumns(devices) as Record<string, { notNull: boolean }>;
    for (const [key, value] of Object.entries(INSTALL_BOUNDARY_RESET_COLUMNS)) {
      expect(columns[key], key).toBeDefined();
      if (value === null) expect(columns[key]!.notNull, `${key} is reset to NULL`).toBe(false);
    }
  });
});
