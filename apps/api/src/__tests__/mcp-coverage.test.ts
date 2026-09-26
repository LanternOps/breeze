/**
 * #6141 "make it mechanical, like the cascade lists": every route module has an
 * MCP_COVERAGE entry — a tool surface, a design exemption with a reason, or a
 * FROZEN gap entry with an issue ref. A new route file with no entry fails
 * here; a new `gap` entry fails here (gaps may only be burned down).
 * Precedent: __tests__/partner-wide-write-coverage.test.ts (filesystem walk).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { MCP_COVERAGE } from '../services/mcpCoverage';
import { aiTools } from '../services/aiToolNames';
import '../services/aiTools';
import { getAllRegisteredToolNames } from '../services/aiTools';

const ROUTES_DIR = resolve(__dirname, '../routes');
const ROUTE_REGISTRATION = /\.(get|post|put|patch|delete)\(\s*['"`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__') && ROUTE_REGISTRATION.test(readFileSync(p, 'utf8'))) out.push(relative(ROUTES_DIR, p).split('\\').join('/'));
  }
  return out.sort();
}

/** Gap entries as of this wave. This list only SHRINKS. Adding a route module with no tool means writing the tool or a real exemption. */
const FROZEN_GAPS: ReadonlySet<string> = new Set([
  'accessReviews.ts',
  'accounting/index.ts',
  'aiAgentSchedules.ts',
  'aiOperatorTasks.ts',
  'alerts/correlations.ts',
  'alertTemplates/correlations.ts',
  'auditBaselines.ts',
  'backup/bmr.ts',
  'backup/bmrRecoveries.ts',
  'backup/encryption.ts',
  'backup/health.ts',
  'backup/reconcile.ts',
  'backup/verification.ts',
  'backup/vss.ts',
  'billingProfiles.ts',
  'c2c/configs.ts',
  'catalog/enrich.ts',
  'contracts/documents.ts',
  'contracts/generate.ts',
  'contracts/periods.ts',
  'contracts/reports.ts',
  'contracts/templates.ts',
  'devices/actuateElevation.ts',
  'devices/aiOrigin.ts',
  'devices/anomalies.ts',
  'devices/billing.ts',
  'devices/events.ts',
  'devices/function.ts',
  'devices/health.ts',
  'devices/homebrewBootstrap.ts',
  'devices/links.ts',
  'devices/manual.ts',
  'devices/posture.ts',
  'devices/processSamples.ts',
  'devices/software.ts',
  'devices/softwareActions.ts',
  'devices/stats.ts',
  'devices/warranty.ts',
  'devices/watchdogLogs.ts',
  'discoveryAssetProbe.ts',
  'fleetDesign.ts',
  'invoices/evidence.ts',
  'invoices/pdf.ts',
  'invoices/settings.ts',
  'monitoringAssetMetrics.ts',
  'networkKnownGuests.ts',
  'notifications.ts',
  'onedrive.ts',
  'orgAccountReadiness.ts',
  'orgAuditRetentionSettings.ts',
  'orgBillingProfile.ts',
  'orgPortalSettings.ts',
  'orgPortalUsers.ts',
  'orgSummary.ts',
  'orgTicketSettings.ts',
  'packageSearch.ts',
  'partner.ts',
  'partnerLoginBranding.ts',
  'partnerSendingDomains.ts',
  'patchPlan.ts',
  'patchPolicies.ts',
  'pax8.ts',
  'pax8Orders.ts',
  'plugins.ts',
  'policyManagement/actions.ts',
  'reliability.ts',
  'remote/supportSessions.ts',
  'reports/recipients.ts',
  'roles.ts',
  'scriptBundle.ts',
  'security/compliance.ts',
  'security/dashboard.ts',
  'security/policies.ts',
  'security/recommendations.ts',
  'security/recoveryKeys.ts',
  'security/status.ts',
  'snmp.ts',
  'software.ts',
  'softwareInstallMethods.ts',
  'softwareInventory.ts',
  'system.ts',
  'systemTools/eventLogs.ts',
  'tenantVariables.ts',
  'ticketCategories.ts',
  'ticketChecklistTemplates.ts',
  'ticketConfig.ts',
  'tickets/attachments.ts',
  'tickets/bulk.ts',
  'tickets/export.ts',
  'tickets/forms.ts',
  'tickets/ticketResponseTemplates.ts',
  'timeEntries/suggestions.ts',
  'topology/manual.ts',
  'topology/policies.ts',
  'topology/settings.ts',
  'topology/targets.ts',
  'topology/templateApplications.ts',
  'topology/templates.ts',
  'unifi/index.ts',
  'users.ts',
]);

describe('MCP_COVERAGE (route module → tool surface)', () => {
  const modules = walk(ROUTES_DIR);
  const registered = new Set(getAllRegisteredToolNames());

  it('enumerates a realistic number of route modules', () => { expect(modules.length).toBeGreaterThan(120); });

  it('every route module has an entry', () => {
    expect(modules.filter((m) => !(m in MCP_COVERAGE)), 'route modules with no MCP_COVERAGE entry').toEqual([]);
  });
  it('every entry names an existing route module', () => {
    const set = new Set(modules);
    expect(Object.keys(MCP_COVERAGE).filter((k) => !set.has(k)), 'entries for files that do not exist / register no routes').toEqual([]);
  });
  it('every tool named exists in the registry, and tool entries are non-empty', () => {
    const bad: string[] = [];
    for (const [k, e] of Object.entries(MCP_COVERAGE)) if ('tools' in e) {
      if (e.tools.length === 0) bad.push(`${k}: empty tools[]`);
      for (const t of e.tools) if (!registered.has(t)) bad.push(`${k}: unknown tool ${t}`);
    }
    expect(bad).toEqual([]);
  });
  it('gap entries are frozen: none outside FROZEN_GAPS, and FROZEN_GAPS has no stale entry', () => {
    const gaps = Object.entries(MCP_COVERAGE).filter(([, e]) => 'gap' in e).map(([k]) => k);
    expect(gaps.filter((g) => !FROZEN_GAPS.has(g)), 'new gap entries — write the tool or a real exemption').toEqual([]);
    expect([...FROZEN_GAPS].filter((g) => !gaps.includes(g)), 'burned down — delete from FROZEN_GAPS').toEqual([]);
    for (const [, e] of Object.entries(MCP_COVERAGE)) if ('gap' in e) expect(e.gap).toMatch(/^(LanternOps\/breeze)?#\d+$/);
  });
  it('the A-W06 tools cover their route modules', () => {
    expect((MCP_COVERAGE['timeEntries/timeEntries.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_time_entries', 'get_running_timer', 'get_timesheet']));
    expect((MCP_COVERAGE['orgs.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_organizations', 'manage_organizations', 'list_sites', 'get_site']));
    expect((MCP_COVERAGE['discovery.ts'] as { tools: string[] }).tools).toEqual(expect.arrayContaining(['list_network_assets', 'get_network_asset', 'network_discovery']));
    expect(aiTools.size).toBeGreaterThan(150);
  });
});
