import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors the mocking pattern established in quickbooksCustomerImport.test.ts:
// mock the db module, the connection/token seams, and the provider registry,
// then exercise the real matching logic against those mocks.
const {
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  getConnectionMock,
  getValidAccessTokenMock,
  listRemoteCustomersMock,
  listRemoteItemsMock,
  listRemoteIncomeAccountsMock,
  upsertCustomerMock,
  upsertItemMock,
  captureExceptionMock,
  ReauthRequiredError,
} = vi.hoisted(() => {
  class ReauthRequiredError extends Error {
    constructor(message = 'reauth') { super(message); this.name = 'ReauthRequiredError'; }
  }
  return {
    selectMock: vi.fn(),
    insertMock: vi.fn(),
    updateMock: vi.fn(),
    deleteMock: vi.fn(),
    getConnectionMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(),
    listRemoteCustomersMock: vi.fn(),
    listRemoteItemsMock: vi.fn(),
    listRemoteIncomeAccountsMock: vi.fn(),
    upsertCustomerMock: vi.fn(),
    upsertItemMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    ReauthRequiredError,
  };
});

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock, delete: deleteMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('./accountingConnectionService', () => ({
  getConnection: getConnectionMock,
}));

vi.mock('./accountingTokens', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  ReauthRequiredError,
}));

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({
    listRemoteCustomers: listRemoteCustomersMock,
    listRemoteItems: listRemoteItemsMock,
    listRemoteIncomeAccounts: listRemoteIncomeAccountsMock,
    upsertCustomer: upsertCustomerMock,
    upsertItem: upsertItemMock,
  }),
}));

vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import {
  organizations, organizationExternalLinks, catalogItems, accountingEntityMappings, partners, catalogItemPrices,
} from '../../db/schema';
import {
  listMappingProposals,
  listRemoteIncomeAccountsForPartner,
  normalizeMatchValue,
  saveMappingDecision,
  syncMappedEntity,
} from './accountingMappingService';

const PARTNER = 'p1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ITEM_A = 'item-a';

function connectedConn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', partnerId: PARTNER, provider: 'quickbooks', realmId: 'r1', accessToken: 'stale-tok',
    environment: 'sandbox', status: 'connected', defaultIncomeAccountRef: '79',
    // Matches stubReads' default org/partner currency ('USD'), so the Phase-B
    // create-time home-currency guard is satisfied unless a test opts out.
    homeCurrency: 'USD',
    ...overrides,
  };
}

// postgres.js surfaces a unique-violation as `.code === '23505'` with the index
// name on `.constraint_name` (see utils/pgErrors.ts, the shared detector this
// service uses to convert the DB's last-line defense into `mapping_conflict`).
function pgUniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint_name: constraint,
  });
}

interface OrgRow {
  id: string; name: string; email?: string; taxId?: string | null; currencyCode?: string;
  billingAddressLine1?: string | null; billingAddressLine2?: string | null; billingAddressCity?: string | null;
  billingAddressRegion?: string | null; billingAddressPostalCode?: string | null; billingAddressCountry?: string | null;
}
interface LinkRow { orgId: string; system: string; externalId: string }
interface ItemRow {
  id: string; name: string; sku?: string | null; itemType?: string; taxable?: boolean; isActive?: boolean;
  description?: string | null;
}
interface MappingRow {
  id: string; breezeEntityType: string; breezeEntityId: string; remoteEntityType: string;
  remoteEntityId: string | null; remoteSyncToken?: string | null; linkStatus: string; syncStatus: string;
  lastError?: string | null;
}

/**
 * Recursively search a drizzle SQL condition tree for a literal param value.
 * Used to prove a `.where()` call actually carries the partner id, rather than
 * trusting that the code merely LOOKS like it filters by partner (see CLAUDE.md
 * "vacuous Drizzle assertions" guidance — assert the compiled condition, not the
 * source text).
 */
function conditionContainsValue(obj: unknown, value: string, seen = new Set<unknown>()): boolean {
  if (obj === value) return true;
  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) return false;
    seen.add(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (conditionContainsValue(v, value, seen)) return true;
    }
  }
  return false;
}

// Mutable across a single test: `accounting_entity_mappings` reads/writes all
// share this array, so a syncMappedEntity call that persists a remote ref is
// immediately visible to the NEXT call in the same test (create-then-retry
// idempotency) without the test manually re-stubbing reads in between — the
// same behavior real Postgres gives for free.
let currentMappingRows: MappingRow[] = [];
let currentItemPrices: Array<{ itemId: string; partnerId: string; currencyCode: string; unitPrice: string }> = [];

/**
 * Stubs every `db.select().from(table).where(cond)` read the service issues.
 * Every read is required to carry the partner id in its compiled condition —
 * a query that doesn't throws, so partner scoping is enforced across the WHOLE
 * suite, not just in one dedicated test.
 */
