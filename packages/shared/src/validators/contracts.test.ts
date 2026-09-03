import { describe, it, expect } from 'vitest';
import {
  createContractSchema, contractLineInputSchema, updateContractSchema, changeContractCurrencySchema,
  updateContractLineSchema, contractLineInvariantIssues, mergeContractLinePatch, patchHasKey,
  type ContractLineShape, type PersistedContractLine,
} from './contracts';

describe('createContractSchema', () => {
  it('accepts a valid monthly advance contract', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Acme MSP', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01', autoIssue: false
    });
    expect(r.success).toBe(true);
  });
  it('rejects intervalMonths < 1', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance', intervalMonths: 0, startDate: '2026-07-01'
    });
    expect(r.success).toBe(false);
  });
  it('rejects endDate before startDate', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2026-06-01'
    });
    expect(r.success).toBe(false);
  });
  // Regression: the web create form sends `endDate || null` and `notes.trim() || null`
  // for the common open-ended/no-notes case. The schema must accept null, not only undefined.
  it('accepts null endDate/notes (the open-ended UI payload)', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'Acme MSP', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: null, autoIssue: false, notes: null
    });
    expect(r.success).toBe(true);
  });
});

describe('auto-renew fields', () => {
  const base = {
    orgId: '11111111-1111-1111-1111-111111111111',
    name: 'Acme', billingTiming: 'advance' as const, intervalMonths: 1, startDate: '2026-07-01'
  };
  it('accepts a fixed-term auto-renew contract', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    });
    expect(r.success).toBe(true);
  });
  it('rejects autoRenew without an endDate (cannot renew an indefinite contract)', () => {
    const r = createContractSchema.safeParse({ ...base, autoRenew: true, renewalTermMonths: 12 });
    expect(r.success).toBe(false);
  });
  it('rejects autoRenew without a renewalTermMonths', () => {
    const r = createContractSchema.safeParse({ ...base, endDate: '2027-07-01', autoRenew: true });
    expect(r.success).toBe(false);
  });
  it('rejects renewalTermMonths < 1', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 0
    });
    expect(r.success).toBe(false);
  });
  it('allows clearing auto-renew on update', () => {
    expect(updateContractSchema.safeParse({ autoRenew: false }).success).toBe(true);
  });
});

describe('contractLineInputSchema', () => {
  it('requires manualQuantity for manual lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false
    }).success).toBe(false);
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false, manualQuantity: '3'
    }).success).toBe(true);
  });
  it('allows siteId only as an optional uuid on per_device lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'per_device', description: 'RMM', unitPrice: '15.00', taxable: true,
      siteId: '22222222-2222-2222-2222-222222222222'
    }).success).toBe(true);
  });
  it('accepts a flat line with no quantity fields', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: false
    }).success).toBe(true);
  });
});

// Multi-currency wave 3 (#3775): a catalog-sourced contract line is priced by
// the server-side resolver, so the client supplies no unitPrice; non-catalog
// lines still carry their own price.
describe('contractLineInputSchema — catalog lines omit unitPrice', () => {
  it('accepts a flat catalog line without unitPrice', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', taxable: true,
      catalogItemId: '33333333-3333-3333-3333-333333333333'
    }).success).toBe(true);
  });
  it('rejects a flat line with neither unitPrice nor catalogItemId', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', taxable: false
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'unitPrice');
      expect(issue?.message).toBe('unitPrice is required unless catalogItemId is set');
    }
  });
  it('still accepts a non-catalog line carrying unitPrice', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'per_seat', description: 'Seats', unitPrice: '12.00', taxable: true
    }).success).toBe(true);
  });
});

// Post-merge review #1: the editor omits `taxable` for a catalog line (the
// server resolves it from the item, ignoring any client value) and JSON drops
// the undefined key — so the schema must not require it there. Non-catalog
// lines still stamp the client's taxable verbatim, so it stays required.
describe('contractLineInputSchema — catalog lines omit taxable', () => {
  it('accepts a catalog line with neither unitPrice nor taxable (the editor payload)', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services',
      catalogItemId: '33333333-3333-3333-3333-333333333333'
    }).success).toBe(true);
  });
  it('rejects a non-catalog line without taxable', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00'
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'taxable');
      expect(issue?.message).toBe('taxable is required unless catalogItemId is set');
    }
  });
});

