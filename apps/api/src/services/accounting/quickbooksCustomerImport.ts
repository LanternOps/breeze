/**
 * QuickBooks customer import — a thin adapter over the shared org import seam
 * (`services/orgImport`, issue #3242 / epic #3249).
 *
 * This module owns only what is QuickBooks-specific: connection + token
 * plumbing, the RemoteCustomer → ImportRow mapping, and the translation of the
 * seam's generic summary back into the customer-shaped contract the
 * integrations UI consumes. Matching, slug reservation, org/site creation,
 * link-row persistence and concurrent-import recovery all live in the seam.
 *
 * Linkage is written to `organization_external_links` ONLY — the legacy
 * `organizations.accounting_provider` / `accounting_external_id` columns are no
 * longer written by this importer. Every reader is a union reader in which the
 * link table wins, and the 2026-08-08 backfill shipped; the columns are dropped
 * separately.
 */

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getConnection } from './accountingConnectionService';
import { getValidAccessToken, ReauthRequiredError } from './accountingTokens';
import { getAccountingProvider } from './providerRegistry';
import { captureException } from '../sentry';
import { commitOrgImport, previewOrgImport } from '../orgImport';
import type {
  AnnotatedRow,
  CommitRowInput,
  ImportRow,
  OrgImportActor,
  OrgImportSummary,
} from '../orgImport';
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

export interface AnnotatedCustomer extends RemoteCustomer {
  alreadyImported: boolean;
  organizationId: string | null;
}