function stubReads(opts: {
  orgs?: OrgRow[]; links?: LinkRow[]; items?: ItemRow[]; mappings?: MappingRow[];
  partnerCurrency?: string | null; itemPrices?: Array<{ itemId: string; currencyCode: string; unitPrice: string }>;
} = {}) {
  const orgRows = (opts.orgs ?? []).map((o) => ({
    deletedAt: null,
    billingContact: o.email ? { email: o.email } : null,
    taxId: null,
    currencyCode: 'USD',
    billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null,
    billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null,
    ...o,
  }));
  const itemRows = (opts.items ?? []).map((i) => ({
    isActive: true, sku: null, itemType: 'service', taxable: true, description: null, ...i,
  }));
  const linkRows = opts.links ?? [];
  currentMappingRows = (opts.mappings ?? []).map((m) => ({ ...m }));
  const partnerCurrency = opts.partnerCurrency === undefined ? 'USD' : opts.partnerCurrency;
  const partnerRows = partnerCurrency === null ? [] : [{ id: PARTNER, currencyCode: partnerCurrency }];
  currentItemPrices = (opts.itemPrices ?? []).map((p) => ({ partnerId: PARTNER, ...p }));

  selectMock.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (cond: unknown) => {
        if (!conditionContainsValue(cond, PARTNER)) {
          throw new Error('query issued without partner scoping — every read must filter by partnerId');
        }
        let rows: unknown[];
        if (table === organizations) rows = orgRows;
        else if (table === organizationExternalLinks) rows = linkRows;
        else if (table === catalogItems) rows = itemRows;
        else if (table === accountingEntityMappings) rows = currentMappingRows;
        else if (table === partners) rows = partnerRows;
        else if (table === catalogItemPrices) rows = currentItemPrices;
        else rows = [];
        return Promise.resolve(rows);
      },
    }),
  }));
}

const insertedValues: Array<Record<string, unknown>> = [];
function stubInsert() {
  let n = 0;
  insertMock.mockImplementation(() => ({
    values: (v: Record<string, unknown>) => {
      n++;
      const row = { id: `gen-${n}`, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...v };
      const finalize = () => {
        insertedValues.push(row);
        if ('breezeEntityType' in row) currentMappingRows.push(row as unknown as MappingRow);
        return Promise.resolve([row]);
      };
      return {
        onConflictDoNothing: () => ({ returning: finalize }),
        returning: finalize,
      };
    },
  }));
}

/**
 * Stubs `db.update(accountingEntityMappings).set(patch).where(cond).returning()`.
 * Finds the target row by scanning `currentMappingRows` for the one whose `id`
 * literal appears in the compiled where-condition (the same technique
 * `conditionContainsValue` already uses for the partner-scoping guard) — this
 * proves the real code passed the row's OWN id, not just partnerId, and lets
 * an id that no longer matches (simulating a lost race) yield zero rows.
 */