// #3205: a per_device_role line bills a SET of device roles. deviceRoles is
// required on that type and forbidden on every other, mirrors the DB CHECK,
// never contains 'unknown' (a classification gap, not a rate) or duplicates.
describe('contractLineInputSchema — per_device_role (#3205)', () => {
  const base = { description: 'Network gear', unitPrice: '25.00', taxable: true };
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('requires a non-empty deviceRoles array on per_device_role', () => {
    expect(parse({ ...base, lineType: 'per_device_role' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: [] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['switch', 'router', 'firewall'] })).toBe(true);
  });

  it('rejects deviceRoles on every other line type', () => {
    for (const lineType of ['flat', 'per_device', 'per_seat'] as const) {
      expect(parse({ ...base, lineType, deviceRoles: ['server'] })).toBe(false);
    }
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '2', deviceRoles: ['server'] })).toBe(false);
  });

  it('rejects unknown and unrecognised roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['unknown'] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'mainframe'] })).toBe(false);
  });

  it('rejects duplicate roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'server'] })).toBe(false);
  });

  it('accepts siteId on per_device_role and still rejects it on flat / per_seat / manual', () => {
    const siteId = '22222222-2222-2222-2222-222222222222';
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['workstation'], siteId })).toBe(true);
    expect(parse({ ...base, lineType: 'flat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'per_seat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '1', siteId })).toBe(false);
  });
});

// #3205 wave 2: a per_device_group line bills the members of one device group.
// deviceGroupId is required on that type and forbidden on every other; a group
// line carries no site (the group's own site narrows it) and no roles.
describe('contractLineInputSchema — per_device_group (#3205 W02)', () => {
  const base = { description: 'VIP laptops', unitPrice: '40.00', taxable: true };
  const groupId = '33333333-3333-4333-8333-333333333333';
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('requires a GUID deviceGroupId on per_device_group', () => {
    expect(parse({ ...base, lineType: 'per_device_group' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: 'not-a-guid' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId })).toBe(true);
  });

  it('rejects deviceGroupId on every other line type', () => {
    for (const lineType of ['flat', 'per_device', 'per_seat'] as const) {
      expect(parse({ ...base, lineType, deviceGroupId: groupId })).toBe(false);
    }
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server'], deviceGroupId: groupId })).toBe(false);
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '2', deviceGroupId: groupId })).toBe(false);
  });

  it('rejects siteId and deviceRoles on a group line', () => {
    const siteId = '22222222-2222-4222-8222-222222222222';
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId, siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_group', deviceGroupId: groupId, deviceRoles: ['server'] })).toBe(false);
  });
});

