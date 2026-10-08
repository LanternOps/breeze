import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { edrActions, edrConnections, edrDetections, edrEndpoints, edrTenants } from './edrProviders';
import * as schemaBarrel from './index';

describe('edr provider schema', () => {
  it('is exported from the schema barrel', () => {
    expect(schemaBarrel.edrConnections).toBe(edrConnections);
    expect(schemaBarrel.edrTenants).toBe(edrTenants);
    expect(schemaBarrel.edrEndpoints).toBe(edrEndpoints);
    expect(schemaBarrel.edrDetections).toBe(edrDetections);
    expect(schemaBarrel.edrActions).toBe(edrActions);
  });

  it('names the device link breeze_device_id, never device_id (spec D4)', () => {
    for (const table of [edrEndpoints, edrDetections, edrActions]) {
      const names = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(names, getTableName(table)).toContain('breeze_device_id');
      expect(names, getTableName(table)).not.toContain('device_id');
    }
  });

  it('keeps partner-axis tables free of an org_id NOT NULL', () => {
    expect(Object.values(getTableColumns(edrConnections)).map((c) => c.name)).not.toContain('org_id');
    expect(getTableColumns(edrTenants).orgId.notNull).toBe(false);
  });

  it('shape-1 tables carry a NOT NULL org_id', () => {
    for (const table of [edrEndpoints, edrDetections, edrActions]) {
      expect(getTableColumns(table).orgId.notNull, getTableName(table)).toBe(true);
    }
  });

  it('tombstone-able children have a nullable tenant_id (plan index correction 1)', () => {
    expect(getTableColumns(edrDetections).tenantId.notNull).toBe(false);
    expect(getTableColumns(edrActions).tenantId.notNull).toBe(false);
    expect(getTableColumns(edrEndpoints).tenantId.notNull).toBe(true);
  });

  it('the live detection identity index is partial on detached_at IS NULL (correction 1b)', () => {
    const idx = getTableConfig(edrDetections).indexes.find(
      (i) => i.config.name === 'edr_detections_live_vendor_uniq',
    );
    expect(idx, 'edr_detections_live_vendor_uniq missing').toBeDefined();
    expect(idx!.config.unique).toBe(true);
    expect(idx!.config.where).toBeDefined();
  });

  it('does not declare the column-list SET NULL device-link FKs (migration-authoritative)', () => {
    for (const table of [edrEndpoints, edrDetections, edrActions]) {
      const fkNames = getTableConfig(table).foreignKeys.map((fk) => fk.getName());
      expect(fkNames.some((n) => n.endsWith('_breeze_device_org_fk')), getTableName(table)).toBe(false);
    }
  });
});
