/**
 * CONTRACT TESTS — pre-assignment holding org.
 *
 * Org reach: every computation of the orgs a HUMAN caller may reach must exclude
 * the holding org explicitly. For org_access='all' partner users the code
 * returns every active org of the partner, so "never add it" is not enough —
 * the exclusion has to be written. A file that builds such a list (the literal
 * `inArray(organizations.status, ['active', 'trial'])` is the fingerprint) must
 * reference UNASSIGNED_POOL_ORG_TYPE or carry a reasoned exemption.
 *
 * Admission: only allowlisted files may name the parked-device admission GUC. The
 * devices_unassigned_pool_insert_guard trigger refuses a device INSERT into a
 * holding org unless the transaction declared the admission; this list is the
 * complete set of code allowed to declare it.
 *
 * Plain unit test — reads the source tree only. The behavioural proof that each
 * listed computation really leaves the holding org out lives in
 * integration/unassignedPoolReach.integration.test.ts and
 * integration/unassignedPoolGuards.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const SRC = resolve(__dirname, '..');
const EE_SRC = resolve(__dirname, '../../../../ee');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');
const SOURCE = walk(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));

const REACH_FINGERPRINT = "inArray(organizations.status, ['active', 'trial'])";
const REACH_FILES = [
  'middleware/auth.ts',
  'middleware/bearerTokenAuth.ts',
  'middleware/partnerApiAuth.ts',
  'routes/eventWs.ts',
  'services/reportScope.ts',
  'services/aiSessionLiveAuthority.ts',
  // Report-history reach enumerates the partner's inactive orgs by its own
  // status list, so it does not carry the fingerprint above.
  'services/reportHistoryAccess.ts',
  // Raw partner-member reach for orgs outside accessibleOrgIds (suspended,
  // archived); org_access='all' would otherwise reach the holding org.
  'services/partnerOrgSelection.ts',
  // Multi-org report series: the eligible-org set a series targets ('all'
  // mode mints a child in every one of them). targets.ts spreads
  // SERIES_ELIGIBLE_ORG_STATUSES, so it does not carry the fingerprint above.
  'services/reportSeries/targets.ts',
  // Series W04 Combine: candidates and adoption only in series-eligible orgs.
  'services/reportSeries/combine.ts',
  // #7363: partner-wide automation webhook runs under a partner context over
  // the partner's customer orgs.
  'services/automationWebhookContext.ts',
];
/** file -> reason. Add only with a reason a reviewer can check. */
const REACH_EXEMPT: Record<string, string> = {
  'services/autopay/paymentSettingsView.ts': 'Fee authorization gaps positively select customer organizations only; holding organizations cannot match.',
};

describe('holding org is outside every human org-reach computation', () => {
  it.each(REACH_FILES)('%s excludes the holding org (UNASSIGNED_POOL_ORG_TYPE or the hidden-org visibility list)', (file) => {
    const entry = SOURCE.find((s) => s.file === file);
    expect(entry, `${file} not found`).toBeDefined();
    expect(entry!.text).toMatch(/UNASSIGNED_POOL_ORG_TYPE|notHiddenOrgType\(\)/);
  });

  it('the fee authorization gap exemption retains its customer-only predicate',()=>{
    expect(SOURCE.find(s=>s.file==='services/autopay/paymentSettingsView.ts')!.text)
      .toContain("eq(organizations.type, 'customer')");
  });

  it('every file carrying the reach fingerprint is classified', () => {
    const unclassified = SOURCE
      .filter((s) => s.text.includes(REACH_FINGERPRINT))
      .map((s) => s.file)
      .filter((f) => !REACH_FILES.includes(f) && !(f in REACH_EXEMPT));
    expect(unclassified).toEqual([]);
  });
});

const ADMISSION_GUC = 'breeze.parked_device_admission';
const ADMISSION_IDENT = 'PARKED_DEVICE_ADMISSION_GUC';
/** Every non-test file allowed to name the admission GUC. Deploy-key enrollment will add its admission module. */
const ADMISSION_ALLOWLIST = new Set<string>([
  'services/unassignedPool/orgType.ts', // definition only
  'services/unassignedPool/admission.ts', // the one transaction-local declaration helper
]);

describe('only allowlisted code may declare a parked-device admission', () => {
  it('no other API source file names the GUC', () => {
    const offenders = SOURCE
      .filter((s) => s.text.includes(ADMISSION_GUC) || s.text.includes(ADMISSION_IDENT))
      .map((s) => s.file)
      .filter((f) => !ADMISSION_ALLOWLIST.has(f));
    expect(offenders).toEqual([]);
  });

  it('no EE source file names the GUC', () => {
    let eeFiles: string[] = [];
    try { eeFiles = walk(EE_SRC); } catch { eeFiles = []; }
    const offenders = eeFiles.filter((f) => {
      const t = readFileSync(f, 'utf8');
      return t.includes(ADMISSION_GUC) || t.includes(ADMISSION_IDENT);
    });
    expect(offenders).toEqual([]);
  });
});