describe('changeContractCurrencySchema (#3778)', () => {
  it('defaults confirmActiveChange to false — an ACTIVE restamp is never implicit', () => {
    const parsed = changeContractCurrencySchema.parse({ currencyCode: 'eur' });
    expect(parsed).toEqual({ currencyCode: 'EUR', clearLines: false, reprice: false, confirmActiveChange: false });
  });

  it('accepts confirmActiveChange alongside clearLines', () => {
    expect(changeContractCurrencySchema.parse({ currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }))
      .toMatchObject({ clearLines: true, confirmActiveChange: true });
  });

  it('keeps clearLines and reprice mutually exclusive', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', clearLines: true, reprice: true }).success).toBe(false);
  });

  it('is strict — a mis-keyed field is a parse error, never a silent default', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', convert: true }).success).toBe(false);
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', confirmActive: true }).success).toBe(false);
  });

  it('rejects an unsupported currency code', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'XXX' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #3205 W03 — contract line editing.
// ---------------------------------------------------------------------------

// The create-path bounds tighten too (decision 10): unbounded money and
// sortOrder reached Postgres as a raw 22003 and surfaced as a 500.
describe('contractLineInputSchema — numeric bounds (#3205 W03)', () => {
  const base = { lineType: 'flat' as const, description: 'Fee', taxable: true };
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('accepts the largest numeric(12,2) unitPrice and rejects an 11-digit one', () => {
    expect(parse({ ...base, unitPrice: '9999999999.99' })).toBe(true);
    expect(parse({ ...base, unitPrice: '99999999999.00' })).toBe(false);
  });

  it('applies the same bound to manualQuantity', () => {
    const manual = { lineType: 'manual' as const, description: 'Hours', unitPrice: '1.00', taxable: false };
    expect(parse({ ...manual, manualQuantity: '9999999999.99' })).toBe(true);
    expect(parse({ ...manual, manualQuantity: '99999999999.00' })).toBe(false);
  });

  it('bounds sortOrder at int32', () => {
    expect(parse({ ...base, unitPrice: '1.00', sortOrder: 2147483647 })).toBe(true);
    expect(parse({ ...base, unitPrice: '1.00', sortOrder: 2147483648 })).toBe(false);
  });
});

describe('contractLineInputSchema — pre-W03 issue-array parity', () => {
  it('preserves the exact path, message and order for multiple create issues', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'per_seat', description: 'Seats', taxable: true,
      siteId: '22222222-2222-4222-8222-222222222222', deviceRoles: ['server'],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['unitPrice'], message: 'unitPrice is required unless catalogItemId is set' },
      { path: ['siteId'], message: 'siteId is only valid on per_device and per_device_role lines' },
      { path: ['deviceRoles'], message: 'deviceRoles is required on per_device_role lines and not allowed on other line types' },
    ]);
  });

  it('reports only Zod\'s array minimum issue for empty create deviceRoles', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'per_device_role', description: 'Network gear', unitPrice: '25.00',
      taxable: true, deviceRoles: [],
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['deviceRoles'], message: 'Too small: expected array to have >=1 items' },
    ]);
  });
});

describe('updateContractLineSchema (#3205 W03)', () => {
  const GUID = '33333333-3333-4333-8333-333333333333';
  const parse = (v: unknown) => updateContractLineSchema.safeParse(v);

  // Decision 3's anchor. A NON-strict schema would ACCEPT {lineType:'flat'} and
  // silently drop it, changing nothing while reporting success.
  it('rejects lineType with the exact unrecognized-key message', () => {
    const r = parse({ description: 'x', lineType: 'flat' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message)).toContain('Unrecognized key: "lineType"');
  });

  it('rejects any unknown key and an empty patch', () => {
    expect(parse({ nope: 1 }).success).toBe(false);
    const empty = parse({});
    expect(empty.success).toBe(false);
    expect(empty.error!.issues.map((i) => i.message)).toContain('patch must change at least one field');
  });

  it('rejects a non-GUID catalogItemId, empty/duplicate deviceRoles and an over-long description', () => {
    expect(parse({ catalogItemId: 'nope' }).success).toBe(false);
    expect(parse({ deviceRoles: [] }).success).toBe(false);
    expect(parse({ deviceRoles: ['server', 'server'] }).success).toBe(false);
    expect(parse({ description: 'x'.repeat(2001) }).success).toBe(false);
    expect(parse({ description: '' }).success).toBe(false);
  });

  it('applies the same money and sortOrder bounds as the create schema', () => {
    expect(parse({ unitPrice: '9999999999.99' }).success).toBe(true);
    expect(parse({ unitPrice: '99999999999.00' }).success).toBe(false);
    expect(parse({ manualQuantity: '99999999999.00' }).success).toBe(false);
    expect(parse({ sortOrder: 2147483647 }).success).toBe(true);
    expect(parse({ sortOrder: 2147483648 }).success).toBe(false);
  });

  // TRI-STATE PIN. This is what catches a Zod upgrade changing absence
  // semantics — the whole catalog transition table rests on it.
  it('preserves key absence and an explicit null on catalogItemId', () => {
    const absent = updateContractLineSchema.parse({ description: 'x' }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(absent, 'catalogItemId')).toBe(false);
    const explicit = updateContractLineSchema.parse({ catalogItemId: null }) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(explicit, 'catalogItemId')).toBe(true);
    expect(explicit.catalogItemId).toBeNull();
    expect(patchHasKey(absent as never, 'catalogItemId')).toBe(false);
    expect(patchHasKey(explicit as never, 'catalogItemId')).toBe(true);
  });

  it('treats an explicit undefined catalogItemId as absent after parsing', () => {
    const parsed = updateContractLineSchema.parse({ description: 'x', catalogItemId: undefined });
    expect(patchHasKey(parsed, 'catalogItemId')).toBe(false);
  });

  // siteId: null widens a site-scoped line to the whole org — legitimate.
  // deviceRoles/deviceGroupId: null would leave a row the DB rejects, or an
  // orphan nobody asked for (decision 7).
  it('accepts siteId null, rejects deviceRoles null and deviceGroupId null', () => {
    expect(parse({ siteId: null }).success).toBe(true);
    expect(parse({ siteId: GUID }).success).toBe(true);
    expect(parse({ deviceRoles: null }).success).toBe(false);
    expect(parse({ deviceGroupId: null }).success).toBe(false);
    expect(parse({ deviceGroupId: GUID }).success).toBe(true);
  });

  it('accepts refreshCatalogPrice alone', () => {
    expect(parse({ refreshCatalogPrice: true }).success).toBe(true);
    expect(parse({ refreshCatalogPrice: false }).success).toBe(true);
  });
});

