import { describe, it, expect, vi, beforeEach } from 'vitest';

// The importer delegates matching/creation to services/orgImport, which shares
// this same `db` mock — so these tests exercise the real seam end-to-end and
// assert on the rows it actually writes.
const {
  selectMock,
  insertMock,
  updateMock,
  getConnectionMock,
  getValidAccessTokenMock,
  listRemoteCustomersMock,
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
    getConnectionMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(),
    listRemoteCustomersMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    ReauthRequiredError,
  };
});
vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock },
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
  getAccountingProvider: () => ({ listRemoteCustomers: listRemoteCustomersMock }),
}));

vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../tenantLifecycle', () => ({ restoreOrganizationTenantAccess: vi.fn() }));

import { organizations, organizationExternalLinks, sites } from '../../db/schema';
import {
  importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated,
} from './quickbooksCustomerImport';

function connectedConn() {
  return { id: 'c1', partnerId: 'p1', provider: 'quickbooks', realmId: 'r1', accessToken: 'tok', environment: 'sandbox', status: 'connected' };
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  type?: string;
  deletedAt?: Date | null;
  accountingProvider?: string | null;
  accountingExternalId?: string | null;
}
interface LinkRow { orgId: string; system: string; externalId: string }

/**
 * Stub the seam's partner-state reads. It loads (organizations, links) once per
 * preview and once per commit, so the rows are keyed by TABLE rather than call
 * order. `laterLinkReads` feeds the reads that come after those two link loads
 * — i.e. the post-unique-violation winner lookup.
 */
function stubState(orgs: OrgRow[] = [], links: LinkRow[] = [], laterLinkReads: unknown[][] = []) {
  const orgRows = orgs.map((o) => ({
    type: 'customer',
    deletedAt: null,
    accountingProvider: null,
    accountingExternalId: null,
    ...o,
  }));
  let linkReads = 0;
  selectMock.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: () => {
        let rows: unknown[];
        if (table === organizations) {
          rows = orgRows;
        } else {
          rows = linkReads >= 2 ? (laterLinkReads.shift() ?? links) : links;
          linkReads++;
        }
        const p = Promise.resolve(rows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
        p.limit = () => Promise.resolve(rows.slice(0, 1));
        return p;
      },
    }),
  }));
}

// Capture insert targets + values; resolve returning() with generated ids.
const insertedValues: Array<{ table: unknown; values: Record<string, unknown> }> = [];
function stubInserts(options: { failOn?: (values: Record<string, unknown>) => Error | null } = {}) {
  let n = 0;
  insertMock.mockImplementation((table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      const err = options.failOn?.(v);
      insertedValues.push({ table, values: v });
      n++;
      const id = `row-${n}`;
      if (err) {
        const rejected = Promise.reject(err);
        rejected.catch(() => {});
        return Object.assign(rejected, { returning: () => Promise.reject(err) });
      }
      const resolved = Promise.resolve([{ id, ...v }]);
      return Object.assign(resolved, { returning: () => Promise.resolve([{ id, ...v }]) });
    },
  }));
}

const orgInserts = () => insertedValues.filter((i) => i.table === organizations).map((i) => i.values);
const linkInserts = () => insertedValues.filter((i) => i.table === organizationExternalLinks).map((i) => i.values);
const siteInserts = () => insertedValues.filter((i) => i.table === sites).map((i) => i.values);

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  stubInserts();
  updateMock.mockImplementation(() => ({ set: () => ({ where: () => Promise.resolve([]) }) }));
  getConnectionMock.mockResolvedValue(connectedConn());
  getValidAccessTokenMock.mockResolvedValue('fresh-token');
});

