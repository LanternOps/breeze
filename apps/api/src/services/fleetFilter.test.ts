import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { FLEET_FILTER_GROUP_BY, fleetFilterSchema, type FleetFilter } from '@breeze/shared';
import { buildGroupSQL, getFieldDefinition, isExecutionRefusedFilterField } from './filterEngine';
import {
  compileFleetFilter,
  fleetFilterExecutionRefusedFields,
  fleetFilterFieldsUsed,
  fleetFilterParamSchema,
  fleetFilterZodShape,
} from './fleetFilter';

const SITE = '11111111-1111-4111-8111-111111111111';
const GROUP = '22222222-2222-4222-8222-222222222222';

const ALL_FIELDS: FleetFilter = {
  status: 'online',
  osType: 'windows',
  osVersionContains: '11',
  hostnameContains: 'web',
  siteId: SITE,
  groupId: GROUP,
  tags: ['pci'],
  agentVersion: '0.130.0',
  softwareInstalled: '7-Zip',
  softwareMissing: 'CrowdStrike',
  softwareVersionBelow: { name: '7-Zip', version: '23.01' },
  pendingPatches: true,
  criticalAlerts: false,
  rebootRequired: true,
  lastSeenDaysOver: 30,
};

const render = (s: unknown) => new PgDialect().sqlToQuery(s as any);

describe('compileFleetFilter', () => {
  it('compiles each field to the documented engine key, operator and value', () => {
    expect(
      compileFleetFilter({
        osType: 'windows',
        tags: ['pci'],
        softwareVersionBelow: { name: '7-Zip', version: '23' },
        pendingPatches: true,
        lastSeenDaysOver: 30,
      }),
    ).toEqual({
      operator: 'AND',
      conditions: [
        { field: 'osType', operator: 'equals', value: 'windows' },
        { field: 'tags', operator: 'hasAll', value: ['pci'] },
        { field: 'software.version', operator: 'below', value: { name: '7-Zip', version: '23' } },
        { field: 'patches.pending', operator: 'equals', value: true },
        { field: 'daysSinceLastSeen', operator: 'greaterThan', value: 30 },
      ],
    });
  });

  it('compiles all fifteen fields in the documented order', () => {
    expect(compileFleetFilter(ALL_FIELDS).conditions).toEqual([
      { field: 'status', operator: 'equals', value: 'online' },
      { field: 'osType', operator: 'equals', value: 'windows' },
      { field: 'osVersion', operator: 'contains', value: '11' },
      { field: 'hostname', operator: 'contains', value: 'web' },
      { field: 'siteId', operator: 'equals', value: SITE },
      { field: 'groupId', operator: 'equals', value: GROUP },
      { field: 'tags', operator: 'hasAll', value: ['pci'] },
      { field: 'agentVersion', operator: 'equals', value: '0.130.0' },
      { field: 'software.installed', operator: 'contains', value: '7-Zip' },
      { field: 'software.notInstalled', operator: 'contains', value: 'CrowdStrike' },
      { field: 'software.version', operator: 'below', value: { name: '7-Zip', version: '23.01' } },
      { field: 'patches.pending', operator: 'equals', value: true },
      { field: 'alerts.critical', operator: 'equals', value: false },
      { field: 'system.rebootRequired', operator: 'equals', value: true },
      { field: 'daysSinceLastSeen', operator: 'greaterThan', value: 30 },
    ]);
  });

  it('an empty filter compiles to an empty AND group', () => {
    expect(compileFleetFilter({})).toEqual({ operator: 'AND', conditions: [] });
  });

  it('every compiled operator is one the engine allows for that field', () => {
    for (const c of compileFleetFilter(ALL_FIELDS).conditions) {
      const cond = c as { field: string; operator: string };
      expect(getFieldDefinition(cond.field)?.operators, cond.field).toContain(cond.operator);
    }
  });
});