export interface QbImportSummary {
  /**
   * `siteId` is nullable only defensively: every created group gets a default
   * site named after the org, so the seam always returns one here.
   */
  imported: Array<{ customerId: string; displayName: string; organizationId: string; siteId: string | null }>;
  skipped: Array<{
    customerId: string;
    displayName: string;
    organizationId: string;
    reason: 'already_imported';
    /** Non-fatal note from the seam (e.g. the link write failed). */
    warning?: string;
  }>;
  errors: Array<{ customerId: string; displayName?: string; error: string }>;
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

/**
 * RemoteCustomer → ImportRow. No `site` field: a group with no sites gets one
 * default site named after the org, which is exactly the "one site per
 * customer" shape this importer has always produced.
 */
function toImportRow(customer: RemoteCustomer): ImportRow {
  return {
    organization: customer.displayName,
    externalId: customer.id,
    externalSystem: PROVIDER,
    // The site keeps the shipping address when QB has one (that is where the
    // techs go), falling back to billing.
    address: siteAddressFrom(customer.shipAddr ?? customer.billAddr),
    contact: { name: customer.contactName, email: customer.email, phone: customer.phone },
    billingAddress: customer.billAddr,
  };
}

export async function listQuickbooksCustomersAnnotated(partnerId: string): Promise<AnnotatedCustomer[]> {
  const customers = await fetchCustomers(partnerId);
  const annotated = await previewOrgImport(customers.map(toImportRow), partnerId);
  return customers.map((customer, i) => {
    const row = annotated[i];
    // "Already imported" means a durable link exists — including one whose org
    // was since soft-deleted. It must be keyed on HOW the row matched, not on
    // the annotation alone: `matched-soft-deleted` is also reached by NAME, and
    // an unrelated churned org named "Acme" would then badge the customer as
    // already imported AND disable its checkbox, blocking it forever. A bare
    // name match is not linkage — the row stays selectable and the import
    // answers with the refusal message below.
    const linked = row?.annotation === 'link-match'
      || (row?.annotation === 'matched-soft-deleted' && row.matchedBy === 'link');
    return {
      ...customer,
      alreadyImported: linked,
      organizationId: linked ? row?.organizationId ?? null : null,
    };
  });
}

const BULK_IMPORT = 'Use Settings → Organizations → Bulk import to review and';

/**
 * Why a previewed row is not auto-acknowledged. The seam only commits a
 * name-match or a soft-deleted match against an explicit acknowledgement, and
 * this importer has no confirmation UI to collect one — so it refuses and
 * points at the bulk-import screen, which does. Before the migration onto the
 * seam, a same-named-but-unlinked org silently got a duplicate beside it.
 */
function refusalMessage(customer: RemoteCustomer, row: AnnotatedRow | undefined): string {
  const matched = row?.matchedOrganizationName ?? customer.displayName;
  if (row?.annotation === 'name-match') {
    return `An organization named "${matched}" already exists but isn't linked to QuickBooks. `
      + `${BULK_IMPORT} confirm the match.`;
  }
  if (row?.annotation === 'matched-soft-deleted') {
    return `An organization named "${matched}" was deleted and still matches this customer. `
      + `${BULK_IMPORT} restore it.`;
  }
  if (row?.conflictReason) return row.conflictReason;
  return `"${customer.displayName}" could not be matched to an organization — refresh the customer list and try again.`;
}

// The seam's expectation/link-conflict errors speak the bulk-import UI's
// language ("re-run preview", "expectedAnnotation"). This screen has no preview
// step, so the whole class — which can only mean "Breeze changed under the
// import between our preview and our commit" — collapses into one actionable
// sentence. Anything else (DB failures) passes through unchanged, as before.
const SEAM_RECHECK_PREFIXES = [
  'Annotation changed since preview',
  'Match changed since preview',
  'Name matches existing organization',
  'Matches soft-deleted organization',
  'External id "',
];

// Seam messages that describe the CUSTOMER DATA rather than a Breeze failure.
// They are already human-readable, so they pass through verbatim — but they
// must not raise a Sentry event: "two of your orgs share a name" is not an
// incident. (A row normally cannot reach commit in conflict, but it can become
// one between our preview and our commit.)
const SEAM_CONFLICT_PREFIXES = [
  'Multiple existing organizations are named',
  'Multiple soft-deleted organizations are named',
  'Organization name "',
  'Missing organization name',
  'Row is in conflict',
];

type SeamErrorKind = 'recheck' | 'conflict' | 'failure';

function classifySeamError(message: string): SeamErrorKind {
  if (SEAM_RECHECK_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'recheck';
  if (SEAM_CONFLICT_PREFIXES.some((prefix) => message.startsWith(prefix))) return 'conflict';
  return 'failure';
}

export async function importQuickbooksCustomers(
  input: { partnerId: string; customerIds: string[]; actor?: OrgImportActor }
): Promise<QbImportSummary> {
  const { partnerId, customerIds } = input;
  const actor: OrgImportActor = input.actor ?? { userId: null };
  const customers = await fetchCustomers(partnerId);
  const byId = new Map(customers.map((c) => [c.id, c]));

  const summary: QbImportSummary = { imported: [], skipped: [], errors: [] };

  // Resolve the requested ids first. A repeated id is ONE customer, not two —
  // the seam would group the duplicate rows onto a single org and report it
  // twice.
  const selected: RemoteCustomer[] = [];
  const seen = new Set<string>();
  for (const customerId of customerIds) {
    if (seen.has(customerId)) continue;
    seen.add(customerId);
    const customer = byId.get(customerId);
    if (!customer) {
      summary.errors.push({ customerId, error: 'Customer not found in QuickBooks' });
      continue;
    }
    selected.push(customer);
  }
  if (selected.length === 0) return summary;

  // Re-derive the annotations server-side: what the browser saw is advisory,
  // and the acknowledgements below must be made against fresh DB state.
  const rows = selected.map(toImportRow);
  const annotated = await previewOrgImport(rows, partnerId);

  const commitRows: CommitRowInput[] = [];
  const commitCustomers: RemoteCustomer[] = [];
  for (const [i, customer] of selected.entries()) {
    const row = annotated[i];
    // Auto-acknowledge ONLY the unambiguous annotations: a brand-new org, or a
    // customer already linked to one. Everything else needs a human.
    if (row && (row.annotation === 'create' || row.annotation === 'link-match')) {
      commitRows.push({
        ...rows[i]!,
        expectedAnnotation: row.annotation,
        ...(row.organizationId ? { expectedOrganizationId: row.organizationId } : {}),
      });
      commitCustomers.push(customer);
      continue;
    }
    summary.errors.push({
      customerId: customer.id,
      displayName: customer.displayName,
      error: refusalMessage(customer, row),
    });
  }
  if (commitRows.length === 0) return summary;

  const result = await commitOrgImport(commitRows, partnerId, actor, 'skip');
  mergeSummary(result, commitCustomers, summary);
  return summary;
}

/**
 * OrgImportSummary → QbImportSummary. The seam reports by row index into the
 * committed rows array, so `commitCustomers[index]` is the originating
 * customer.
 */
function mergeSummary(
  result: OrgImportSummary,
  commitCustomers: RemoteCustomer[],
  summary: QbImportSummary,
): void {
  for (const row of result.imported) {
    const customer = commitCustomers[row.index];
    if (!customer) continue;
    summary.imported.push({
      customerId: customer.id,
      displayName: customer.displayName,
      organizationId: row.organizationId,
      siteId: row.siteId,
    });
  }

  for (const row of result.skipped) {
    const customer = commitCustomers[row.index];
    if (!customer) continue;
    if (!row.organizationId) {
      // `created_concurrently` where the winning link row could not be re-read.
      // Reporting a skip with no organization id would fabricate an identity —
      // report it as a retryable failure instead.
      summary.errors.push({
        customerId: customer.id,
        displayName: customer.displayName,
        error: `"${customer.displayName}" was imported by another run at the same time and the resulting `
          + 'organization could not be resolved — refresh the customer list to confirm.',
      });
      continue;
    }
    summary.skipped.push({
      customerId: customer.id,
      displayName: customer.displayName,
      organizationId: row.organizationId,
      reason: 'already_imported',
      ...(row.warning ? { warning: row.warning } : {}),
    });
  }

  // Defensive: in 'skip' mode the seam only emits `updated` rows for a
  // reactivated soft-deleted match, which this importer never acknowledges.
  for (const row of result.updated) {
    const customer = commitCustomers[row.index];
    if (!customer) continue;
    summary.skipped.push({
      customerId: customer.id,
      displayName: customer.displayName,
      organizationId: row.organizationId,
      reason: 'already_imported',
      ...(row.warning ? { warning: row.warning } : {}),
    });
  }

  for (const row of result.errors) {
    const customer = commitCustomers[row.index];
    const kind = classifySeamError(row.error);
    const displayName = customer?.displayName ?? row.organization;
    if (kind === 'failure') {
      // A real failure (DB error, constraint violation). The seam console.errors
      // the thrown ones; keep the Sentry breadcrumb this importer has always
      // produced, since the only other trace is a string in the response body.
      captureException(new Error(`[qb-import] ${row.error}`));
    }
    summary.errors.push({
      customerId: customer?.id ?? '',
      ...(displayName ? { displayName } : {}),
      error: kind === 'recheck'
        ? `"${displayName ?? 'This customer'}" changed in Breeze while the import was running — `
          + 'refresh the customer list and try again.'
        : row.error,
    });
  }
}
