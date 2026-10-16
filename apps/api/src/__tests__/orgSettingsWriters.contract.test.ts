import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * W05 (#8144) ratchet: every writer of `organizations` / `partners` is classified.
 *
 * Three agent hot-path caches (org-agent-update-config, org-topology-flags,
 * org-helper-legacy-settings) are derived from `organizations.settings`,
 * `partners.settings` and the org's `partner_id`. They are invalidated on every
 * API instance only when the writer calls an invalidator; anything else waits
 * out the 60 s TTL. Auditing the writers once by judgment does not stop the
 * next one, so a new file that writes either table fails here until someone
 * decides which kind it is.
 *
 * Agent-relevant writes: `settings.defaults.agentUpdatePolicy`,
 * `settings.defaults.maintenanceWindow`, `settings.defaults.agentVersionPins`,
 * `settings.topologyFeatureFlags`, `settings.helper`, or an org's `partner_id`.
 */
type Classification =
  | { kind: 'invalidates'; via: string }
  | { kind: 'no-agent-settings'; reason: string };

const WRITERS: Record<string, Classification> = {
  'scripts/seed-topology-demo.ts': { kind: 'invalidates', via: 'invalidateAgentOrgSettingsCaches' },
  'src/jobs/partnerTrustJobs.ts': { kind: 'no-agent-settings', reason: 'partners signup-IP classification columns only' },
  'src/modules/mcpInvites/tools/configureDefaults.ts': { kind: 'no-agent-settings', reason: 'partners.settings.riskProfile only (read-modify-write)' },
  'src/routes/admin/abuse.ts': { kind: 'no-agent-settings', reason: 'partners.status only' },
  'src/routes/admin/autopayRollout.ts': { kind: 'no-agent-settings', reason: 'partners.autopayEnabled only' },
  'src/routes/agents/enrollment.ts': { kind: 'no-agent-settings', reason: 'partners.probationEnrollments counter only' },
  'src/routes/agents/mtls.ts': { kind: 'invalidates', via: 'invalidateOrgHelperSettingsCache' },
  'src/routes/auth/verifyEmail.ts': { kind: 'no-agent-settings', reason: 'partners emailVerifiedAt/status, settings.statusMessage/statusAction* only' },
  'src/routes/internal/synthetic.ts': { kind: 'no-agent-settings', reason: 'partners Stripe payment-method columns only' },
  'src/routes/orgs.ts': { kind: 'invalidates', via: 'invalidateAgentOrgSettingsCaches' },
  'src/routes/partnerTrust.ts': { kind: 'no-agent-settings', reason: 'partners.trustReviewRequestedAt only' },
  'src/services/accounting/accountingMappingService.ts': { kind: 'no-agent-settings', reason: 'organizations billing address columns only' },
  'src/services/aiAgents/impactWeights.ts': { kind: 'no-agent-settings', reason: 'partners.aiImpactWeights only' },
  'src/services/aiModels/residency.ts': { kind: 'no-agent-settings', reason: 'partners.settings.ai.residencyRequired only (merge-patch)' },
  'src/services/aiToolsOrgs.ts': { kind: 'no-agent-settings', reason: 'organizations name/status only' },
  'src/services/contacts/compat.ts': { kind: 'no-agent-settings', reason: 'organizations.billingContact only' },
  'src/services/deleteTenant.ts': { kind: 'no-agent-settings', reason: 'partners status/deletedAt only (churn)' },
  'src/services/emailVerification.ts': { kind: 'no-agent-settings', reason: 'partners.emailVerifiedAt only' },
  'src/services/invoiceService.ts': { kind: 'no-agent-settings', reason: 'partners/organizations invoicing, tax and billing columns only' },
  'src/services/monitors/builtInMonitors.ts': { kind: 'no-agent-settings', reason: 'partners.settings.builtInMonitors provisioning marker only' },
  'src/services/monitors/conversion/retirementSweep.ts': { kind: 'no-agent-settings', reason: 'partners.settings.legacyAlertingRetirement marker only' },
  'src/services/orgArchive.ts': { kind: 'no-agent-settings', reason: 'organizations archive lifecycle columns and settings archive markers only' },
  'src/services/orgCurrencyService.ts': { kind: 'no-agent-settings', reason: 'organizations.currencyCode only' },
  'src/services/orgImport/index.ts': { kind: 'no-agent-settings', reason: 'organizations deletedAt/status/name only' },
  'src/services/orgMerge.ts': { kind: 'invalidates', via: 'invalidateMergedOrgHotPathCaches' },
  'src/services/orgOrdering.ts': { kind: 'no-agent-settings', reason: 'partners.settings.organizationOrder only (read-modify-write)' },
  'src/services/partnerActivation.ts': { kind: 'no-agent-settings', reason: 'partners status and settings.statusMessage/statusAction* only' },
  'src/services/partnerTrust.repo.ts': { kind: 'no-agent-settings', reason: 'partners trust-state columns only' },
  'src/services/softwareDownloadPolicy.ts': { kind: 'no-agent-settings', reason: 'organizations.settings.softwareDownloadPolicy only (read-modify-write)' },
  'src/services/tenantCascade.ts': { kind: 'no-agent-settings', reason: 'partners service_management_mode/psa connection reset only' },
  'src/services/tenantOffboarding.ts': { kind: 'no-agent-settings', reason: 'offboarding lifecycle columns and settings archive/merge markers only' },
  'src/services/unassignedPool/incidentActions.ts': { kind: 'no-agent-settings', reason: 'partners.deployKeyEnrollmentEnabled only' },
};

const API_ROOT = join(import.meta.dirname, '..', '..');
const WRITE_PATTERNS = [
  /\.update\(\s*(organizations|partners)\b/,
  /\bUPDATE\s+(?:public\.)?(organizations|partners)\b/i,
];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
}

function writerFiles(): string[] {
  const files: string[] = [];
  walk(join(API_ROOT, 'src'), files);
  walk(join(API_ROOT, 'scripts'), files);
  return files
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      return WRITE_PATTERNS.some((pattern) => pattern.test(source));
    })
    .map((file) => relative(API_ROOT, file).split('\\').join('/'))
    .sort();
}