describe('fleet filter provenance', () => {
  it('fieldsUsed are the engine keys, sorted and unique', () => {
    expect(fleetFilterFieldsUsed({ tags: ['a'], osType: 'linux' })).toEqual(['osType', 'tags']);
    expect(fleetFilterFieldsUsed({})).toEqual([]);
  });

  it('exactly hostnameContains, tags, agentVersion and the three software fields are execution-refused', () => {
    expect(fleetFilterExecutionRefusedFields(ALL_FIELDS)).toEqual([
      'agentVersion',
      'hostname',
      'software.installed',
      'software.notInstalled',
      'software.version',
      'tags',
    ]);
    // Agrees with the engine's own provenance table for every facade field.
    for (const f of fleetFilterFieldsUsed(ALL_FIELDS)) {
      expect(fleetFilterExecutionRefusedFields(ALL_FIELDS).includes(f), f).toBe(isExecutionRefusedFilterField(f));
    }
  });

  it('a field description says "count only" exactly when the engine refuses its key as an execution target', () => {
    for (const [key, value] of Object.entries(ALL_FIELDS)) {
      const engineKeys = fleetFilterFieldsUsed({ [key]: value } as FleetFilter);
      expect(engineKeys, key).toHaveLength(1);
      const description = (fleetFilterSchema.shape as Record<string, { description?: string }>)[key]!.description!;
      expect(description.includes('count only'), key).toBe(isExecutionRefusedFilterField(engineKeys[0]!));
    }
  });

  it('a server-side-only filter has no execution-refused fields', () => {
    expect(fleetFilterExecutionRefusedFields({ osType: 'windows', pendingPatches: true, siteId: SITE })).toEqual([]);
  });

  it('every compiled field is a key the engine defines', () => {
    const used = fleetFilterFieldsUsed(ALL_FIELDS);
    expect(used).toHaveLength(15);
    for (const f of used) expect(getFieldDefinition(f), f).toBeDefined();
  });
});

describe('fleet filter schema surfaces', () => {
  it('the JSON mirror and the Zod shape declare the same property names and descriptions, all ≤ 160 chars', () => {
    const json = fleetFilterParamSchema() as {
      type: string;
      additionalProperties: boolean;
      description: string;
      properties: Record<string, { description?: string }>;
    };
    expect(json.type).toBe('object');
    expect(json.additionalProperties).toBe(false);
    expect(json.description.length).toBeLessThanOrEqual(160);
    const zodKeys = Object.keys(fleetFilterSchema.shape).sort();
    expect(Object.keys(json.properties).sort()).toEqual(zodKeys);
    expect(zodKeys).toHaveLength(15);
    for (const k of zodKeys) {
      const zd = (fleetFilterSchema.shape as Record<string, { description?: string }>)[k]!.description;
      expect(json.properties[k]!.description, k).toBe(zd);
      expect(zd!.length, k).toBeLessThanOrEqual(160);
    }
  });

  it('the JSON mirror carries the bounds the Zod schema enforces', () => {
    const p = (fleetFilterParamSchema() as { properties: Record<string, any> }).properties;
    expect(p.status.enum).toEqual(['online', 'offline', 'maintenance', 'quarantined', 'updating', 'pending']);
    expect(p.osType.enum).toEqual(['windows', 'macos', 'linux']);
    expect(p.tags).toMatchObject({ type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } });
    expect(p.softwareVersionBelow).toMatchObject({
      type: 'object',
      required: ['name', 'version'],
      additionalProperties: false,
      properties: { version: { pattern: '^\\d' } },
    });
    expect(p.lastSeenDaysOver).toMatchObject({ type: 'integer', minimum: 1, maximum: 3650 });
    expect(p.siteId).toMatchObject({ type: 'string', format: 'uuid' });
  });

  it('the Zod shape is JSON-schema representable and pairs filter with a groupBy enum', () => {
    const shape = fleetFilterZodShape();
    expect(Object.keys(shape)).toEqual(['filter', 'groupBy']);
    const emitted = z.toJSONSchema(z.object(shape), { io: 'input' }) as any;
    expect(emitted.properties.groupBy.enum).toEqual([...FLEET_FILTER_GROUP_BY]);
    expect(Object.keys(emitted.properties.filter.properties).sort()).toEqual(Object.keys(fleetFilterSchema.shape).sort());
    expect(z.object(shape).safeParse({}).success).toBe(true);
    expect(z.object(shape).safeParse({ groupBy: 'software' }).success).toBe(false);
  });
});

describe('buildGroupSQL on a compiled filter', () => {
  it('renders an EXISTS with the LIKE wildcard escaped for a software filter', () => {
    const q = render(buildGroupSQL(compileFleetFilter({ softwareInstalled: '100%' })));
    expect(q.sql).toMatch(/EXISTS/i);
    expect(q.params.join(' ')).toContain('100\\%');
  });

  it('renders TRUE for an empty filter', () => {
    expect(render(buildGroupSQL(compileFleetFilter({}))).sql).toBe('TRUE');
  });

  it('renders every field of a full filter without throwing', () => {
    const q = render(buildGroupSQL(compileFleetFilter(ALL_FIELDS)));
    expect(q.params).toContain(SITE);
    expect(q.params).toContain(GROUP);
  });
});