describe('listQuickbooksCustomersAnnotated', () => {
  it('annotates already-imported customers from the legacy accounting columns (union read)', async () => {
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'A' }, { id: '2', displayName: 'B' },
    ]);
    stubState([{ id: 'org-1', name: 'A', slug: 'a', accountingProvider: 'quickbooks', accountingExternalId: '1' }]);

    const result = await listQuickbooksCustomersAnnotated('p1');

    expect(result).toEqual([
      expect.objectContaining({ id: '1', alreadyImported: true, organizationId: 'org-1' }),
      expect.objectContaining({ id: '2', alreadyImported: false, organizationId: null }),
    ]);
    expect(getValidAccessTokenMock).toHaveBeenCalled();
  });

  it('annotates customers linked only via organization_external_links', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-9', displayName: 'Acme' }]);
    stubState([{ id: 'org-9', name: 'Acme', slug: 'acme' }], [{ orgId: 'org-9', system: 'quickbooks', externalId: 'qb-9' }]);
    const result = await listQuickbooksCustomersAnnotated('p1');
    expect(result[0]).toMatchObject({ alreadyImported: true, organizationId: 'org-9' });
  });

  it('does NOT mark a same-named-but-unlinked org as already imported', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-9', displayName: 'Acme' }]);
    stubState([{ id: 'org-name', name: 'Acme', slug: 'acme' }], []);
    const result = await listQuickbooksCustomersAnnotated('p1');
    // A bare name match is not linkage — the import refuses it rather than
    // pretending the customer is already imported.
    expect(result[0]).toMatchObject({ alreadyImported: false, organizationId: null });
  });

  it('does NOT mark a name-matched SOFT-DELETED org as already imported', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-9', displayName: 'Acme' }]);
    // An unrelated churned org that merely shares the name. Reporting it as
    // already-imported would badge the customer green AND disable its checkbox
    // in the web UI, blocking the import forever with no way to reach the
    // refusal message.
    stubState([{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }], []);
    const result = await listQuickbooksCustomersAnnotated('p1');
    expect(result[0]).toMatchObject({ alreadyImported: false, organizationId: null });
  });

  it('does NOT mark a LINK-matched customer whose org was soft-deleted as already imported', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-9', displayName: 'Acme' }]);
    // Imported before, org deleted since. Reporting it as already-imported
    // disables its checkbox forever — but it IS re-importable once the tech
    // restores or replaces the org, so it must stay selectable.
    stubState(
      [{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }],
      [{ orgId: 'org-dead', system: 'quickbooks', externalId: 'qb-9' }],
    );
    const result = await listQuickbooksCustomersAnnotated('p1');
    expect(result[0]).toMatchObject({ alreadyImported: false, organizationId: null });
  });

  it('throws QbImportError(not_connected) when no connection exists', async () => {
    getConnectionMock.mockResolvedValue(null);
    await expect(listQuickbooksCustomersAnnotated('p1')).rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });
});

