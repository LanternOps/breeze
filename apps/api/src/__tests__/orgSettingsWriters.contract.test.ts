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
 * The ratchet is per write site: each classified file pins how many write
 * statements it has (`sites`), so a new `.update(organizations)` / `UPDATE
 * organizations` added to an already-classified file fails here too, instead
 * of riding on the file's old classification (#8640).
 *
 * Agent-relevant writes: `settings.defaults.agentUpdatePolicy`,
 * `settings.defaults.maintenanceWindow`, `settings.defaults.agentVersionPins`,
 * `settings.topologyFeatureFlags`, `settings.helper`, or an org's `partner_id`.
 */
type Classification = { sites: number } & (
  | { kind: 'invalidates'; via: string }
  | { kind: 'no-agent-settings'; reason: string }
);

const WRITERS: Record<string, Classification> = {
  'scripts/seed-topology-demo.ts': { sites: 2, kind: 'invalidates', via: 'invalidateAgentOrgSettingsCaches' },
  'src/jobs/partnerTrustJobs.ts': { sites: 2, kind: 'no-agent-settings', reason: 'partners signup-IP classification columns only' },
  'src/modules/mcpInvites/tools/configureDefaults.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.settings.riskProfile only (read-modify-write)' },
  'src/routes/admin/abuse.ts': { sites: 2, kind: 'no-agent-settings', reason: 'partners.status only' },
  'src/routes/admin/autopayRollout.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.autopayEnabled only' },
  'src/routes/agents/enrollment.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.probationEnrollments counter only' },
  'src/routes/agents/mtls.ts': { sites: 3, kind: 'invalidates', via: 'invalidateOrgHelperSettingsCache' },
  'src/routes/auth/verifyEmail.ts': { sites: 3, kind: 'no-agent-settings', reason: 'partners emailVerifiedAt/status, settings.statusMessage/statusAction* only' },
  'src/routes/internal/synthetic.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners Stripe payment-method columns only' },
  'src/routes/alerts/lifecycleDefaults.ts': { sites: 2, kind: 'no-agent-settings', reason: 'alert_* lifecycle columns only (#10765); the agent caches read none of them' },
  'src/routes/connectionHealthSettings.ts': { sites: 2, kind: 'no-agent-settings', reason: 'settings.connectionHealth.customerAdminsNotified only (path-level jsonb_set)' },
  'src/routes/flowLimits.ts': { sites: 2, kind: 'no-agent-settings', reason: 'settings.flows.<limit> only (path-level jsonb_set; Tool Catalog W05 #5220)' },
  'src/routes/orgs.ts': { sites: 6, kind: 'invalidates', via: 'invalidateAgentOrgSettingsCaches' },
  'src/routes/partnerTrust.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.trustReviewRequestedAt only' },
  'src/services/accounting/accountingMappingService.ts': { sites: 1, kind: 'no-agent-settings', reason: 'organizations billing address columns only' },
  'src/services/aiAgents/impactWeights.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.aiImpactWeights only' },
  'src/services/aiModels/residency.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.settings.ai.residencyRequired only (merge-patch)' },
  'src/services/aiToolsOrgs.ts': { sites: 2, kind: 'no-agent-settings', reason: 'organizations name/status only' },
  'src/services/contacts/compat.ts': { sites: 1, kind: 'no-agent-settings', reason: 'organizations.billingContact only' },
  'src/services/deleteTenant.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners status/deletedAt only (churn)' },
  'src/services/emailVerification.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.emailVerifiedAt only' },
  'src/services/invoiceService.ts': { sites: 2, kind: 'no-agent-settings', reason: 'partners/organizations invoicing, tax and billing columns only' },
  'src/services/monitors/builtInMonitors.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.settings.builtInMonitors provisioning marker only' },
  'src/services/monitors/conversion/retirementSweep.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.settings.legacyAlertingRetirement marker only' },
  'src/services/orgArchive.ts': { sites: 3, kind: 'no-agent-settings', reason: 'organizations archive lifecycle columns and settings archive markers only' },
  'src/services/orgCurrencyService.ts': { sites: 1, kind: 'no-agent-settings', reason: 'organizations.currencyCode only' },
  'src/services/orgImport/index.ts': { sites: 2, kind: 'no-agent-settings', reason: 'organizations deletedAt/status/name only' },
  'src/services/orgMerge.ts': { sites: 3, kind: 'invalidates', via: 'invalidateMergedOrgHotPathCaches' },
  'src/services/orgOrdering.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.settings.organizationOrder only (read-modify-write)' },
  'src/services/partnerActivation.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners status and settings.statusMessage/statusAction* only' },
  'src/services/partnerTrust.repo.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners trust-state columns only' },
  'src/services/softwareDownloadPolicy.ts': { sites: 1, kind: 'no-agent-settings', reason: 'organizations.settings.softwareDownloadPolicy only (read-modify-write)' },
  'src/services/tenantCascade.ts': { sites: 3, kind: 'no-agent-settings', reason: 'partners service_management_mode/psa connection reset only' },
  'src/services/tenantOffboarding.ts': { sites: 14, kind: 'no-agent-settings', reason: 'offboarding lifecycle columns and settings archive/merge markers only' },
  'src/services/unassignedPool/incidentActions.ts': { sites: 1, kind: 'no-agent-settings', reason: 'partners.deployKeyEnrollmentEnabled only' },
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

