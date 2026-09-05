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