// The whole asymmetry matrix of the spec's § Validators, both modes. Every case
// carries a comment naming which side is the sole guard, so nobody deletes one
// as redundant with "the CHECK already does it".
describe('contractLineInvariantIssues (#3205 W03)', () => {
  const GUID = '33333333-3333-4333-8333-333333333333';
  const paths = (l: Parameters<typeof contractLineInvariantIssues>[0], mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l, { mode }).map((i) => i.path);

  it('manual lines require manualQuantity in both modes', () => {
    expect(paths({ lineType: 'manual' }, 'create')).toEqual(['manualQuantity']);
    expect(paths({ lineType: 'manual', manualQuantity: null }, 'persisted')).toEqual(['manualQuantity']);
    expect(paths({ lineType: 'manual', manualQuantity: '2' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'manual', manualQuantity: '2' }, 'persisted')).toEqual([]);
  });

  // THE MODE DIFFERENCE that keeps add behaviour intact: the add writer nulls
  // manualQuantity on every non-manual type (contractService.ts:904), so create
  // TOLERATES it; a stored row carrying it is a real defect. NO DB CHECK exists
  // on manual_quantity at all — the helper is the only guard on both sides.
  it('tolerates manualQuantity on a flat line in create and rejects it in persisted', () => {
    expect(paths({ lineType: 'flat', manualQuantity: '5' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'flat', manualQuantity: '5' }, 'persisted')).toEqual(['manualQuantity']);
  });

  // The DB constrains site_id only on per_device_group (W02's CHECK). For
  // flat / manual / per_seat the helper is the ONLY guard.
  it('allows siteId only on per_device and per_device_role, in both modes', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ lineType: 'per_device', siteId: GUID, siteName: 'HQ' }, mode)).toEqual([]);
      expect(paths({ lineType: 'per_device_role', siteId: GUID, siteName: 'HQ', deviceRoles: ['server'] }, mode)).toEqual([]);
      for (const lineType of ['flat', 'per_seat'] as const) {
        expect(paths({ lineType, siteId: GUID }, mode)).toEqual(['siteId']);
      }
      expect(paths({ lineType: 'manual', manualQuantity: '1', siteId: GUID }, mode)).toEqual(['siteId']);
    }
  });

  it('rejects a siteId on a per_device_group line in both modes', () => {
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, siteId: GUID }, 'create')).toEqual(['siteId']);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, deviceGroupName: 'VIP', siteId: GUID }, 'persisted')).toEqual(['siteId']);
  });

  it('keeps deviceRoles two-way in both modes and leaves create emptiness to Zod', () => {
    for (const mode of ['create', 'persisted'] as const) {
      expect(paths({ lineType: 'per_device_role' }, mode)).toEqual(['deviceRoles']);
      expect(paths({ lineType: 'per_device', deviceRoles: ['server'] }, mode)).toEqual(['deviceRoles']);
      expect(paths({ lineType: 'per_device_role', deviceRoles: ['server'] }, mode)).toEqual([]);
    }
    expect(paths({ lineType: 'per_device_role', deviceRoles: [] }, 'create')).toEqual([]);
    expect(paths({ lineType: 'per_device_role', deviceRoles: [] }, 'persisted')).toEqual(['deviceRoles']);
  });

  // contract_lines_device_roles_chk uses `<@` — CONTAINMENT, not set equality —
  // so {'server','server'} PASSES the database. The helper is the only guard.
  it('rejects duplicate deviceRoles in both modes (the DB CHECK accepts them)', () => {
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'create')).toEqual(['deviceRoles']);
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server', 'server'] }, 'persisted')).toEqual(['deviceRoles']);
  });

  it('requires deviceGroupId on a group line in create but allows the orphan state in persisted', () => {
    expect(paths({ lineType: 'per_device_group' }, 'create')).toEqual(['deviceGroupId']);
    // The orphaned state the FK produces (ON DELETE SET NULL on device_group_id):
    // legal, and repairable in place by a patch (decision 7).
    expect(paths({ lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired' }, 'persisted')).toEqual([]);
  });

  it('rejects deviceGroupId on a non-group line in both modes', () => {
    expect(paths({ lineType: 'flat', deviceGroupId: GUID }, 'create')).toEqual(['deviceGroupId']);
    expect(paths({ lineType: 'flat', deviceGroupId: GUID }, 'persisted')).toEqual(['deviceGroupId']);
  });

  it('ignores deviceGroupName in create and makes it two-way in persisted', () => {
    // deviceGroupName is not a field of the add schema — the writer stamps it.
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID, deviceGroupName: 'VIP' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'flat', deviceGroupName: 'VIP' }, 'create')).toEqual([]);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GUID }, 'persisted')).toEqual(['deviceGroupName']);
    expect(paths({ lineType: 'flat', deviceGroupName: 'VIP' }, 'persisted')).toEqual(['deviceGroupName']);
  });

  it('carries a human message on every issue', () => {
    const issues = contractLineInvariantIssues({ lineType: 'manual' }, { mode: 'create' });
    expect(issues[0]!.message.length).toBeGreaterThan(0);
  });
});