function countWriteSites(source: string): number {
  return WRITE_PATTERNS.reduce(
    (total, pattern) => total + (source.match(new RegExp(pattern.source, `${pattern.flags}g`))?.length ?? 0),
    0,
  );
}

function sourceFiles(): string[] {
  const files: string[] = [];
  walk(join(API_ROOT, 'src'), files);
  walk(join(API_ROOT, 'scripts'), files);
  return files;
}

function rel(file: string): string {
  return relative(API_ROOT, file).split('\\').join('/');
}

/** Write-site count per file that writes `organizations` / `partners`. */
function writerSites(): Map<string, number> {
  const sites = new Map<string, number>();
  for (const file of sourceFiles()) {
    const count = countWriteSites(readFileSync(file, 'utf8'));
    if (count > 0) sites.set(rel(file), count);
  }
  return sites;
}

function writerFiles(): string[] {
  return [...writerSites().keys()].sort();
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

  it('every classified file pins its exact write-site count (per-site ratchet, #8640)', () => {
    const actual = writerSites();
    const drift = Object.entries(WRITERS)
      .filter(([file, classification]) => actual.has(file) && actual.get(file) !== classification.sites)
      .map(([file, classification]) => `${file}: classified ${classification.sites} site(s), found ${actual.get(file)}`);
    expect(
      drift,
      `a write site was added or removed; decide whether it touches agent-relevant settings, then update \`sites\`:\n${drift.join('\n')}`,
    ).toEqual([]);
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

/**
 * A plain `.invalidate()` on a `cluster` cache clears only this process; the
 * other API instances keep serving the old entry until the TTL. Writers must
 * use `invalidateAroundCommit()`, which also announces the drop (#8144).
 */
describe('cluster caches are never invalidated with a plain .invalidate() (#8640)', () => {
  /** Deliberate this-process-only drops: `file: identifier` -> why no cluster announcement is wanted. */
  const LOCAL_ONLY: Record<string, string> = {
    'src/services/trustPage/attestationKeys.ts: keysetCache':
      'signer self-heal after a lost cluster invalidation; re-reads the DB on this instance only',
  };

  const CLUSTER_CACHE_DECL = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*new HotPathTtlCache\b[\s\S]*?\n\}\);?/g;

  function clusterCacheIdentifiers(source: string): string[] {
    return [...source.matchAll(CLUSTER_CACHE_DECL)]
      .filter((match) => /\bcluster:\s*(true|\{)/.test(match[0]))
      .map((match) => match[1]!);
  }

  function plainInvalidations(source: string, identifier: string): string[] {
    const call = new RegExp(`\\b${identifier}\\s*\\.invalidate\\(`);
    return source.split('\n').filter((line) => call.test(line) && !/^\s*(\/\/|\*)/.test(line));
  }

  it('detects the cluster caches (the scan is not vacuous)', () => {
    const found = sourceFiles().flatMap((file) => clusterCacheIdentifiers(readFileSync(file, 'utf8')));
    for (const identifier of [
      'orgAgentUpdateConfigCache',
      'orgTopologyFlagsCache',
      'orgPolicyProbeCache',
      'orgHelperSettingsCache',
      'orgPamFallbackCache',
      'trustKeysetCache',
      'delegationRowsCache',
      'agentCollectorAbsenceCache',
      'keysetCache',
    ]) expect(found).toContain(identifier);
  });

  it('the matcher flags a plain invalidate and ignores invalidateAroundCommit', () => {
    const decl = "export const demoCache = new HotPathTtlCache<string, number>({\n  name: 'demo',\n  cluster: true,\n});\n";
    expect(clusterCacheIdentifiers(decl)).toEqual(['demoCache']);
    expect(plainInvalidations('demoCache.invalidate(orgId);', 'demoCache')).toHaveLength(1);
    expect(plainInvalidations('demoCache.invalidateAroundCommit(orgId);', 'demoCache')).toEqual([]);
    expect(clusterCacheIdentifiers(decl.replace('cluster: true,', ''))).toEqual([]);
  });

  it('no non-test source calls .invalidate( on a cluster cache', () => {
    const files = sourceFiles().map((file) => ({ file, source: readFileSync(file, 'utf8') }));
    const offenders: string[] = [];
    const usedAllowances = new Set<string>();
    for (const { source } of files) {
      for (const identifier of clusterCacheIdentifiers(source)) {
        for (const { file, source: other } of files) {
          for (const line of plainInvalidations(other, identifier)) {
            const allowance = `${rel(file)}: ${identifier}`;
            if (allowance in LOCAL_ONLY) usedAllowances.add(allowance);
            else offenders.push(`${rel(file)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(Object.keys(LOCAL_ONLY).filter((key) => !usedAllowances.has(key)), 'stale LOCAL_ONLY entries; remove them').toEqual([]);
    expect(offenders, `use invalidateAroundCommit() so every API instance drops the entry:\n${offenders.join('\n')}`).toEqual([]);
  });
});