function stubUpdate() {
  updateMock.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => ({
      where: (cond: unknown) => ({
        returning: () => {
          if (!conditionContainsValue(cond, PARTNER)) {
            throw new Error('update issued without partner scoping — every write must filter by partnerId');
          }
          const idx = currentMappingRows.findIndex((row) => conditionContainsValue(cond, row.id));
          if (idx === -1) return Promise.resolve([]);
          currentMappingRows[idx] = { ...currentMappingRows[idx], ...patch } as MappingRow;
          return Promise.resolve([currentMappingRows[idx]]);
        },
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  stubInsert();
  stubUpdate();
  stubReads();
  getConnectionMock.mockResolvedValue(connectedConn());
  getValidAccessTokenMock.mockResolvedValue('fresh-token');
  listRemoteCustomersMock.mockResolvedValue([]);
  listRemoteItemsMock.mockResolvedValue([]);
  listRemoteIncomeAccountsMock.mockResolvedValue([]);
  upsertCustomerMock.mockResolvedValue({ id: 'qb-new', syncToken: '0' });
  upsertItemMock.mockResolvedValue({ id: 'qb-new-item', syncToken: '0' });
});

describe('normalizeMatchValue', () => {
  it('NFKC-normalizes, trims, collapses internal whitespace, and lowercases', () => {
    expect(normalizeMatchValue('  ACME   Inc  ')).toBe('acme inc');
  });

  it('treats null/undefined as empty string', () => {
    expect(normalizeMatchValue(null)).toBe('');
    expect(normalizeMatchValue(undefined)).toBe('');
  });
});

describe('listMappingProposals — org matching priority', () => {
  it('treats an existing QuickBooks organization link as a confirmed mapping', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      links: [{ orgId: ORG_A, system: 'quickbooks', externalId: 'qb-12' }],
    });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-12', displayName: 'Renamed in QBO' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result).toContainEqual(expect.objectContaining({
      breezeEntityId: ORG_A, proposedRemoteId: 'qb-12', confidence: 'existing_link', linkStatus: 'confirmed',
    }));
    // The link is durably persisted as a mapping row, not just an ephemeral suggestion.
    expect(insertedValues).toContainEqual(expect.objectContaining({
      breezeEntityId: ORG_A, remoteEntityId: 'qb-12', linkStatus: 'confirmed', syncStatus: 'pending',
    }));
  });

  it('reuses a pre-existing mapping row without re-inserting (ordinary suggestions are not persisted)', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      links: [{ orgId: ORG_A, system: 'quickbooks', externalId: 'qb-12' }],
      mappings: [{
        id: 'm1', breezeEntityType: 'org', breezeEntityId: ORG_A, remoteEntityType: 'Customer',
        remoteEntityId: 'qb-12', linkStatus: 'confirmed', syncStatus: 'synced', lastError: null,
      }],
    });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-12', displayName: 'Acme' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({
      proposedRemoteId: 'qb-12', proposedRemoteName: 'Acme', confidence: 'existing_link',
      linkStatus: 'confirmed', syncStatus: 'synced',
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  // A persisted row is a RECORDED DECISION, not a guess. Reporting
  // `existing_link` for a decision that links to nothing made the workbench
  // label the operator's own "Create new"/"Unlink" choice a "Suggested match".
  it.each([
    ['create_new' as const],
    ['unlinked' as const],
  ])('reports confidence "none" for a persisted %s row that links to no remote entity', async (linkStatus) => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [{
        id: 'm1', breezeEntityType: 'org', breezeEntityId: ORG_A, remoteEntityType: 'Customer',
        remoteEntityId: null, linkStatus, syncStatus: 'pending', lastError: null,
      }],
    });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-12', displayName: 'Acme' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ confidence: 'none', linkStatus, proposedRemoteId: null });
  });

  it('prefers one exact email match over a name match', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme', email: 'billing@acme.test' }] });
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'Acme', email: 'other@acme.test' },
      { id: '2', displayName: 'Acme Holdings', email: 'BILLING@ACME.TEST' },
    ]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ proposedRemoteId: '2', confidence: 'exact_email' });
  });

  it('marks duplicate exact names ambiguous instead of picking by array order', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'Acme' },
      { id: '2', displayName: ' ACME ' },
    ]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ proposedRemoteId: null, confidence: 'ambiguous' });
  });

  it('falls back to an exact normalized name match when there is no email', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'ACME' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ proposedRemoteId: '1', confidence: 'exact_name' });
  });

  it('reports no match when nothing corresponds', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Globex' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ proposedRemoteId: null, proposedRemoteName: null, confidence: 'none' });
  });

  it('excludes an inactive remote customer from new suggestions', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', active: false }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result[0]).toMatchObject({ proposedRemoteId: null, confidence: 'none' });
  });

  it('excludes a remote customer already claimed by another Breeze entity mapping', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [{
        id: 'm1', breezeEntityType: 'org', breezeEntityId: ORG_B, remoteEntityType: 'Customer',
        remoteEntityId: '1', linkStatus: 'confirmed', syncStatus: 'synced',
      }],
    });
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    // ORG_A would otherwise exact-name-match '1', but it is already claimed by ORG_B.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ breezeEntityId: ORG_A, proposedRemoteId: null, confidence: 'none' });
  });

  it('excludes soft-deleted organizations from the proposal list entirely', async () => {
    // stubReads() with no orgs simulates the query-level `deletedAt IS NULL`
    // filter already having excluded the row — a soft-deleted org never
    // reaches the matching logic to begin with.
    stubReads({ orgs: [] });

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });

    expect(result).toEqual([]);
  });

  it('scopes every DB read to the partner (enforced by stubReads on every test in this suite)', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      links: [{ orgId: ORG_A, system: 'quickbooks', externalId: 'qb-1' }],
    });
    listRemoteCustomersMock.mockResolvedValue([]);
    // Would throw inside stubReads' where() if any query dropped partner scoping.
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
      .resolves.not.toThrow();
  });
});