describe('mergeContractLinePatch (#3205 W03)', () => {
  const GUID_A = '33333333-3333-4333-8333-333333333333';
  const GUID_B = '44444444-4444-4444-8444-444444444444';
  const current: PersistedContractLine = {
    lineType: 'per_device', description: 'Managed device', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: GUID_A, siteName: 'HQ', deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 3,
    includedQuantity: null, overageMode: null, overageUnitPrice: null,
  };

  it('preserves every field an omitted key does not touch', () => {
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ description: 'Renamed' }) as never))
      .toEqual({ ...current, description: 'Renamed' });
  });

  it('clears siteId on an explicit null and leaves it alone when the key is absent', () => {
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ siteId: null }) as never).siteId).toBeNull();
    expect(mergeContractLinePatch(current, updateContractLineSchema.parse({ description: 'x' }) as never).siteId).toBe(GUID_A);
  });

  it('ignores explicit undefined catalogItemId and siteId keys', () => {
    const linked: PersistedContractLine = { ...current, catalogItemId: GUID_B };
    const catalogPatch = updateContractLineSchema.parse({ description: 'x', catalogItemId: undefined });
    const sitePatch = updateContractLineSchema.parse({ description: 'x', siteId: undefined });
    expect(mergeContractLinePatch(linked, catalogPatch).catalogItemId).toBe(GUID_B);
    expect(mergeContractLinePatch(current, sitePatch).siteId).toBe(GUID_A);
    expect(patchHasKey(sitePatch, 'siteId')).toBe(false);
  });

  it('applies a client price on an unlinked line', () => {
    const m = mergeContractLinePatch(current, updateContractLineSchema.parse({ unitPrice: '12.50', taxable: false }) as never);
    expect(m).toMatchObject({ unitPrice: '12.50', taxable: false, catalogItemId: null });
  });

  // Transition rows 2 and 4: the resolver is authoritative on a linked line, so
  // a client price is dropped rather than written.
  it('ignores a client price while the merged row stays catalog-linked', () => {
    const linked: PersistedContractLine = { ...current, catalogItemId: GUID_B, unitPrice: '20.00', taxable: false };
    const m = mergeContractLinePatch(linked, updateContractLineSchema.parse({ unitPrice: '1.00', taxable: true }) as never);
    expect(m).toMatchObject({ unitPrice: '20.00', taxable: false, catalogItemId: GUID_B });
  });

  it('lets `resolved` override unitPrice, taxable and catalogItemId', () => {
    const m = mergeContractLinePatch(
      current, updateContractLineSchema.parse({ catalogItemId: GUID_B }) as never,
      { unitPrice: '7.25', taxable: false, catalogItemId: GUID_B },
    );
    expect(m).toMatchObject({ unitPrice: '7.25', taxable: false, catalogItemId: GUID_B });
  });

  // Transition row 6: after an unlink nothing re-resolves the number ever again,
  // so the patch's own price is what lands.
  it('applies the patch price when the patch unlinks the catalog item', () => {
    const linked: PersistedContractLine = { ...current, catalogItemId: GUID_B, unitPrice: '20.00' };
    const m = mergeContractLinePatch(linked, updateContractLineSchema.parse({ catalogItemId: null, unitPrice: '3.00', taxable: false }) as never);
    expect(m).toMatchObject({ catalogItemId: null, unitPrice: '3.00', taxable: false });
  });

  it('never moves lineType or deviceGroupName', () => {
    const group: PersistedContractLine = {
      ...current, lineType: 'per_device_group', siteId: null, deviceGroupId: GUID_A, deviceGroupName: 'VIP',
    };
    const m = mergeContractLinePatch(group, updateContractLineSchema.parse({ deviceGroupId: GUID_B }) as never);
    expect(m).toMatchObject({ lineType: 'per_device_group', deviceGroupId: GUID_B, deviceGroupName: 'VIP' });
  });
});

