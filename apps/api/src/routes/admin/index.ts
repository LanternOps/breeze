import { Hono } from 'hono';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { abuseRoutes } from './abuse';
import { tenantErasureRoutes } from './tenantErasure';
import { tenantExportRoutes } from './tenantExport';
import { desktopFinalizationRoutes } from './desktopFinalization';
import { exchangeRateAdminRoutes } from './exchangeRates';
import { llmProviderCatalogAdminRoutes } from './llmProviderCatalog';
import { aiKillStateAdminRoutes } from './aiKillState';
import { trustAdminRoutes } from './trust';
import { trustActionAdminRoutes } from './trustAct';

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
// No UI (prod has zero platform admins); runbook: docs/deploy/ai-kill-switch.md.
adminRoutes.route('/ai-kill-state', aiKillStateAdminRoutes);
