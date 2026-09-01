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
  }),
}));

vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { organizations, organizationExternalLinks, catalogItems, accountingEntityMappings } from '../../db/schema';
import {
  listMappingProposals,
  listRemoteIncomeAccountsForPartner,
  normalizeMatchValue,
} from './accountingMappingService';

const PARTNER = 'p1';
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const ITEM_A = 'item-a';

function connectedConn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', partnerId: PARTNER, provider: 'quickbooks', realmId: 'r1', accessToken: 'stale-tok',
    environment: 'sandbox', status: 'connected', ...overrides,
  };
}

interface OrgRow { id: string; name: string; email?: string }
interface LinkRow { orgId: string; system: string; externalId: string }
interface ItemRow { id: string; name: string; sku?: string | null }
interface MappingRow {
  id: string; breezeEntityType: string; breezeEntityId: string; remoteEntityType: string;
  remoteEntityId: string | null; linkStatus: string; syncStatus: string; lastError?: string | null;
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

/**
 * Stubs every `db.select().from(table).where(cond)` read the service issues.
 * Every read is required to carry the partner id in its compiled condition —
 * a query that doesn't throws, so partner scoping is enforced across the WHOLE
 * suite, not just in one dedicated test.
 */
function stubReads(opts: { orgs?: OrgRow[]; links?: LinkRow[]; items?: ItemRow[]; mappings?: MappingRow[] } = {}) {
  const orgRows = (opts.orgs ?? []).map((o) => ({
    deletedAt: null,
    billingContact: o.email ? { email: o.email } : null,
    ...o,
  }));
  const itemRows = (opts.items ?? []).map((i) => ({ isActive: true, sku: null, ...i }));
  const linkRows = opts.links ?? [];
  const mappingRows = opts.mappings ?? [];

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
        else if (table === accountingEntityMappings) rows = mappingRows;
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
    values: (v: Record<string, unknown>) => ({
      onConflictDoNothing: () => ({
        returning: () => {
          n++;
          const row = { id: `gen-${n}`, lastError: null, createdAt: new Date(), updatedAt: new Date(), ...v };
          insertedValues.push(row);
          return Promise.resolve([row]);
        },
      }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  stubInsert();
  stubReads();
  getConnectionMock.mockResolvedValue(connectedConn());
  getValidAccessTokenMock.mockResolvedValue('fresh-token');
  listRemoteCustomersMock.mockResolvedValue([]);
  listRemoteItemsMock.mockResolvedValue([]);
  listRemoteIncomeAccountsMock.mockResolvedValue([]);
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