// #3205 W04 (#4607): included quantity + overage. The five rules live in
// contractLineInvariantIssues and are IDENTICAL in both modes — an allowance is
// equally legal on a new line and on a merged patch row, and a patch must never
// be able to create a row add_line would reject.
describe('allowance invariants (#3205 W04)', () => {
  const ALLOWANCE_TYPES = ['per_device', 'per_device_role', 'per_device_group', 'per_seat'] as const;
  // Minimum extra columns each type needs so ONLY the allowance rules can fire.
  const shapeFor = (lineType: ContractLineShape['lineType']): ContractLineShape => ({
    lineType,
    ...(lineType === 'per_device_role' ? { deviceRoles: ['server'] } : {}),
    ...(lineType === 'per_device_group' ? { deviceGroupId: '33333333-3333-4333-8333-333333333333', deviceGroupName: 'VIP' } : {}),
    ...(lineType === 'manual' ? { manualQuantity: '2' } : {}),
  });
  const paths = (l: unknown, mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l as never, { mode }).map((i) => i.path).sort();

  const allowance = { includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' } as const;

  it.each(['create', 'persisted'] as const)('accepts a bill allowance on all four counted types (%s mode)', (mode) => {
    for (const lineType of ALLOWANCE_TYPES) {
      expect(paths({ ...shapeFor(lineType), ...allowance }, mode)).toEqual([]);
    }
  });

  it.each(['create', 'persisted'] as const)('accepts a flag allowance with no price (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'flag' }, mode)).toEqual([]);
  });

  it.each(['create', 'persisted'] as const)('rejects any allowance column on flat and manual (%s mode)', (mode) => {
    for (const lineType of ['flat', 'manual'] as const) {
      expect(paths({ ...shapeFor(lineType), includedQuantity: '25', overageMode: 'flag' }, mode)).toContain('includedQuantity');
      expect(paths({ ...shapeFor(lineType), overageUnitPrice: '12.00' }, mode)).toContain('includedQuantity');
    }
  });

  it.each(['create', 'persisted'] as const)('requires includedQuantity and overageMode together (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25' }, mode)).toContain('overageMode');
    expect(paths({ ...shapeFor('per_device'), overageMode: 'flag' }, mode)).toContain('overageMode');
  });

  it.each(['create', 'persisted'] as const)('rejects a zero or fractional includedQuantity (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '0', overageMode: 'flag' }, mode)).toContain('includedQuantity');
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '25.5', overageMode: 'flag' }, mode)).toContain('includedQuantity');
    expect(paths({ ...shapeFor('per_seat'), includedQuantity: '25.00', overageMode: 'flag' }, mode)).toEqual([]);
  });

  it.each(['create', 'persisted'] as const)('ties overageUnitPrice to bill mode exactly (%s mode)', (mode) => {
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' }, mode)).toContain('overageUnitPrice');
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'bill' }, mode)).toContain('overageUnitPrice');
    expect(paths({ ...shapeFor('per_device'), includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '0.00' }, mode)).toEqual([]);
  });

  // The null-shaped read layer must reach the SAME verdicts as the
  // undefined-shaped write layer — the parity W03's present() refactor exists
  // to guarantee. An explicit null is "not applicable", never "set".
  it('a null-shaped merged row reaches the same verdicts as an omitted-key one', () => {
    const nulled = { ...shapeFor('per_device'), includedQuantity: null, overageMode: null, overageUnitPrice: null };
    expect(paths(nulled, 'persisted')).toEqual([]);
    expect(paths({ ...nulled, includedQuantity: '25' }, 'persisted')).toContain('overageMode');
    expect(paths({ ...shapeFor('flat'), includedQuantity: null, overageMode: null, overageUnitPrice: null }, 'persisted')).toEqual([]);
  });
});

