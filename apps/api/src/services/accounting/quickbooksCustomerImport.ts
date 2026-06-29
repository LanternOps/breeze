import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, sites } from '../../db/schema';
import { getConnection } from './accountingConnectionService';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import { captureException } from '../sentry';
import type { RemoteAddress, RemoteCustomer } from './types';

const PROVIDER = 'quickbooks' as const;

export type QbImportErrorCode = 'not_connected' | 'reauth_required' | 'quickbooks_error';
type QbImportErrorStatus = 400 | 404 | 409 | 502;

// Typed failures the route translates straight to an HTTP status. Narrowing
// `code`/`status` to literals lets the route drop its `as`-cast and makes the
// contract enforced rather than asserted.
export class QbImportError extends Error {
  constructor(
    message: string,
    readonly code: QbImportErrorCode,
    readonly status: QbImportErrorStatus,
  ) {
    super(message);
    this.name = 'QbImportError';
  }
}

// QBO source values can exceed Breeze's billing-address column widths (DisplayName
// up to 500, City/lines up to 255, etc.). Writing an over-long value throws and
// rolls back the whole org+site insert, dropping an otherwise-valid customer. Clamp
// to the column width — the untruncated value is still preserved in the site
// `address` JSONB (no length cap), so this is lossless overall. See orgs.ts widths.
function clamp(value: string | undefined | null, max: number): string | null {
  if (value == null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

// Postgres unique_violation — a concurrent import linked this customer after our
// dedup snapshot. The partial unique index is the backstop; treat it as a skip.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
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
// customers from QuickBooks. These DB ops run in SYSTEM context (the connection
// + token-rotation write are partner-axis, not org-scoped). Both routes that
// reach here opt out of the auth middleware's auto request-transaction (see
// SELF_MANAGED_DB_CONTEXT_ROUTES), so the handler runs with NO ambient DB
// context — the runOutsideDbContext wrapper is therefore a defensive no-op that
// keeps this correct if ever called from inside a request, and
// withSystemDbAccessContext supplies the system RLS context each short op needs.
async function fetchCustomers(partnerId: string): Promise<RemoteCustomer[]> {
  const conn = await runOutsideDbContext(() => withSystemDbAccessContext(() => getConnection(db, partnerId, PROVIDER)));
  if (!conn) {
    throw new QbImportError('QuickBooks is not connected for this partner', 'not_connected', 404);
  }
  // A previously-connected partner whose token was revoked/expired is NOT the
  // same as never-connected: the remediation is "reconnect", not "connect".
  if (conn.status === 'reauth_required') {
    throw new QbImportError('QuickBooks needs to be reconnected', 'reauth_required', 409);
  }
  if (conn.status !== 'connected') {
    throw new QbImportError('QuickBooks is not connected for this partner', 'not_connected', 404);
  }
  // getValidAccessToken can flip a live-looking connection to reauth_required and
  // throw when the refresh token is dead — surface that as a typed 409 the web can
  // turn into a "Reconnect QuickBooks" CTA, instead of an opaque 500.
  let accessToken: string;
  try {
    accessToken = await runOutsideDbContext(() => withSystemDbAccessContext(() => getValidAccessToken(db, conn)));
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      throw new QbImportError('QuickBooks needs to be reconnected', 'reauth_required', 409);
    }
    throw err;
  }
  try {
    return await getAccountingProvider(PROVIDER).listRemoteCustomers({ ...conn, accessToken });
  } catch (err) {
    // QBO API failures (401/403/429/5xx, unparseable body) are upstream, not a
    // Breeze bug — map to a typed 502 so the route doesn't 500 + Sentry-spam.
    captureException(err instanceof Error ? err : new Error(String(err)));
    throw new QbImportError('QuickBooks returned an error while listing customers', 'quickbooks_error', 502);
  }
}

// Map external id -> { organizationId, slug } for every org already linked to
// this partner's QB realm. Used for dedup + slug-uniqueness. Same self-managed
// system-context rule as fetchCustomers (the routes opt out of the request tx).
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
            // name is NOT NULL; clamp() can only shorten a present string here.
            name: clamp(customer.displayName, 255)!,
            slug,
            type: 'customer' as const,
            billingContact: contact,
            billingAddressLine1: clamp(customer.billAddr?.line1, 255),
            billingAddressLine2: clamp(customer.billAddr?.line2, 255),
            billingAddressCity: clamp(customer.billAddr?.city, 120),
            billingAddressRegion: clamp(customer.billAddr?.region, 120),
            billingAddressPostalCode: clamp(customer.billAddr?.postalCode, 40),
            // billing_address_country is char(2). QBO's BillAddr.Country is
            // free-form ("United States", "USA", …); only persist a genuine
            // 2-letter code — the full country still survives in the site
            // address JSONB (siteAddressFrom) which has no length cap.
            billingAddressCountry: customer.billAddr?.country?.length === 2
              ? customer.billAddr.country.toUpperCase()
              : null,
            accountingProvider: PROVIDER,
            accountingExternalId: customerId,
          }).returning();
          const [site] = await db.insert(sites).values({
            orgId: org!.id,
            name: clamp(customer.displayName, 255)!,
            address: siteAddressFrom(customer.shipAddr ?? customer.billAddr),
            contact,
          }).returning();
          return { orgId: org!.id as string, siteId: site!.id as string };
        })
      );

      byExternalId.set(customerId, orgId);
      summary.imported.push({ customerId, displayName: customer.displayName, organizationId: orgId, siteId });
    } catch (err) {
      // A concurrent import already linked this customer (partial unique index)
      // — honor the documented "skip dupes" contract instead of reporting a raw
      // constraint error. Re-read the winning org id under system context.
      if (isUniqueViolation(err)) {
        const existing = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          db.select({ id: organizations.id }).from(organizations).where(and(
            eq(organizations.partnerId, partnerId),
            eq(organizations.accountingProvider, PROVIDER),
            eq(organizations.accountingExternalId, customerId),
          )).limit(1)
        )) as Array<{ id: string }>;
        if (existing[0]) {
          byExternalId.set(customerId, existing[0].id);
          summary.skipped.push({ customerId, displayName: customer.displayName, organizationId: existing[0].id, reason: 'already_imported' });
          continue;
        }
      }
      // Log + Sentry before collecting: the only other trace is a string in the
      // response body, and a broad catch can also surface a systemic failure
      // (e.g. DB outage) as a per-customer error — keep it observable.
      console.error('[qb-import] failed to import customer', { partnerId, customerId, error: err instanceof Error ? err.message : String(err) });
      captureException(err instanceof Error ? err : new Error(String(err)));
      summary.errors.push({ customerId, displayName: customer.displayName, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return summary;
}