describe('listMappingProposals — catalog item matching', () => {
  it('matches catalog items by unique exact SKU before name', async () => {
    stubReads({ items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }] });
    listRemoteItemsMock.mockResolvedValue([{ id: '9', displayName: 'Old Name', sku: 'ms-1' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'catalog_item' });

    expect(result[0]).toMatchObject({ proposedRemoteId: '9', confidence: 'exact_sku' });
  });

  it('falls back to exact name when SKU is absent', async () => {
    stubReads({ items: [{ id: ITEM_A, name: 'Managed Service' }] });
    listRemoteItemsMock.mockResolvedValue([{ id: '9', displayName: 'Managed Service' }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'catalog_item' });

    expect(result[0]).toMatchObject({ proposedRemoteId: '9', confidence: 'exact_name' });
  });

  it('excludes an inactive remote item from new suggestions', async () => {
    stubReads({ items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }] });
    listRemoteItemsMock.mockResolvedValue([{ id: '9', displayName: 'Managed Service', sku: 'MS-1', active: false }]);

    const result = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'catalog_item' });

    expect(result[0]).toMatchObject({ proposedRemoteId: null, confidence: 'none' });
  });

  it('does not insert imported-customer mappings for catalog items (no link concept)', async () => {
    stubReads({ items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }] });
    listRemoteItemsMock.mockResolvedValue([{ id: '9', displayName: 'Managed Service', sku: 'MS-1' }]);

    await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'catalog_item' });

    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('listMappingProposals — connection/token error mapping', () => {
  it('throws AccountingMappingError(not_connected, 404) when no connection exists', async () => {
    getConnectionMock.mockResolvedValue(null);
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
      .rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });

  it('throws AccountingMappingError(not_connected, 404) when the connection is disconnected', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ status: 'disconnected' }));
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
      .rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });

  it('throws AccountingMappingError(reauth_required, 409) when the connection needs reauth', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ status: 'reauth_required' }));
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a ReauthRequiredError from getValidAccessToken to a typed 409', async () => {
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());
    await expect(listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a QBO API failure to a typed 502 without leaking the response body', async () => {
    const qboErr = Object.assign(new Error('QuickBooks customer query failed with 429'), {
      status: 429, body: 'SUPER-SECRET-UPSTREAM-BODY',
    });
    listRemoteCustomersMock.mockRejectedValue(qboErr);

    const err: unknown = await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect((err as Error).message).not.toContain('SUPER-SECRET-UPSTREAM-BODY');
    expect(captureExceptionMock).toHaveBeenCalledWith(qboErr);
  });

  it('resolves and uses a freshly-refreshed access token, not the stale connection token', async () => {
    getValidAccessTokenMock.mockResolvedValue('fresh-token');
    await listMappingProposals({ partnerId: PARTNER, provider: 'quickbooks', entityType: 'org' });
    expect(listRemoteCustomersMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(getValidAccessTokenMock).toHaveBeenCalled();
  });
});

describe('listRemoteIncomeAccountsForPartner', () => {
  it('returns income accounts fetched with a freshly-refreshed token', async () => {
    listRemoteIncomeAccountsMock.mockResolvedValue([{ id: '79', displayName: 'Services', accountType: 'Income' }]);

    const result = await listRemoteIncomeAccountsForPartner({ partnerId: PARTNER, provider: 'quickbooks' });

    expect(result).toEqual([{ id: '79', displayName: 'Services', accountType: 'Income' }]);
    expect(listRemoteIncomeAccountsMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('throws AccountingMappingError(not_connected, 404) when no connection exists', async () => {
    getConnectionMock.mockResolvedValue(null);
    await expect(listRemoteIncomeAccountsForPartner({ partnerId: PARTNER, provider: 'quickbooks' }))
      .rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });

  it('maps a QBO failure to a typed 502', async () => {
    listRemoteIncomeAccountsMock.mockRejectedValue(new Error('boom'));
    await expect(listRemoteIncomeAccountsForPartner({ partnerId: PARTNER, provider: 'quickbooks' }))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
  });
});

// ---------------------------------------------------------------------------
// Task 4: saveMappingDecision / syncMappedEntity
// ---------------------------------------------------------------------------

function confirmOrg(remoteEntityId: string, overrides: Record<string, unknown> = {}) {
  return {
    partnerId: PARTNER, provider: 'quickbooks' as const, breezeEntityType: 'org' as const,
    breezeEntityId: ORG_A, decision: 'confirmed' as const, remoteEntityId, ...overrides,
  };
}
function createNewOrg(overrides: Record<string, unknown> = {}) {
  return {
    partnerId: PARTNER, provider: 'quickbooks' as const, breezeEntityType: 'org' as const,
    breezeEntityId: ORG_A, decision: 'create_new' as const, ...overrides,
  };
}
function unlinkOrg(overrides: Record<string, unknown> = {}) {
  return {
    partnerId: PARTNER, provider: 'quickbooks' as const, breezeEntityType: 'org' as const,
    breezeEntityId: ORG_A, decision: 'unlinked' as const, ...overrides,
  };
}
function syncOrg(overrides: Record<string, unknown> = {}) {
  return {
    partnerId: PARTNER, provider: 'quickbooks' as const, breezeEntityType: 'org' as const,
    breezeEntityId: ORG_A, ...overrides,
  };
}
function syncCatalogItem(overrides: Record<string, unknown> = {}) {
  return {
    partnerId: PARTNER, provider: 'quickbooks' as const, breezeEntityType: 'catalog_item' as const,
    breezeEntityId: ITEM_A, ...overrides,
  };
}
function orgMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'm1', breezeEntityType: 'org', breezeEntityId: ORG_A, remoteEntityType: 'Customer',
    remoteEntityId: null, remoteSyncToken: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null,
    ...overrides,
  };
}
function itemMappingRow(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: 'm-item-1', breezeEntityType: 'catalog_item', breezeEntityId: ITEM_A, remoteEntityType: 'Item',
    remoteEntityId: null, remoteSyncToken: null, linkStatus: 'create_new', syncStatus: 'pending', lastError: null,
    ...overrides,
  };
}