describe('contractLineInputSchema — allowance fields (#3205 W04)', () => {
  const base = { description: 'Endpoints', unitPrice: '10.00', taxable: true } as const;
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v);

  it('accepts a bill allowance and a flag allowance', () => {
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '12.00' }).success).toBe(true);
    expect(parse({ ...base, lineType: 'per_seat', includedQuantity: '25', overageMode: 'flag' }).success).toBe(true);
  });

  it('rejects the five violations through the schema too', () => {
    expect(parse({ ...base, lineType: 'flat', includedQuantity: '25', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', overageMode: 'bill', overageUnitPrice: '1.00' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '0', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25.5', overageMode: 'flag' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'flag', overageUnitPrice: '12.00' }).success).toBe(false);
  });

  it('rejects null and a negative price at the TYPE layer, before any invariant runs', () => {
    // .optional(), never .nullable() — the add schema omits absent keys.
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: null, overageMode: null }).success).toBe(false);
    // money's ^\d+(\.\d{1,2})?$ is non-negative by construction.
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'bill', overageUnitPrice: '-1.00' }).success).toBe(false);
    expect(parse({ ...base, lineType: 'per_device', includedQuantity: '25', overageMode: 'sometimes' }).success).toBe(false);
  });
});

describe('updateContractLineSchema — allowance fields (#3205 W04)', () => {
  const parse = (v: unknown) => updateContractLineSchema.safeParse(v);

  it('accepts null for all three (removing an allowance is a legitimate edit)', () => {
    const out = parse({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(out.success).toBe(true);
    expect(Object.keys(out.data!).sort()).toEqual(['includedQuantity', 'overageMode', 'overageUnitPrice']);
  });

  it('preserves key ABSENCE, so an omitted field is unchanged (Zod 4.4.3 tri-state)', () => {
    const out = parse({ includedQuantity: '25', overageMode: 'flag' });
    expect(out.success).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out.data!, 'overageUnitPrice')).toBe(false);
  });

  it('rejects a negative or non-money price and an unknown mode', () => {
    expect(parse({ overageUnitPrice: '-1.00' }).success).toBe(false);
    expect(parse({ overageMode: 'sometimes' }).success).toBe(false);
  });
});

