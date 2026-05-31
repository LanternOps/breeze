import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildConditionSQL, validateFilter, getFieldDefinition } from './filterEngine';
import type { FilterCondition } from '@breeze/shared/types/filters';

const dialect = new PgDialect();
const render = (cond: FilterCondition): string => dialect.sqlToQuery(buildConditionSQL(cond)).sql;

describe('filterEngine virtual EXISTS fields (#968)', () => {
  describe('boolean predicates', () => {
    it('patches.pending equals yes → EXISTS against device_patches WHERE status pending', () => {
      const sql = render({ field: 'patches.pending', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/exists \(select 1 from device_patches/i);
      expect(sql).toMatch(/status = 'pending'/i);
      expect(sql).not.toMatch(/^not /i);
    });

    it('patches.pending equals no → negated', () => {
      expect(render({ field: 'patches.pending', operator: 'equals', value: 'no' })).toMatch(/^not \(/i);
    });

    it('patches.pending notEquals yes → negated', () => {
      expect(render({ field: 'patches.pending', operator: 'notEquals', value: 'yes' })).toMatch(/^not \(/i);
    });

    it('patches.pending notEquals no → double negative resolves positive', () => {
      expect(render({ field: 'patches.pending', operator: 'notEquals', value: 'no' })).not.toMatch(/^not /i);
    });

    it('boolean false value is treated as the negative', () => {
      expect(render({ field: 'patches.pending', operator: 'equals', value: false })).toMatch(/^not \(/i);
    });

    it('alerts.critical → active + critical against alerts', () => {
      const sql = render({ field: 'alerts.critical', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/from alerts where device_id/i);
      expect(sql).toMatch(/status = 'active'/i);
      expect(sql).toMatch(/severity = 'critical'/i);
    });

    it('system.rebootRequired → patch_job_results reboot pending', () => {
      const sql = render({ field: 'system.rebootRequired', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/from patch_job_results/i);
      expect(sql).toMatch(/reboot_required = true/i);
      expect(sql).toMatch(/rebooted_at is null/i);
    });
  });

  describe('software predicates resolve against software_inventory (not the dead device_software)', () => {
    it('software.installed contains → ILIKE EXISTS against software_inventory', () => {
      const sql = render({ field: 'software.installed', operator: 'contains', value: 'Chrome' });
      expect(sql).toMatch(/exists \(select 1 from "software_inventory"/i);
      expect(sql).toMatch(/ilike/i);
      expect(sql).not.toMatch(/device_software/i);
    });

    it('software.notInstalled contains → negated EXISTS', () => {
      const sql = render({ field: 'software.notInstalled', operator: 'contains', value: 'Chrome' });
      expect(sql).toMatch(/^not \(/i);
      expect(sql).toMatch(/software_inventory/i);
    });

    it('software.installed in [..] → IN list, no array-bind', () => {
      const sql = render({ field: 'software.installed', operator: 'in', value: ['A', 'B'] });
      expect(sql).toMatch(/ in \(/i);
      expect(sql).not.toMatch(/= any\(/i);
    });

    it('software.installed hasAll → AND of two EXISTS', () => {
      const sql = render({ field: 'software.installed', operator: 'hasAll', value: ['A', 'B'] });
      expect((sql.match(/exists/gi) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/ and /i);
    });

    it('software.installed in [] → no-op TRUE (no constraint)', () => {
      expect(render({ field: 'software.installed', operator: 'in', value: [] })).toMatch(/true/i);
    });
  });
});

describe('filterEngine field registration (#968)', () => {
  it('registers the three boolean fields', () => {
    for (const key of ['patches.pending', 'alerts.critical', 'system.rebootRequired']) {
      const def = getFieldDefinition(key);
      expect(def, key).toBeDefined();
      expect(def?.type).toBe('boolean');
      expect(def?.operators).toContain('equals');
    }
  });

  it('validateFilter accepts the boolean fields with equals/notEquals', () => {
    expect(validateFilter({ field: 'patches.pending', operator: 'equals', value: 'yes' } as FilterCondition).valid).toBe(true);
    expect(validateFilter({ field: 'alerts.critical', operator: 'notEquals', value: 'no' } as FilterCondition).valid).toBe(true);
  });

  it('validateFilter rejects an unsupported operator on a boolean field', () => {
    expect(validateFilter({ field: 'patches.pending', operator: 'contains', value: 'x' } as FilterCondition).valid).toBe(false);
  });

  it('validateFilter accepts the expanded software multi-select operators', () => {
    for (const operator of ['in', 'hasAny', 'hasAll', 'equals'] as const) {
      expect(validateFilter({ field: 'software.installed', operator, value: ['A'] } as FilterCondition).valid, operator).toBe(true);
    }
    expect(validateFilter({ field: 'software.notInstalled', operator: 'in', value: ['A'] } as FilterCondition).valid).toBe(true);
  });
});

describe('filterEngine related-table fields via correlated subqueries (no joins)', () => {
  it('hardware.* → EXISTS against device_hardware (1:1)', () => {
    const sql = render({ field: 'hardware.cpuCores', operator: 'greaterThan', value: 4 });
    expect(sql).toMatch(/exists \(select 1 from "device_hardware"/i);
    expect(sql).toMatch(/"device_id" = "devices"\."id"/i);
    expect(sql).toMatch(/> \$\d/);
  });

  it('network.* → EXISTS against device_network (1:many, any interface)', () => {
    const sql = render({ field: 'network.ipAddress', operator: 'contains', value: '10.0' });
    expect(sql).toMatch(/exists \(select 1 from "device_network"/i);
    expect(sql).toMatch(/ilike/i);
  });

  it('metrics.* → latest-sample scalar subquery ordered by timestamp', () => {
    const sql = render({ field: 'metrics.diskPercent', operator: 'greaterThan', value: 90 });
    expect(sql).toMatch(/from "device_metrics"/i);
    expect(sql).toMatch(/"device_metrics"\."disk_percent"/i);
    expect(sql).toMatch(/order by "device_metrics"\."timestamp" desc limit 1/i);
    expect(sql).toMatch(/> \$\d/);
  });

  it('groupId equals → EXISTS membership', () => {
    const sql = render({ field: 'groupId', operator: 'equals', value: 'g1' });
    expect(sql).toMatch(/exists \(select 1 from "device_group_memberships"/i);
    expect(sql).toMatch(/"group_id" = \$\d/i);
  });

  it('groupId in → EXISTS membership ANY', () => {
    const sql = render({ field: 'groupId', operator: 'in', value: ['g1', 'g2'] });
    expect(sql).toMatch(/"group_id" = any\(/i);
  });

  it('device-column fields still compare directly (no subquery)', () => {
    const sql = render({ field: 'hostname', operator: 'contains', value: 'web' });
    expect(sql).not.toMatch(/exists/i);
    expect(sql).toMatch(/ilike/i);
  });
});

describe('filterEngine device-row catalog completion', () => {
  it('registers the new device-column fields', () => {
    for (const key of ['lastUser', 'isHeadless', 'uptimeSeconds', 'watchdogStatus', 'quarantinedAt', 'lastSeenIp']) {
      expect(getFieldDefinition(key), key).toBeDefined();
    }
  });

  it('status enum offers all seven device statuses', () => {
    const def = getFieldDefinition('status');
    expect(def?.enumValues).toEqual(['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']);
  });

  it('new device-column fields compile as direct comparisons (no subquery)', () => {
    expect(render({ field: 'lastUser', operator: 'equals', value: 'bdunn' })).toMatch(/"last_user" = \$/i);
    expect(render({ field: 'watchdogStatus', operator: 'equals', value: 'failover' })).toMatch(/"watchdog_status" = \$/i);
    expect(render({ field: 'quarantinedAt', operator: 'isNotNull', value: '' })).toMatch(/"quarantined_at" is not null/i);
    expect(render({ field: 'lastUser', operator: 'equals', value: 'x' })).not.toMatch(/exists/i);
  });
});