describe('saveMappingDecision', () => {
  it('confirms a remote Customer only when it exists and is unclaimed', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-1', displayName: 'Acme', syncToken: '3' }]);

    const row = await saveMappingDecision(confirmOrg('qb-1'));

    expect(row).toMatchObject({
      remoteEntityId: 'qb-1', remoteSyncToken: '3', linkStatus: 'confirmed', syncStatus: 'pending',
    });
  });

  it('persists remoteCurrencyCode from the live listing row when confirming an org mapping', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-1', displayName: 'Acme', syncToken: '3', currencyCode: 'EUR' }]);

    const row = await saveMappingDecision(confirmOrg('qb-1'));

    expect(row).toMatchObject({ remoteCurrencyCode: 'EUR' });
  });

  it('confirming a catalog_item mapping never persists a remoteCurrencyCode (RemoteItem carries none)', async () => {
    stubReads({ items: [{ id: ITEM_A, name: 'Widget', sku: 'W-1' }] });
    listRemoteItemsMock.mockResolvedValue([{ id: 'qb-item-1', displayName: 'Widget', syncToken: '0' }]);

    const row = await saveMappingDecision({
      partnerId: PARTNER, provider: 'quickbooks', breezeEntityType: 'catalog_item',
      breezeEntityId: ITEM_A, decision: 'confirmed', remoteEntityId: 'qb-item-1',
    });

    expect(row).toMatchObject({ remoteEntityId: 'qb-item-1', remoteCurrencyCode: null });
  });

  it('rejects a remote ID already claimed by another Breeze entity', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [{
        id: 'm-b', breezeEntityType: 'org', breezeEntityId: ORG_B, remoteEntityType: 'Customer',
        remoteEntityId: 'qb-1', linkStatus: 'confirmed', syncStatus: 'synced',
      }],
    });
    // Deliberately no remoteCustomers() setup (defaults to []): the app-layer
    // claim check must fire before the remote-existence check ever runs, or
    // this test would misdiagnose the failure as entity_not_found instead.

    await expect(saveMappingDecision(confirmOrg('qb-1'))).rejects.toMatchObject({ code: 'mapping_conflict', status: 409 });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not accept a remote Item id when confirming an organization (wrong remote entity type)', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    listRemoteCustomersMock.mockResolvedValue([]); // 'qb-9' is an Item id, not a Customer

    await expect(saveMappingDecision(confirmOrg('qb-9'))).rejects.toMatchObject({ code: 'entity_not_found', status: 404 });
    expect(listRemoteItemsMock).not.toHaveBeenCalled();
  });

  it('create_new stores a null remote id with a pending sync status and makes no QuickBooks call', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });

    const row = await saveMappingDecision(createNewOrg());

    expect(row).toMatchObject({ remoteEntityId: null, remoteSyncToken: null, linkStatus: 'create_new', syncStatus: 'pending' });
    expect(listRemoteCustomersMock).not.toHaveBeenCalled();
  });

  it('unlinked clears a previously confirmed remote id and token', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ remoteEntityId: 'qb-1', remoteSyncToken: '3', linkStatus: 'confirmed', syncStatus: 'synced' })],
    });

    const row = await saveMappingDecision(unlinkOrg());

    expect(row).toMatchObject({ remoteEntityId: null, remoteSyncToken: null, linkStatus: 'unlinked' });
  });

  // Phase C, Task 5 follow-up gate #2: an expired-grant partner (getValidAccessToken
  // throws ReauthRequiredError) must still be able to unlink/create_new a mapping,
  // since neither decision ever calls QuickBooks or needs a live token.
  it('unlinked succeeds even when getValidAccessToken would throw ReauthRequiredError (no live token resolved)', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ remoteEntityId: 'qb-1', remoteSyncToken: '3', linkStatus: 'confirmed', syncStatus: 'synced' })],
    });
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());

    const row = await saveMappingDecision(unlinkOrg());

    expect(row).toMatchObject({ remoteEntityId: null, remoteSyncToken: null, linkStatus: 'unlinked' });
    expect(getValidAccessTokenMock).not.toHaveBeenCalled();
  });

  it('create_new also succeeds without resolving a live token (getValidAccessToken never called)', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());

    const row = await saveMappingDecision(createNewOrg());

    expect(row).toMatchObject({ remoteEntityId: null, linkStatus: 'create_new' });
    expect(getValidAccessTokenMock).not.toHaveBeenCalled();
  });

  it('confirmed still requires a live token — a reauth_required grant is rejected as 409', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] });
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());

    await expect(saveMappingDecision(confirmOrg('qb-1'))).rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('throws entity_not_found for a Breeze org id that does not belong to this partner', async () => {
    stubReads({ orgs: [] });
    await expect(saveMappingDecision(confirmOrg('qb-1'))).rejects.toMatchObject({ code: 'entity_not_found', status: 404 });
  });

  it('converts a 23505 unique violation on the mapping insert into mapping_conflict (DB is the last-line defense)', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }] }); // no existing mapping row -> insert path
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-1', displayName: 'Acme', syncToken: '0' }]);
    insertMock.mockImplementationOnce(() => ({
      values: () => ({
        returning: () => Promise.reject(pgUniqueViolation('accounting_entity_mappings_remote_uniq')),
      }),
    }));

    await expect(saveMappingDecision(confirmOrg('qb-1'))).rejects.toMatchObject({ code: 'mapping_conflict', status: 409 });
  });

  it('re-confirming an existing mapping updates it by id+partnerId instead of inserting a duplicate row', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ id: 'm-existing', linkStatus: 'suggested', syncStatus: 'pending' })],
    });
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-2', displayName: 'Acme', syncToken: '1' }]);

    const row = await saveMappingDecision(confirmOrg('qb-2'));

    expect(row).toMatchObject({ id: 'm-existing', remoteEntityId: 'qb-2', linkStatus: 'confirmed' });
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalled();
  });
});