describe('mergeContractLinePatch carries the allowance columns (#3205 W04)', () => {
  const current = {
    lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
  } as never;

  it('an omitted key preserves the current value', () => {
    expect(mergeContractLinePatch(current, { description: 'x' } as never)).toMatchObject({
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00',
    });
  });

  it('all three nulls remove the allowance and the merged row is valid', () => {
    const merged = mergeContractLinePatch(current, { includedQuantity: null, overageMode: null, overageUnitPrice: null } as never);
    expect(merged).toMatchObject({ includedQuantity: null, overageMode: null, overageUnitPrice: null });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  it('clearing only includedQuantity leaves a row the persisted rules reject', () => {
    const merged = mergeContractLinePatch(current, { includedQuantity: null } as never);
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' }).map((i) => i.path)).toContain('overageMode');
  });
});

// ---------------------------------------------------------------------------
// #4693 (shipped in #3205 W05): the site stamp.
//
// contract_lines_site_org_fk is ON DELETE SET NULL (site_id) with no stamp
// today, so deleting a site turns a site-scoped per_device line into an
// ORG-WIDE one and resolveLineQty bills every device in the org, silently and
// forever. The stamp is what makes "the site you priced was deleted"
// distinguishable from "never had a site".
//
// The rules are PERSISTED-ONLY on purpose. contractLineInputSchema has no
// siteName field — a caller names a site by id and the server resolves the name,
// exactly as it already does for deviceGroupName. `create` describes what a
// caller may send; `persisted` describes what a stored row may be.
// ---------------------------------------------------------------------------
describe('contract line site stamp (#4693)', () => {
  const SITE = '22222222-2222-4222-8222-222222222222';
  const GROUP = '33333333-3333-4333-8333-333333333333';
  const paths = (l: Parameters<typeof contractLineInvariantIssues>[0], mode: 'create' | 'persisted') =>
    contractLineInvariantIssues(l, { mode }).map((i) => i.path);

  it('persisted requires siteName whenever siteId is set', () => {
    expect(paths({ lineType: 'per_device', siteId: SITE }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_device', siteId: SITE, siteName: 'Dallas' }, 'persisted')).toEqual([]);
    expect(paths({ lineType: 'per_device_role', deviceRoles: ['server'], siteId: SITE, siteName: 'Dallas' }, 'persisted')).toEqual([]);
  });

  // THE WHOLE POINT: id NULL + stamp present is the DELETED state, and it is
  // legal on a stored row. id NULL + stamp NULL means "never had a site" and is
  // equally legal — resolveLineQty reads exactly that difference.
  it('persisted allows a stamped name with a NULL id, and no stamp at all', () => {
    expect(paths({ lineType: 'per_device', siteId: null, siteName: 'Dallas' }, 'persisted')).toEqual([]);
    expect(paths({ lineType: 'per_device', siteId: null, siteName: null }, 'persisted')).toEqual([]);
  });

  it('persisted rejects a site stamp on a type that cannot be site-scoped', () => {
    expect(paths({ lineType: 'flat', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_seat', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'manual', manualQuantity: '2', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
    expect(paths({ lineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP', siteName: 'Dallas' }, 'persisted')).toEqual(['siteName']);
  });

  it('create ignores both rules — siteName is not an input field', () => {
    expect(paths({ lineType: 'per_device', siteId: SITE }, 'create')).toEqual([]);
    expect(paths({ lineType: 'per_seat', siteName: 'Dallas' }, 'create')).toEqual([]);
  });
});

describe('mergeContractLinePatch carries the site stamp (#4693)', () => {
  const current = {
    lineType: 'per_device', description: 'Endpoints', unitPrice: '10.00', taxable: true,
    catalogItemId: null, manualQuantity: null, siteId: '22222222-2222-4222-8222-222222222222',
    siteName: 'Dallas', deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: null, overageMode: null, overageUnitPrice: null,
  } as never;

  it('an omitted siteId leaves the stamp alone', () => {
    expect(mergeContractLinePatch(current, { description: 'x' } as never)).toMatchObject({ siteId: '22222222-2222-4222-8222-222222222222', siteName: 'Dallas' });
  });

  // Clearing the site widens the line to the whole org DELIBERATELY, so the
  // stamp must go with it — otherwise the row reads as "site deleted".
  it('siteId: null clears the stamp, and the merged row is valid', () => {
    const merged = mergeContractLinePatch(current, { siteId: null } as never);
    expect(merged).toMatchObject({ siteId: null, siteName: null });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });

  // Re-pointing keeps the OLD stamp in the merged row; the service re-stamps
  // from the resolved site after the invariants run, exactly as it does for
  // deviceGroupName (W03 decision 7).
  it('a new siteId keeps the old stamp for the invariant pass', () => {
    const merged = mergeContractLinePatch(current, { siteId: '44444444-4444-4444-8444-444444444444' } as never);
    expect(merged).toMatchObject({ siteId: '44444444-4444-4444-8444-444444444444', siteName: 'Dallas' });
    expect(contractLineInvariantIssues(merged, { mode: 'persisted' })).toEqual([]);
  });
});