describe('organizations / partners writers are classified (W05 #8144)', () => {
  const found = writerFiles();

  it('finds the known writers (the walk is not vacuous)', () => {
    expect(found).toContain('src/routes/orgs.ts');
    expect(found.length).toBeGreaterThan(10);
  });

  it('every writer file is classified, and every classified file still writes', () => {
    const unclassified = found.filter((file) => !(file in WRITERS));
    const stale = Object.keys(WRITERS).filter((file) => !found.includes(file));
    expect(
      unclassified,
      `classify each in src/__tests__/orgSettingsWriters.contract.test.ts:\n${unclassified.join('\n')}`,
    ).toEqual([]);
    expect(stale, 'these no longer write organizations/partners; remove them from WRITERS').toEqual([]);
  });

  it('every `invalidates` writer actually calls its invalidator (an import alone does not count)', () => {
    for (const [file, classification] of Object.entries(WRITERS)) {
      if (classification.kind !== 'invalidates') continue;
      const source = readFileSync(join(API_ROOT, file), 'utf8');
      const calls = source.split('\n').filter((line) =>
        line.includes(`${classification.via}(`) && !/^\s*(\/\/|\*|import\b)/.test(line),
      );
      expect(calls.length, `${file} must call ${classification.via}(`).toBeGreaterThan(0);
    }
  });

  it('every `no-agent-settings` row says why', () => {
    for (const [file, classification] of Object.entries(WRITERS)) {
      if (classification.kind === 'no-agent-settings') expect(classification.reason.length, file).toBeGreaterThan(10);
    }
  });
});
