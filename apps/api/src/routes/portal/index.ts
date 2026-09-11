import { Hono, type Context } from 'hono';
import { brandingRoutes } from './branding';
import { authRoutes, portalAuthMiddleware } from './auth';
import { deviceRoutes } from './devices';
import { ticketRoutes, portalTicketsEnabledMiddleware } from './tickets';
import { assetRoutes } from './assets';
import { profileRoutes } from './profile';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';
import { quoteRoutes as portalQuoteRoutes } from './quotes';
import {
  portalAssetCheckoutEnabledMiddleware,
  portalSelfServiceEnabledMiddleware,
  createPortalFeatureGateStrict,
  createPortalFeatureGateAny
} from './featureFlags';
import { portalDashboardRoutes } from './dashboard';
import { portalSecurityRoutes } from './security';
import { portalBackupRoutes } from './backups';
import { portalReportRoutes } from './reports';
import { portalServiceRoutes } from './service';
import { portalDocumentRoutes } from './documents';

export const portalRoutes = new Hono();

const isTicketsUsagePath = (c: Context) => c.req.path.endsWith('/tickets/usage');
const isDocumentContentPath = (c: Context) => /\/documents\/[^/]+\/content$/.test(c.req.path);
const documentsLibraryGate = createPortalFeatureGateStrict('enableDocuments');
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
portalRoutes.use('/devices/*', portalSelfServiceEnabledMiddleware);
portalRoutes.use('/assets/*', portalAuthMiddleware);
portalRoutes.use('/assets/*', portalAssetCheckoutEnabledMiddleware);
portalRoutes.use('/profile/*', portalAuthMiddleware);
portalRoutes.use('/invoices/*', portalAuthMiddleware);
portalRoutes.use('/quotes/*', portalAuthMiddleware);

// W03 strict visibility gates (Task 3.3) — fail closed on a missing
// portal_branding row or an explicit false. Auth first, then the gate, on
// each dedicated prefix.
portalRoutes.use('/dashboard/*', portalAuthMiddleware);
portalRoutes.use('/dashboard/*', createPortalFeatureGateStrict('enableDashboard'));
portalRoutes.use('/security/*', portalAuthMiddleware);
portalRoutes.use('/security/*', createPortalFeatureGateStrict('enableSecurity'));
portalRoutes.use('/backups/*', portalAuthMiddleware);
portalRoutes.use('/backups/*', createPortalFeatureGateStrict('enableBackups'));
portalRoutes.use('/reports/*', portalAuthMiddleware);
portalRoutes.use('/reports/*', createPortalFeatureGateStrict('enableReports'));
// Service deliverables W04 — both new surfaces fail closed the same way.
portalRoutes.use('/service/*', portalAuthMiddleware);
portalRoutes.use('/service/*', createPortalFeatureGateStrict('enableService'));
portalRoutes.use('/documents/*', portalAuthMiddleware);
portalRoutes.use('/documents/*', async (c, next) =>
  isDocumentContentPath(c) ? documentBytesGate(c, next) : documentsLibraryGate(c, next));

// `/tickets/usage` (Part B adds the handler to ticketRoutes) is gated on
// enableSupportUsage, not enableTickets — it must not inherit the general
// `/tickets/*` auth + enable_tickets gate below, and must not hydrate
// portalAuthMiddleware twice. These two exact-path wrappers run first and
// skip straight to `next()` for every other `/tickets/*` request, letting the
// generic middleware below handle those.
portalRoutes.use('/tickets/usage', portalAuthMiddleware);
portalRoutes.use('/tickets/usage', createPortalFeatureGateStrict('enableSupportUsage'));

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

portalRoutes.route('/', deviceRoutes);
portalRoutes.route('/', ticketRoutes);
portalRoutes.route('/', assetRoutes);
portalRoutes.route('/', profileRoutes);
portalRoutes.route('/', portalInvoiceRoutes);
portalRoutes.route('/', portalQuoteRoutes);
portalRoutes.route('/', portalDashboardRoutes);
portalRoutes.route('/', portalSecurityRoutes);
portalRoutes.route('/', portalBackupRoutes);
portalRoutes.route('/', portalReportRoutes);
portalRoutes.route('/', portalServiceRoutes);
portalRoutes.route('/', portalDocumentRoutes);
