import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, sites } from '../../db/schema';
import { getConnection } from './accountingConnectionService';
import { getValidAccessToken } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import type { RemoteAddress, RemoteCustomer } from './types';

const PROVIDER = 'quickbooks' as const;

export class QbImportError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'QbImportError';
    this.code = code;
    this.status = status;
  }
}

export interface AnnotatedCustomer extends RemoteCustomer {
  alreadyImported: boolean;
  organizationId: string | null;
}

export interface QbImportSummary {
  imported: Array<{ customerId: string; displayName: string; organizationId: string; siteId: string }>;
  skipped: Array<{ customerId: string; displayName: string; organizationId: string; reason: 'already_imported' }>;
  errors: Array<{ customerId: string; displayName?: string; error: string }>;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
    .replace(/-+$/, ''); // re-trim: the 90-char slice can leave a dangling hyphen
  return slug || 'org';
}

export function generateUniqueSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Resolve the partner's QB connection + a fresh access token, then fetch all
// customers from QuickBooks. These run in SYSTEM context (the connection +
// token-rotation write are partner-axis, not org-scoped) and must be wrapped in
// runOutsideDbContext: this service is called from an authenticated route whose
// handler already runs inside withDbAccessContext, so entering a system context
// without first exiting the request context poisons the pooled connection's
// txn (see CLAUDE.md "withSystemDbAccessContext — call runOutsideDbContext first
// if inside a request").
async function fetchCustomers(partnerId: string): Promise<RemoteCustomer[]> {
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() => getConnection(db, partnerId, PROVIDER)));
  if (!conn || conn.status !== 'connected') {
    throw new QbImportError('QuickBooks is not connected for this partner', 'not_connected', 404);
  }
  const accessToken = await runOutsideDbContext(() => withSystemDbAccessContext(() => getValidAccessToken(db, conn)));
  const customers = await getAccountingProvider(PROVIDER).listRemoteCustomers({ ...conn, accessToken });
  return customers;
}

// Map external id -> { organizationId, slug } for every org already linked to
// this partner's QB realm. Used for dedup + slug-uniqueness. Same system-context
// + runOutsideDbContext rule as fetchCustomers (called from inside a request).
async function loadExistingOrgs(partnerId: string): Promise<{ byExternalId: Map<string, string>; slugs: Set<string> }> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.select({ id: organizations.id, accountingExternalId: organizations.accountingExternalId, slug: organizations.slug })
      .from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), eq(organizations.accountingProvider, PROVIDER)))
  )) as Array<{ id: string; accountingExternalId: string | null; slug: string | null }>;

  const byExternalId = new Map<string, string>();
  const slugs = new Set<string>();
  for (const row of rows) {
    if (row.accountingExternalId) byExternalId.set(row.accountingExternalId, row.id);
    if (row.slug) slugs.add(row.slug);
  }
  return { byExternalId, slugs };
}

export async function listQuickbooksCustomersAnnotated(partnerId: string): Promise<AnnotatedCustomer[]> {
  const customers = await fetchCustomers(partnerId);
  const { byExternalId } = await loadExistingOrgs(partnerId);
  return customers.map((c) => ({
    ...c,
    alreadyImported: byExternalId.has(c.id),
    organizationId: byExternalId.get(c.id) ?? null,
  }));
}

function siteAddressFrom(addr: RemoteAddress | undefined): Record<string, string> | undefined {
  if (!addr) return undefined;
  // Match the web SiteForm convention so imported sites render correctly.
  const out: Record<string, string> = {};
  if (addr.line1) out.addressLine1 = addr.line1;
  if (addr.line2) out.addressLine2 = addr.line2;
  if (addr.city) out.city = addr.city;
  if (addr.region) out.state = addr.region;
  if (addr.postalCode) out.postalCode = addr.postalCode;
  if (addr.country) out.country = addr.country;
  return Object.keys(out).length ? out : undefined;
}

export async function importQuickbooksCustomers(
  input: { partnerId: string; customerIds: string[] }
): Promise<QbImportSummary> {
  const { partnerId, customerIds } = input;
  const customers = await fetchCustomers(partnerId);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const { byExternalId, slugs } = await loadExistingOrgs(partnerId);

  const summary: QbImportSummary = { imported: [], skipped: [], errors: [] };

  for (const customerId of customerIds) {
    const customer = byId.get(customerId);
    if (!customer) {
      summary.errors.push({ customerId, error: 'Customer not found in QuickBooks' });
      continue;
    }

    const existingOrgId = byExternalId.get(customerId);
    if (existingOrgId) {
      summary.skipped.push({ customerId, displayName: customer.displayName, organizationId: existingOrgId, reason: 'already_imported' });
      continue;
    }

    try {
      const slug = generateUniqueSlug(slugify(customer.displayName), slugs);
      slugs.add(slug); // reserve within this batch

      const contact = {
        name: customer.contactName,
        email: customer.email,
        phone: customer.phone,
      };

      const { orgId, siteId } = await runOutsideDbContext(() =>
        withSystemDbAccessContext(async () => {
          const [org] = await db.insert(organizations).values({
            partnerId,
            name: customer.displayName,
            slug,
            type: 'customer' as const,
            billingContact: contact,
            billingAddressLine1: customer.billAddr?.line1 ?? null,
            billingAddressLine2: customer.billAddr?.line2 ?? null,
            billingAddressCity: customer.billAddr?.city ?? null,
            billingAddressRegion: customer.billAddr?.region ?? null,
            billingAddressPostalCode: customer.billAddr?.postalCode ?? null,
            // billing_address_country is char(2). QBO's BillAddr.Country is
            // free-form ("United States", "USA", …); writing a >2-char value
            // would throw and silently drop the whole customer. Only persist a
            // genuine 2-letter code here — the full country is still preserved
            // in the site address JSONB (siteAddressFrom) which has no length cap.
            billingAddressCountry: customer.billAddr?.country?.length === 2
              ? customer.billAddr.country.toUpperCase()
              : null,
            accountingProvider: PROVIDER,
            accountingExternalId: customerId,
          }).returning();
          const [site] = await db.insert(sites).values({
            orgId: org!.id,
            name: customer.displayName,
            address: siteAddressFrom(customer.shipAddr ?? customer.billAddr),
            contact,
          }).returning();
          return { orgId: org!.id as string, siteId: site!.id as string };
        })
      );

      byExternalId.set(customerId, orgId);
      summary.imported.push({ customerId, displayName: customer.displayName, organizationId: orgId, siteId });
    } catch (err) {
      summary.errors.push({ customerId, displayName: customer.displayName, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}