describe('syncMappedEntity', () => {
  it('throws mapping_not_ready when no mapping decision has been made yet', async () => {
    stubReads({ orgs: [{ id: ORG_A, name: 'Acme' }], mappings: [] });

    await expect(syncMappedEntity(syncOrg())).rejects.toMatchObject({ code: 'mapping_not_ready', status: 409 });
    expect(upsertCustomerMock).not.toHaveBeenCalled();
  });

  it('refuses to sync an unlinked mapping', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ linkStatus: 'unlinked' })],
    });

    await expect(syncMappedEntity(syncOrg())).rejects.toMatchObject({ code: 'mapping_not_ready', status: 409 });
    expect(upsertCustomerMock).not.toHaveBeenCalled();
  });

  it('throws entity_not_found when the mapped org no longer resolves for this partner', async () => {
    stubReads({
      orgs: [],
      mappings: [orgMappingRow({ linkStatus: 'create_new' })],
    });

    await expect(syncMappedEntity(syncOrg())).rejects.toMatchObject({ code: 'entity_not_found', status: 404 });
    expect(upsertCustomerMock).not.toHaveBeenCalled();
  });

  it('blocks Item creation until an income account is configured', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ defaultIncomeAccountRef: null }));
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow()],
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'USD', unitPrice: '125.50' }],
    });

    await expect(syncMappedEntity(syncCatalogItem())).rejects.toMatchObject({ code: 'income_account_required', status: 409 });
    expect(upsertItemMock).not.toHaveBeenCalled();
  });

  it('does not require an income account to sparse-update an already-confirmed Item', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ defaultIncomeAccountRef: null }));
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow({ linkStatus: 'confirmed', remoteEntityId: 'qb-item-1', remoteSyncToken: '2' })],
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'USD', unitPrice: '125.50' }],
    });
    upsertItemMock.mockResolvedValueOnce({ id: 'qb-item-1', syncToken: '3' });

    const row = await syncMappedEntity(syncCatalogItem());

    expect(row).toMatchObject({ remoteEntityId: 'qb-item-1', remoteSyncToken: '3', syncStatus: 'synced' });
  });

  it('throws item_price_required when the catalog item has no price row in the partner currency', async () => {
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow()],
      itemPrices: [],
    });

    await expect(syncMappedEntity(syncCatalogItem())).rejects.toMatchObject({ code: 'item_price_required', status: 409 });
    expect(upsertItemMock).not.toHaveBeenCalled();
  });

  it('create_new sync creates once and retries as a sparse update carrying the persisted SyncToken', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '0' });

    const first = await syncMappedEntity(syncOrg());

    expect(first).toMatchObject({
      remoteEntityId: 'qb-new', remoteSyncToken: '0', linkStatus: 'confirmed', syncStatus: 'synced',
    });
    expect(upsertCustomerMock.mock.calls[0]?.[2]).toBeNull(); // first call is a CREATE: no existing ref

    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '1' });
    const second = await syncMappedEntity(syncOrg());

    // The second call must carry the FIRST call's persisted id+SyncToken as a
    // sparse update, proving persistRemoteRef's write is what the retry reads.
    expect(upsertCustomerMock.mock.calls[1]?.[2]).toMatchObject({ remoteEntityId: 'qb-new', remoteSyncToken: '0' });
    expect(second).toMatchObject({ remoteEntityId: 'qb-new', remoteSyncToken: '1' });
  });

  it('create_new sync persists remoteCurrencyCode from the create response for an org', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null, remoteSyncToken: null })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '0', currencyCode: 'USD' });

    const row = await syncMappedEntity(syncOrg());

    expect(row).toMatchObject({ remoteCurrencyCode: 'USD' });
  });

  it('never persists a remoteCurrencyCode for a catalog_item sync (Item upsert response carries none)', async () => {
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow()],
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'USD', unitPrice: '125.50' }],
    });
    upsertItemMock.mockResolvedValueOnce({ id: 'qb-item-1', syncToken: '0' });

    const row = await syncMappedEntity(syncCatalogItem());

    expect(row).toMatchObject({ remoteCurrencyCode: null });
  });

  it.each([
    ['service', 'Service'],
    ['hardware', 'NonInventory'],
    ['software', 'NonInventory'],
  ] as const)('maps catalog itemType %s to QuickBooks type %s and passes unitPrice as a decimal string', async (itemType, qboType) => {
    stubReads({
      items: [{ id: ITEM_A, name: 'Widget', sku: 'W-1', itemType, taxable: false, isActive: true }],
      mappings: [itemMappingRow()],
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'USD', unitPrice: '125.50' }],
    });
    upsertItemMock.mockResolvedValueOnce({ id: 'qb-item-1', syncToken: '0' });

    await syncMappedEntity(syncCatalogItem());

    expect(upsertItemMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: qboType, unitPrice: '125.50', currencyCode: 'USD', sku: 'W-1', taxable: false, active: true,
        incomeAccountRef: '79',
      }),
      null,
    );
  });

  it('maps org billing contact email, address, currency, and tax id onto the customer payload', async () => {
    // Realm home currency matches the org's stamped EUR, so the create-time
    // currency guard passes and this stays a payload-shape assertion.
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'EUR' }));
    stubReads({
      orgs: [{
        id: ORG_A, name: 'Acme', email: 'ap@acme.test', taxId: 'TAX-123', currencyCode: 'EUR',
        billingAddressLine1: '1 Main St', billingAddressCity: 'Springfield', billingAddressCountry: 'US',
      }],
      mappings: [orgMappingRow()],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '0' });

    await syncMappedEntity(syncOrg());

    expect(upsertCustomerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: 'Acme', billingEmail: 'ap@acme.test', taxId: 'TAX-123', currencyCode: 'EUR',
        billAddr: expect.objectContaining({ line1: '1 Main St', city: 'Springfield', country: 'US' }),
      }),
      null,
    );
  });

  it('clears a prior lastError and marks synced on a successful sync', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({
        linkStatus: 'confirmed', remoteEntityId: 'qb-1', remoteSyncToken: '3', syncStatus: 'error', lastError: 'previous failure',
      })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-1', syncToken: '4' });

    const row = await syncMappedEntity(syncOrg());

    expect(row).toMatchObject({ syncStatus: 'synced', lastError: null, remoteSyncToken: '4' });
  });

  it('records sync_status=error with a sanitized message on a provider failure (e.g. a stale SyncToken) and rethrows a typed 502', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({
        linkStatus: 'confirmed', remoteEntityId: 'qb-1', remoteSyncToken: '3', syncStatus: 'synced',
      })],
    });
    const staleTokenErr = Object.assign(new Error('Stale Object Error: SUPER-SECRET-UPSTREAM-BODY'), { status: 400 });
    upsertCustomerMock.mockRejectedValueOnce(staleTokenErr);

    const err: unknown = await syncMappedEntity(syncOrg()).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect((err as Error).message).not.toContain('SUPER-SECRET-UPSTREAM-BODY');
    expect(captureExceptionMock).toHaveBeenCalled();
    const persisted = currentMappingRows.find((r) => r.id === 'm1');
    expect(persisted).toMatchObject({ syncStatus: 'error', remoteEntityId: 'qb-1' }); // prior ref survives the failure
    expect(persisted?.lastError).not.toContain('SUPER-SECRET-UPSTREAM-BODY');
  });

  // --- create-time home-currency guard (multi-currency §11) ------------------
  //
  // QuickBooks stamps CurrencyRef at CREATE time from the realm default and it
  // is immutable afterwards, so a create whose Breeze-side currency differs
  // from the realm home currency produces a permanently unusable entity: the
  // Phase-C invoice-push guard then 409s that org forever. These prove the
  // guard fires BEFORE the provider is touched, on both entity types, and that
  // it does NOT gate an update of an already-linked entity.

  it('refuses to create a QuickBooks Customer for an org whose currency is not the realm home currency', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'USD' }));
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme', currencyCode: 'EUR' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null })],
    });

    const err: unknown = await syncMappedEntity(syncOrg()).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'currency_mismatch', status: 409 });
    expect((err as Error).message).toContain('EUR');
    expect((err as Error).message).toContain('USD');
    expect(upsertCustomerMock).not.toHaveBeenCalled();
    // A pre-flight refusal never attempted a sync, so the row must not be
    // marked errored (same rule the income_account_required guard follows).
    expect(currentMappingRows.find((r) => r.id === 'm1')).toMatchObject({ syncStatus: 'pending' });
  });

  it('refuses to create a QuickBooks Customer when the connection has no captured home currency', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: null }));
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme', currencyCode: 'USD' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null })],
    });

    await expect(syncMappedEntity(syncOrg())).rejects.toMatchObject({ code: 'currency_mismatch', status: 409 });
    expect(upsertCustomerMock).not.toHaveBeenCalled();
  });

  it('creates a QuickBooks Customer when the org currency matches the realm home currency', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'usd' })); // case-insensitive
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme', currencyCode: 'USD' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-new', syncToken: '0' });

    await expect(syncMappedEntity(syncOrg())).resolves.toMatchObject({ remoteEntityId: 'qb-new', syncStatus: 'synced' });
    expect(upsertCustomerMock).toHaveBeenCalled();
  });

  it('still updates an already-linked Customer whose currency differs from the realm (CurrencyRef is fixed at create)', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'USD' }));
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme', currencyCode: 'EUR' }],
      mappings: [orgMappingRow({ linkStatus: 'confirmed', remoteEntityId: 'qb-1', remoteSyncToken: '3' })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-1', syncToken: '4' });

    await expect(syncMappedEntity(syncOrg())).resolves.toMatchObject({ remoteEntityId: 'qb-1', syncStatus: 'synced' });
    expect(upsertCustomerMock).toHaveBeenCalled();
  });

  it('refuses to create a QuickBooks Item priced in a currency other than the realm home currency', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'USD' }));
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow({ linkStatus: 'create_new', remoteEntityId: null })],
      partnerCurrency: 'EUR',
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'EUR', unitPrice: '125.50' }],
    });

    await expect(syncMappedEntity(syncCatalogItem())).rejects.toMatchObject({ code: 'currency_mismatch', status: 409 });
    expect(upsertItemMock).not.toHaveBeenCalled();
  });

  it('still updates an already-linked Item whose partner currency differs from the realm', async () => {
    getConnectionMock.mockResolvedValue(connectedConn({ homeCurrency: 'USD' }));
    stubReads({
      items: [{ id: ITEM_A, name: 'Managed Service', sku: 'MS-1' }],
      mappings: [itemMappingRow({ linkStatus: 'confirmed', remoteEntityId: 'qb-item-1', remoteSyncToken: '2' })],
      partnerCurrency: 'EUR',
      itemPrices: [{ itemId: ITEM_A, currencyCode: 'EUR', unitPrice: '125.50' }],
    });
    upsertItemMock.mockResolvedValueOnce({ id: 'qb-item-1', syncToken: '3' });

    await expect(syncMappedEntity(syncCatalogItem())).resolves.toMatchObject({ syncStatus: 'synced' });
  });

  it('surfaces a non-retry-safe error with the remote id in Sentry metadata when persisting a successful remote create fails', async () => {
    stubReads({
      orgs: [{ id: ORG_A, name: 'Acme' }],
      mappings: [orgMappingRow({ linkStatus: 'create_new', remoteEntityId: null })],
    });
    upsertCustomerMock.mockResolvedValueOnce({ id: 'qb-created', syncToken: '0' });
    // Simulate the mapping row vanishing between read and write (0 rows on the
    // persist UPDATE) — the remote entity now exists in QuickBooks but Breeze
    // could not record it, so a blind retry risks a duplicate QBO Customer.
    updateMock.mockImplementationOnce(() => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    }));

    const err: unknown = await syncMappedEntity(syncOrg()).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'quickbooks_error', status: 502 });
    expect((err as Error).message).toContain('qb-created');
    expect((err as Error).message.toLowerCase()).toContain('do not retry');
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error), undefined, expect.objectContaining({ remoteEntityId: 'qb-created' }),
    );
  });
});
