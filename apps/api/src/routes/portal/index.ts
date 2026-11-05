import { Hono, type Context } from 'hono';
import { brandingRoutes } from './branding';
import { authRoutes, portalAuthMiddleware } from './auth';
import { deviceRoutes } from './devices';
import { ticketRoutes, portalTicketsEnabledMiddleware } from './tickets';
import { assetRoutes } from './assets';
import { profileRoutes } from './profile';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';
import { quoteRoutes as portalQuoteRoutes } from './quotes';
import { portalAgreementRoutes } from './agreements';
import { portalSignedAgreementRoutes } from './signedAgreements';
import {
  portalAssetCheckoutEnabledMiddleware,
  portalDevicesEnabledMiddleware,
  createPortalFeatureGateAny,
  portalSectionGate,
  PORTAL_SECTION_GATES,
  type PortalSectionGateRow,
  type PortalSectionKey
} from './featureFlags';
import { portalDashboardRoutes } from './dashboard';
import { portalSecurityRoutes } from './security';
import { portalHardwareHealthRoutes } from './hardwareHealth';
import { portalHardwareInventoryRoutes } from './hardwareInventory';
import { portalPerformanceRoutes } from './performance';
import { portalSoftwareRoutes } from './software';
import { portalPatchRoutes } from './patches';
import { portalVulnerabilityRoutes } from './vulnerabilities';
import { portalBackupRoutes } from './backups';
import { portalReportRoutes } from './reports';
import { portalServiceRoutes } from './service';
import { portalDocumentRoutes } from './documents';
import { portalTrustPageRoutes } from './trustPage';
import { portalNetworkRoutes } from './network';
import { portalHourBlockRoutes } from './hourBlock';
import { portalApprovalRoutes } from './approvals';
import { portalTrustPageLinkRoutes } from './trustPageLink';

export const portalRoutes = new Hono();

const isTicketsUsagePath = (c: Context) => c.req.path.endsWith('/tickets/usage');
const isDocumentContentPath = (c: Context) => /\/documents\/[^/]+\/content$/.test(c.req.path);
const documentsLibraryGate = portalSectionGate('documents');
// Spec §8: a portal-visible document published as delivery evidence is
// downloadable under enable_service even when the library page is off.
const documentBytesGate = createPortalFeatureGateAny('enableDocuments', 'enableService');

// Public routes (no auth required)
portalRoutes.route('/', authRoutes);
// Exact `/branding` requires auth (Task 3.3 — org-scoped projection with the
// five visibility flags); `/branding/:domain` stays public below it because
// this exact-path middleware does not match the wildcard segment.
portalRoutes.use('/branding', portalAuthMiddleware);
portalRoutes.route('/', brandingRoutes);

// Protected routes
portalRoutes.use('/devices/*', portalAuthMiddleware);
portalRoutes.use('/devices/*', portalDevicesEnabledMiddleware);
portalRoutes.use('/assets/*', portalAuthMiddleware);
portalRoutes.use('/assets/*', portalAssetCheckoutEnabledMiddleware);
portalRoutes.use('/profile/*', portalAuthMiddleware);
portalRoutes.use('/invoices/*', portalAuthMiddleware);
portalRoutes.use('/quotes/*', portalAuthMiddleware);
// Agreement signing (#9075 W3a): always on, like proposals and invoices — a
// legal document the MSP sent to this org has no visibility flag to hide it.
// `/x/*` also matches the bare `/x` list path (agreements.gate.test.ts).
portalRoutes.use('/agreements/*', portalAuthMiddleware);
portalRoutes.use('/signed-agreements/*', portalAuthMiddleware);