describe('importQuickbooksCustomers', () => {
  it('creates an org + site for a new customer, mapping billing + shipping data', async () => {
    listRemoteCustomersMock.mockResolvedValue([{
      id: '1', displayName: 'Acme Co', email: 'ap@acme.test', phone: '555', contactName: 'Jane Doe',
      billAddr: { line1: '1 Bill St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
      shipAddr: { line1: '2 Ship Rd', city: 'Dallas' },
    }]);
    stubState();

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'], actor: { userId: 'u1' } });

    expect(summary.imported).toEqual([{ customerId: '1', displayName: 'Acme Co', organizationId: 'row-1', siteId: 'row-3' }]);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([]);

    expect(orgInserts()[0]).toMatchObject({
      partnerId: 'p1', name: 'Acme Co', slug: 'acme-co', type: 'customer',
      billingContact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
      billingAddressLine1: '1 Bill St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    expect(linkInserts()[0]).toMatchObject({
      orgId: 'row-1', partnerId: 'p1', system: 'quickbooks', externalId: '1', createdBy: 'u1',
    });
    expect(siteInserts()[0]).toMatchObject({
      orgId: 'row-1', name: 'Acme Co',
      address: { addressLine1: '2 Ship Rd', city: 'Dallas' },
      contact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
    });
  });

  it('writes the external link row ONLY — never the legacy accounting columns', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    // The seam owns linkage; the legacy single-valued columns are read-only now
    // (dropped by a follow-up migration).
    expect(orgInserts()[0]).not.toHaveProperty('accountingProvider');
    expect(orgInserts()[0]).not.toHaveProperty('accountingExternalId');
    expect(linkInserts()).toEqual([expect.objectContaining({ system: 'quickbooks', externalId: '1' })]);
  });

  it('falls back to billing address for the site when shipping is absent', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { line1: '1 Bill St', city: 'Austin' } }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(siteInserts()[0]).toMatchObject({ address: { addressLine1: '1 Bill St', city: 'Austin' } });
  });

  it('nulls billingAddressCountry when QB Country is not a 2-char code (char(2) guard)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { country: 'United States' } }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(orgInserts()[0]!.billingAddressCountry).toBeNull();
    // …but the full country is preserved on the site address JSONB (no length cap).
    expect(siteInserts()[0]!.address).toMatchObject({ country: 'United States' });
  });

  it('uppercases a genuine 2-char country code into billingAddressCountry', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { country: 'us' } }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(orgInserts()[0]!.billingAddressCountry).toBe('US');
  });

  it('clamps over-long name + city to the column widths (lossless: full value stays in site JSONB)', async () => {
    const longName = 'N'.repeat(300);
    const longCity = 'C'.repeat(200);
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: longName, billAddr: { city: longCity } }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(orgInserts()[0]!.name).toHaveLength(255);
    expect(orgInserts()[0]!.billingAddressCity).toHaveLength(120);
    expect(siteInserts()[0]!.address).toMatchObject({ city: longCity });
  });

  it('maps QB address region -> site address state key', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { region: 'TX', city: 'Austin' } }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(siteInserts()[0]!.address).toMatchObject({ state: 'TX', city: 'Austin' });
  });

  it('skips customers already linked to an org via the legacy accounting columns', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState([{ id: 'org-9', name: 'Acme', slug: 'acme', accountingProvider: 'quickbooks', accountingExternalId: '1' }]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(summary.imported).toEqual([]);
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-9', reason: 'already_imported' }]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('skips customers linked ONLY via organization_external_links', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState([{ id: 'org-9', name: 'Acme', slug: 'acme' }], [{ orgId: 'org-9', system: 'quickbooks', externalId: '1' }]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-9', reason: 'already_imported' }]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('skips a customer whose link row was created by the CSV/bulk org import (cross-importer)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-77', displayName: 'Acme' }]);
    // Org created by the bulk org-import path (routes/orgs.ts /import): NO
    // legacy accounting_* columns, only an organization_external_links row with
    // system='quickbooks'. It must still match, or QB mints a duplicate org.
    stubState(
      [{ id: 'org-csv', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-csv', system: 'quickbooks', externalId: 'qb-77' }],
    );
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['qb-77'] });
    expect(summary.skipped).toEqual([
      { customerId: 'qb-77', displayName: 'Acme', organizationId: 'org-csv', reason: 'already_imported' },
    ]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('suffixes the slug when the base collides with an existing org slug', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    // A DIFFERENT org owns the slug (name differs, so this is not a name match).
    stubState([{ id: 'org-x', name: 'Acme Holdings', slug: 'acme' }]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(orgInserts()[0]).toMatchObject({ slug: 'acme-2' });
  });

  it('reserves slugs within the batch so two same-named new customers do not collide', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }, { id: '2', displayName: 'Acme' }]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(orgInserts().map((o) => o.slug)).toEqual(['acme', 'acme-2']);
  });

  it('refuses a customer whose name matches an existing UNLINKED org, with a human message', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState([{ id: 'org-existing', name: 'Acme', slug: 'acme' }], []);

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.imported).toEqual([]);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([{
      customerId: '1',
      displayName: 'Acme',
      error: 'An organization named "Acme" already exists but isn\'t linked to QuickBooks. '
        + 'Use Settings → Organizations → Bulk import to confirm the match, or to create a separate organization.',
    }]);
    // The old behavior silently created a SECOND org beside the existing one.
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refuses with DIFFERENT advice when the name-matched org is already linked to another QB customer', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-new', displayName: 'Acme' }]);
    // org-1 is already linked to QuickBooks customer "qb-old". Telling the tech
    // to "confirm the match" would add a SECOND link row for the same org (the
    // unique index is on (partner_id, system, external_id)) and collapse two QB
    // customers onto one tenant.
    stubState(
      [{ id: 'org-1', name: 'Acme', slug: 'acme' }],
      [{ orgId: 'org-1', system: 'quickbooks', externalId: 'qb-old' }],
    );

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['qb-new'] });

    expect(summary.errors).toEqual([{
      customerId: 'qb-new',
      displayName: 'Acme',
      error: '"Acme" is already linked to a different QuickBooks customer — '
        + 'resolve the duplicate in QuickBooks, or unlink that organization in Breeze first.',
    }]);
    expect(summary.errors[0]!.error).not.toContain('Bulk import');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refuses a customer matching a soft-deleted org instead of touching it', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState([{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }], []);

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.imported).toEqual([]);
    expect(summary.errors).toEqual([{
      customerId: '1',
      displayName: 'Acme',
      error: 'A deleted organization named "Acme" still matches this customer. '
        + 'Use Settings → Organizations → Bulk import to restore it, or to create a separate organization.',
    }]);
    expect(insertMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('tells a previously-imported customer that ITS organization was deleted', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: 'qb-9', displayName: 'Acme' }]);
    stubState(
      [{ id: 'org-dead', name: 'Acme', slug: 'acme', deletedAt: new Date() }],
      [{ orgId: 'org-dead', system: 'quickbooks', externalId: 'qb-9' }],
    );
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['qb-9'] });
    expect(summary.errors).toEqual([{
      customerId: 'qb-9',
      displayName: 'Acme',
      error: 'This customer was imported before and its organization "Acme" has since been deleted. '
        + 'Use Settings → Organizations → Bulk import to restore it, or to create a separate organization.',
    }]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('still imports the other customers when one is refused (partial refusal)', async () => {
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'Acme' },
      { id: '2', displayName: 'Globex' },
    ]);
    stubState([{ id: 'org-existing', name: 'Acme', slug: 'acme' }], []);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(summary.errors).toHaveLength(1);
    expect(summary.imported).toEqual([expect.objectContaining({ customerId: '2', displayName: 'Globex' })]);
  });

  it('records a per-customer error and continues with the rest (partial success)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Bad' }, { id: '2', displayName: 'Good' }]);
    stubState();
    stubInserts({ failOn: (v) => (v.name === 'Bad' ? new Error('boom') : null) });
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(summary.errors).toEqual([{ customerId: '1', displayName: 'Bad', error: 'boom' }]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]!.customerId).toBe('2');
    // A genuine failure keeps its Sentry breadcrumb.
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('passes the ORIGINAL error to Sentry, not a rebuilt one (keeps stack + pg code)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState();
    const pgErr = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    stubInserts({ failOn: () => pgErr });

    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(captureExceptionMock).toHaveBeenCalledWith(pgErr);
  });

  it('does not Sentry-report a customer-data conflict', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    // Two live orgs share the name → the seam annotates 'conflict'.
    stubState([
      { id: 'org-1', name: 'Acme', slug: 'acme' },
      { id: 'org-2', name: 'Acme', slug: 'acme-2' },
    ], []);

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]!.error).toContain('Multiple existing organizations are named');
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('classifies seam errors by CODE, so rewording seam copy cannot change behavior', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState();
    // A write failure whose message happens to read like a seam recheck string.
    stubInserts({ failOn: () => new Error('Annotation changed since preview: totally not a recheck') });

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    // Prefix matching would have swallowed this as a benign "changed in Breeze"
    // notice and skipped the Sentry event.
    expect(summary.errors[0]!.error).toContain('totally not a recheck');
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('reports requested ids not present in QuickBooks as errors', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState();
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', 'missing'] });
    expect(summary.errors).toContainEqual({ customerId: 'missing', error: 'Customer not found in QuickBooks' });
    expect(summary.imported).toHaveLength(1);
  });

  it('imports a repeated customer id once', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubState();
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '1'] });
    expect(summary.imported).toHaveLength(1);
    expect(orgInserts()).toHaveLength(1);
  });

  it('passes the freshly-resolved access token (not the stale conn token) to listRemoteCustomers', async () => {
    getValidAccessTokenMock.mockResolvedValue('fresh-token');
    listRemoteCustomersMock.mockResolvedValue([]);
    stubState();
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: [] });
    expect(listRemoteCustomersMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('reclassifies a concurrent link unique-violation as skipped (honors the unique indexes)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    // Third link read = the seam's post-violation winner lookup.
    stubState([], [], [[{ orgId: 'org-dup' }]]);
    const dupErr = Object.assign(new Error('dup'), {
      code: '23505', constraint_name: 'organization_external_links_uniq',
    });
    stubInserts({ failOn: (v) => (v.system === 'quickbooks' ? dupErr : null) });

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-dup', reason: 'already_imported' }]);
  });

  it('reports a concurrent import whose winning org cannot be resolved as a retryable error', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    // The winner lookup comes back empty → the seam skips with a null org id,
    // which must never be reported as an imported/skipped organization.
    stubState([], [], [[]]);
    const dupErr = Object.assign(new Error('dup'), {
      code: '23505', constraint_name: 'organization_external_links_uniq',
    });
    stubInserts({ failOn: (v) => (v.system === 'quickbooks' ? dupErr : null) });

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.skipped).toEqual([]);
    expect(summary.imported).toEqual([]);
    expect(summary.errors).toEqual([{
      customerId: '1',
      displayName: 'Acme',
      error: '"Acme" was imported by another run at the same time and the resulting organization '
        + 'could not be resolved — refresh the customer list to confirm.',
    }]);
  });
});

describe('importQuickbooksCustomers — connection/QBO error mapping', () => {
  it('throws QbImportError(reauth_required, 409) when the connection needs reauth', async () => {
    getConnectionMock.mockResolvedValue({ ...connectedConn(), status: 'reauth_required' });
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a ReauthRequiredError from getValidAccessToken to QbImportError(409)', async () => {
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a QBO API failure to QbImportError(quickbooks_error, 502)', async () => {
    getValidAccessTokenMock.mockResolvedValue('tok');
    listRemoteCustomersMock.mockRejectedValue(new Error('QuickBooks customer query failed with 429'));
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
  });
});
