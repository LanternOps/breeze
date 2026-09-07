import { beforeEach, describe, expect, it, vi } from 'vitest';

// Generalises the bounded, SYSTEM-context definition lookup so both the
// script write-back path AND the two device-PATCH write paths (#3257 W04)
// can see org-owned + partner-wide custom-field definitions from one loader.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown, _label?: string) => fn()),
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

import { db } from '../../db';
import {
  loadScriptWritableDefinitions,
  loadVisibleCustomFieldDefinitions,
  valueColumnsFor,
} from './queries';

interface FixtureDefinition {
  id: string;
  fieldKey: string;
  orgId: string | null;
  partnerId: string | null;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: unknown;
  deviceTypes: string[] | null;
  required: boolean;
  scriptWrite: boolean;
  name: string;
}

const ORG_ID = 'org-1';

function mockOrgPartner(partnerId: string | null) {
  const limit = vi.fn().mockResolvedValue([{ partnerId }]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

function mockDefinitions(defs: FixtureDefinition[]) {
  const where = vi.fn().mockResolvedValue(defs);
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

describe('loadVisibleCustomFieldDefinitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns org-owned AND partner-wide definitions for the org', async () => {
    mockOrgPartner('partner-1');
    mockDefinitions([
      {
        id: 'd1',
        fieldKey: 'asset_tag',
        orgId: 'org-1',
        partnerId: null,
        type: 'text',
        options: null,
        deviceTypes: null,
        required: false,
        scriptWrite: false,
        name: 'Asset Tag',
      },
      {
        id: 'd2',
        fieldKey: 'udf7',
        orgId: null,
        partnerId: 'partner-1',
        type: 'number',
        options: null,
        deviceTypes: null,
        required: false,
        scriptWrite: false,
        name: 'UDF 7',
      },
    ]);

    const defs = await loadVisibleCustomFieldDefinitions(ORG_ID);

    expect(defs.map((d) => d.fieldKey).sort()).toEqual(['asset_tag', 'udf7']);
    expect(defs.find((d) => d.fieldKey === 'udf7')!.id).toBe('d2');
    // Widened projection: id, name and required must be present, not dropped.
    expect(defs.find((d) => d.fieldKey === 'asset_tag')).toMatchObject({
      id: 'd1',
      name: 'Asset Tag',
      required: false,
      orgId: 'org-1',
      partnerId: null,
    });
  });

  it('scopes to the org alone when the org has no partner', async () => {
    mockOrgPartner(null);
    mockDefinitions([
      {
        id: 'd1',
        fieldKey: 'asset_tag',
        orgId: 'org-1',
        partnerId: null,
        type: 'text',
        options: null,
        deviceTypes: null,
        required: false,
        scriptWrite: false,
        name: 'Asset Tag',
      },
    ]);

    const defs = await loadVisibleCustomFieldDefinitions(ORG_ID);
    expect(defs.map((d) => d.fieldKey)).toEqual(['asset_tag']);
  });
});

describe('loadScriptWritableDefinitions (retained alias)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still returns both script_write and non-script_write rows — the caller applies that gate', async () => {
    // note: the CALLER (scriptWriteBack) applies the script_write gate per
    // field, so this loader intentionally returns both — assert the existing
    // contract, do not silently change it. See scriptWriteBack.ts:104-107.
    mockOrgPartner('partner-1');
    mockDefinitions([
      {
        id: 'd1',
        fieldKey: 'a',
        orgId: 'org-1',
        partnerId: null,
        scriptWrite: true,
        type: 'text',
        options: null,
        deviceTypes: null,
        required: false,
        name: 'A',
      },
      {
        id: 'd2',
        fieldKey: 'b',
        orgId: 'org-1',
        partnerId: null,
        scriptWrite: false,
        type: 'text',
        options: null,
        deviceTypes: null,
        required: false,
        name: 'B',
      },
    ]);

    const defs = await loadScriptWritableDefinitions(ORG_ID);
    expect(defs.map((d) => d.fieldKey)).toEqual(['a', 'b']);
  });

  it('is the same function reference as loadVisibleCustomFieldDefinitions', () => {
    expect(loadScriptWritableDefinitions).toBe(loadVisibleCustomFieldDefinitions);
  });
});

// #3257 W05: pure column-placement logic for the normalized value table.
// `persistDeviceCustomFields` (the old whole-jsonb writer) was removed — there
// is nothing left to unit-test at that name. `persistDeviceCustomFieldValues`
// itself needs a real Drizzle upsert (onConflictDoUpdate/setWhere) and is
// exercised against real Postgres by deviceCustomFieldValues.integration.test.ts;
// this file covers the pure mapping it delegates to.
describe('valueColumnsFor', () => {
  const EMPTY = { valueText: null, valueNumber: null, valueBool: null, valueDate: null };

  it('places a text value in valueText, leaving the other three columns null', () => {
    expect(valueColumnsFor('text', 'A-1')).toEqual({ ...EMPTY, valueText: 'A-1' });
  });

  it('places a dropdown value in valueText, same as text', () => {
    expect(valueColumnsFor('dropdown', 'gold')).toEqual({ ...EMPTY, valueText: 'gold' });
  });

  it('places a number value in valueNumber as-is when already a number', () => {
    expect(valueColumnsFor('number', 42)).toEqual({ ...EMPTY, valueNumber: 42 });
  });

  it('coerces a string number into valueNumber', () => {
    expect(valueColumnsFor('number', '42')).toEqual({ ...EMPTY, valueNumber: 42 });
  });

  it('places a boolean value in valueBool as-is when already a boolean', () => {
    expect(valueColumnsFor('boolean', true)).toEqual({ ...EMPTY, valueBool: true });
    expect(valueColumnsFor('boolean', false)).toEqual({ ...EMPTY, valueBool: false });
  });

  it('coerces a string boolean into valueBool by exact "true" match', () => {
    expect(valueColumnsFor('boolean', 'true')).toEqual({ ...EMPTY, valueBool: true });
    expect(valueColumnsFor('boolean', 'false')).toEqual({ ...EMPTY, valueBool: false });
  });

  it('places a date value in valueDate, truncated to the first 10 characters', () => {
    expect(valueColumnsFor('date', '2026-01-15T00:00:00.000Z')).toEqual({
      ...EMPTY,
      valueDate: '2026-01-15',
    });
  });

  it('returns all-null columns for a null value, regardless of type — a legal, explicit clear', () => {
    expect(valueColumnsFor('text', null)).toEqual(EMPTY);
    expect(valueColumnsFor('number', null)).toEqual(EMPTY);
    expect(valueColumnsFor('boolean', null)).toEqual(EMPTY);
    expect(valueColumnsFor('dropdown', null)).toEqual(EMPTY);
    expect(valueColumnsFor('date', null)).toEqual(EMPTY);
  });
});