// Strict visibility gates (W03 Task 3.3 and every later section): fail closed
// on a missing portal_branding row or an explicit false. Auth first, then the
// gate, on each dedicated prefix. Every row comes from the shared
// PORTAL_SECTION_GATES table (#9350) — the staff "Customer view" preview reads
// the same table, so the portal and the preview cannot disagree. Hono stacks
// middleware by matched prefix, so /reports/lifecycle/* runs both the reports
// and the narrower lifecycle gate. Rows with customMount are mounted below.
for (const row of PORTAL_SECTION_GATES as readonly PortalSectionGateRow[]) {
  if (row.customMount) continue;
  const path = row.exact ? row.pathPrefix : `${row.pathPrefix}/*`;
  if (!row.inheritsAuth) portalRoutes.use(path, portalAuthMiddleware);
  portalRoutes.use(path, portalSectionGate(row.key as PortalSectionKey));
}
// Network Visibility has its own fail-closed availability response:
// disabled or missing settings return dataStatus: 'not_enabled'.
portalRoutes.use('/network/*', portalAuthMiddleware);
portalRoutes.use('/documents/*', portalAuthMiddleware);
portalRoutes.use('/documents/*', async (c, next) =>
  isDocumentContentPath(c) ? documentBytesGate(c, next) : documentsLibraryGate(c, next));
// Trust Center W3d: auth here, before the '/' mounts below whose router-wide
// middleware (portalFinancialMutationGuard) reads portalAuth on every POST.
// The editor permission gate lives in the trust-page router itself.
portalRoutes.use('/trust-page', portalAuthMiddleware);
portalRoutes.use('/trust-page/*', portalAuthMiddleware);

// `/tickets/usage` (Part B adds the handler to ticketRoutes) is gated on
// enableSupportUsage, not enableTickets — it must not inherit the general
// `/tickets/*` auth + enable_tickets gate below, and must not hydrate
// portalAuthMiddleware twice. These two exact-path wrappers run first and
// skip straight to `next()` for every other `/tickets/*` request, letting the
// generic middleware below handle those.
portalRoutes.use('/tickets/usage', portalAuthMiddleware);
portalRoutes.use('/tickets/usage', portalSectionGate('ticketUsage'));

portalRoutes.use('/tickets/*', async (c, next) => {
  if (isTicketsUsagePath(c)) {
    return next();
  }
  return portalAuthMiddleware(c, next);
});
// #2345 — org-level enable_tickets gate. MUST come after portalAuthMiddleware
// (needs portalAuth + the org-scoped DB context) and on the same `/tickets/*`
// prefix so all ticket surfaces — including GET /tickets/forms — are covered.
portalRoutes.use('/tickets/*', async (c, next) => {
  if (isTicketsUsagePath(c)) {
    return next();
  }
  return portalTicketsEnabledMiddleware(c, next);
});

// Customer work approval (#4617 W04): a ticketing surface, so it carries the
// same fail-open enable_tickets gate as `/tickets/*` (403
// PORTAL_TICKETS_DISABLED) — no flag of its own. `/approvals/*` also matches
// the bare `/approvals` list path (approvals.gate.test.ts pins both).
portalRoutes.use('/approvals/*', portalAuthMiddleware);
portalRoutes.use('/approvals/*', portalTicketsEnabledMiddleware);

portalRoutes.route('/', deviceRoutes);
portalRoutes.route('/', ticketRoutes);
portalRoutes.route('/', assetRoutes);
portalRoutes.route('/', profileRoutes);
portalRoutes.route('/', portalInvoiceRoutes);
portalRoutes.route('/', portalQuoteRoutes);
portalRoutes.route('/', portalAgreementRoutes);
portalRoutes.route('/', portalSignedAgreementRoutes);
portalRoutes.route('/', portalDashboardRoutes);
portalRoutes.route('/dashboard', portalTrustPageLinkRoutes); // under the /dashboard/* auth + enableDashboard gate
portalRoutes.route('/', portalSecurityRoutes);
portalRoutes.route('/', portalHardwareHealthRoutes);
portalRoutes.route('/', portalHardwareInventoryRoutes);
portalRoutes.route('/', portalPerformanceRoutes);
portalRoutes.route('/', portalSoftwareRoutes);
portalRoutes.route('/', portalPatchRoutes);
portalRoutes.route('/', portalVulnerabilityRoutes);
portalRoutes.route('/', portalBackupRoutes);
portalRoutes.route('/', portalReportRoutes);
portalRoutes.route('/', portalServiceRoutes);
portalRoutes.route('/', portalDocumentRoutes);
// Trust Center W3d: auth is mounted above; the router carries the editor gate.
portalRoutes.route('/trust-page', portalTrustPageRoutes);
portalRoutes.route('/', portalNetworkRoutes);
portalRoutes.route('/', portalHourBlockRoutes);
portalRoutes.route('/', portalApprovalRoutes);
