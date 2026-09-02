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
 * Linkage lives in `organization_external_links` ONLY. The legacy
 * `organizations.accounting_provider` / `accounting_external_id` columns were
 * backfilled into the link table on 2026-08-08 and dropped on 2026-08-18; no
 * reader or writer refers to them any more.
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
  OrgImportErrorCode,
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
    // Called BARE on purpose: `getValidAccessToken` opens its own short system
    // transactions around the QuickBooks refresh fetch and asserts that nothing
    // is already open. Wrapping it (as this once did) turned those into
    // savepoints that held the connection's row lock across the round trip.
    accessToken = await getValidAccessToken(db, conn);
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
    // "Already imported" means a LIVE organization is linked to this customer —
    // `link-match` and nothing else. The two near-misses both disable the row's
    // checkbox in the web UI, so getting this wrong strands the customer with
    // no way to reach the refusal message that explains it:
    //   - a NAME match (`matched-soft-deleted` is reached by name too) is not
    //     linkage at all — an unrelated churned org that merely shares a name;
    //   - a LINK match whose org was since soft-deleted is not importable
    //     either, but it IS re-importable once the tech restores or replaces
    //     it, so it must stay selectable.
    const linked = row?.annotation === 'link-match';
    return {
      ...customer,
      alreadyImported: linked,
      organizationId: linked ? row?.organizationId ?? null : null,
    };
  });
}

const BULK_IMPORT = 'Settings → Organizations → Bulk import';

/**
 * Why a previewed row is not auto-acknowledged. The seam only commits a
 * name-match or a soft-deleted match against an explicit acknowledgement, and
 * this importer has no confirmation UI to collect one — so it refuses and
 * explains. Before the migration onto the seam, a same-named-but-unlinked org
 * silently got a duplicate beside it.
 *
 * The advice must fit the actual situation. Telling a tech to "confirm the
 * match" when the matched org is ALREADY linked to another QuickBooks customer
 * is actively harmful: the link unique index is `(partner_id, system,
 * external_id)`, so confirming adds a SECOND link row and quietly collapses two
 * QuickBooks customers onto one Breeze tenant.
 */
function refusalMessage(customer: RemoteCustomer, row: AnnotatedRow | undefined): string {
  const matched = row?.matchedOrganizationName ?? customer.displayName;

  if (row?.matchedOrganizationLinkedToSystem) {
    return `"${matched}" is already linked to a different QuickBooks customer — `
      + 'resolve the duplicate in QuickBooks, or unlink that organization in Breeze first.';
  }
  if (row?.annotation === 'name-match') {
    return `An organization named "${matched}" already exists but isn't linked to QuickBooks. `
      + `Use ${BULK_IMPORT} to confirm the match, or to create a separate organization.`;
  }
  if (row?.annotation === 'matched-soft-deleted') {
    return row.matchedBy === 'link'
      ? `This customer was imported before and its organization "${matched}" has since been deleted. `
        + `Use ${BULK_IMPORT} to restore it, or to create a separate organization.`
      : `A deleted organization named "${matched}" still matches this customer. `
        + `Use ${BULK_IMPORT} to restore it, or to create a separate organization.`;
  }
  if (row?.conflictReason) return row.conflictReason;
  return `"${customer.displayName}" could not be matched to an organization — refresh the customer list and try again.`;
}

/**
 * How this screen renders each seam error CODE. Switching on the code (not on
 * the message text) is what lets the seam reword its bulk-import copy without
 * silently changing QuickBooks behavior:
 *
 *  - `recheck` — the seam's expectation/link-conflict guards fired, which can
 *    only mean Breeze changed between our preview and our commit. It speaks the
 *    bulk-import UI's language ("re-run preview"), and this screen has no
 *    preview step, so the class collapses into one actionable sentence.
 *  - `conflict` — describes the customer's DATA ("two of your orgs share this
 *    name"). Already human-readable, so it passes through verbatim, but it is
 *    not an incident and must not raise a Sentry event.
 *  - `failure` — a real write failure. Passes through and is captured.
 */
type SeamErrorKind = 'recheck' | 'conflict' | 'failure';

const SEAM_ERROR_KIND: Record<OrgImportErrorCode, SeamErrorKind> = {
  'annotation-changed': 'recheck',
  'match-changed': 'recheck',
  'name-match-unconfirmed': 'recheck',
  'soft-deleted-unconfirmed': 'recheck',
  'external-id-conflict': 'recheck',
  // Describes the customer's DATA — "the org you matched is already linked to
  // QuickBooks under a different id" — not a stale-preview problem, and this
  // importer already declines to offer such matches (see the
  // `matchedOrganizationLinkedToSystem` guard above). Reaching here means the
  // link appeared between annotate and commit, so it is a conflict to show
  // verbatim, not an incident to page on.
  'match-already-linked': 'conflict',
  'row-conflict': 'conflict',
  'write-failed': 'failure',
};

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
    const kind = SEAM_ERROR_KIND[row.code] ?? 'failure';
    const displayName = customer?.displayName ?? row.organization;
    if (kind === 'failure') {
      // Report the ORIGINAL error, not a reconstruction of its message: the
      // seam carries it on a non-enumerable `cause`, so Sentry keeps the stack,
      // the cause chain and the pg SQLSTATE that `.message` alone throws away.
      captureException(
        row.cause instanceof Error ? row.cause : new Error(`[qb-import] ${row.error}`),
      );
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
