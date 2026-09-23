import { Hono } from 'hono';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { abuseRoutes } from './abuse';
import { tenantErasureRoutes } from './tenantErasure';
import { tenantExportRoutes } from './tenantExport';
import { desktopFinalizationRoutes } from './desktopFinalization';
import { exchangeRateAdminRoutes } from './exchangeRates';
import { llmProviderCatalogAdminRoutes } from './llmProviderCatalog';
import { aiKillStateAdminRoutes } from './aiKillState';
import { aiToolUsageAdminRoutes } from './aiToolUsage';
import { trustAdminRoutes } from './trust';
import { trustActionAdminRoutes } from './trustAct';
import { adminSendingDomainsRoutes } from './sendingDomains';
import { deprecationsAdminRoutes } from './deprecations';

export const adminRoutes = new Hono();

adminRoutes.use('*', platformAdminMiddleware);
adminRoutes.route('/', abuseRoutes);
adminRoutes.route('/', trustAdminRoutes);
adminRoutes.route('/', trustActionAdminRoutes);
// Task 30 — GDPR org-wide erasure + export.
// Mounted UNDER the platformAdminMiddleware above; tenantErasureRoutes
// adds its own requireMfa() middleware on top.
adminRoutes.route('/tenant-erasure', tenantErasureRoutes);
adminRoutes.route('/tenant-export', tenantExportRoutes);
adminRoutes.route('/desktop-finalizations', desktopFinalizationRoutes);
// Wave 7 (#3779): manual FX overrides. exchange_rates is a GLOBAL table with no
// tenant axis, so a partner-scoped write would move every other partner's
// dashboard — platform-admin only, with MFA on the mutating verbs (same posture
// as tenant-erasure above and third_party_package_catalog).
adminRoutes.route('/exchange-rates', exchangeRateAdminRoutes);
adminRoutes.route('/llm-provider-catalog', llmProviderCatalogAdminRoutes);
// Wave 6 PR 2 (#3828): the AI kill switch's authorized surface. Global row —
// a flip stops unattended AI for every partner, hence platform-admin + MFA.
// UI: apps/web AiKillSwitch.tsx at /admin/ai-kill-switch (#4208). Runbook
// (including the SQL fallback for when no platform admin exists — true of
// production today): docs/deploy/ai-kill-switch.md.
adminRoutes.route('/ai-kill-state', aiKillStateAdminRoutes);
// A-W01 (#6148): read-only cross-tenant AI tool-usage report.
adminRoutes.route('/ai', aiToolUsageAdminRoutes);
// Partner sending domains W03: cross-partner list plus the kill switch
// (suspend / unsuspend / force-release, spec §9.1). Mounted UNDER the
// platform-admin gate above; the router adds its own requireMfa() on each
// mutating verb.
adminRoutes.route('/sending-domains', adminSendingDomainsRoutes);
// #6605 wave 2: read-only deployment deprecations report behind Settings →
// System → Deprecations. Deployment-wide data, so platform-admin only (the
// gate above); the router has no write verb.
adminRoutes.route('/deprecations', deprecationsAdminRoutes);
