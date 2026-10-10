/**
 * CONTRACT TEST — the holding org is hidden wherever Quick Support is.
 *
 * Quick Support and the pre-assignment holding org are both real
 * `organizations` rows that people must never see: not listed, counted,
 * reported, billed, offered in a picker or chosen as a default org. The
 * shared visibility helpers live in services/unassignedPool/visibility.ts.
 *
 * Discovery (comments stripped), over every non-test file under routes/ and
 * services/: a Quick Support org-type literal in code (`'quick_support'`) or
 * a use of the visibility helpers.
 * Each such file must be exactly one of:
 *   - an execution module already pinned by parkedFanout.contract.test.ts
 *     (FANOUT_MODULES) — it keeps its Quick Support exclusion plus the parked
 *     predicate, and is skipped here;
 *   - EXECUTION_SITES — a route/service that selects targets for work: it
 *     keeps its Quick Support literal and must carry at least as many
 *     parked-device guards (selectorPredicate.ts / UNASSIGNED_POOL_ORG_TYPE)
 *     as it has Quick Support exclusions;
 *   - QUICK_SUPPORT_SPECIFIC — logic about Quick Support itself (not an org
 *     enumeration), with a reason;
 *   - otherwise a VISIBILITY site: it may not use a bare Quick Support
 *     exclusion at all and must use the visibility helpers instead.
 * A stale entry (file gone, or no longer discovered) fails.
 *
 * Plain unit test — reads the source tree only. Behavioural proof for the
 * org-reach computations is in integration/unassignedPoolReach.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { FANOUT_MODULES } from './parkedFanoutModules';

const SRC = resolve(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const read = (file: string) => stripComments(readFileSync(join(SRC, file), 'utf8'));
const rel = (f: string) => relative(SRC, f).replace(/\\/g, '/');
const FILES = [...walk(join(SRC, 'routes')), ...walk(join(SRC, 'services'))].map(rel);

const QS_LITERAL = /'quick_support'/g;
const HAS_QS_LITERAL = /'quick_support'/;
const VISIBILITY_HELPER = /\b(?:notHiddenOrgType|notInHiddenOrgCondition|isHiddenOrgType|HIDDEN_ORG_TYPES)\b/;
const PARKED_GUARD = /\b(?:notParkedDeviceCondition|notInHoldingOrgCondition|notHoldingOrgCondition|isParkedDevice|isUnassignedPoolOrgType)\(|\bUNASSIGNED_POOL_ORG_TYPE\b/g;

const count = (code: string, re: RegExp) => (code.match(re) ?? []).length;
const withoutImports = (code: string) => code.replace(/^import[\s\S]*?;\s*$/gm, '');

/** Select targets for work; keep the Quick Support literal plus a parked guard. */
const EXECUTION_SITES: Record<string, string> = {
  'routes/peripheralControl.ts': 'partner-wide peripheral policy target orgs',
  'routes/sensitiveData.ts': 'scheduled sensitive-data scan targets must fit the owner',
};

/** About Quick Support itself, not an enumeration of orgs a person sees. */
const QUICK_SUPPORT_SPECIFIC: Record<string, string> = {
  'services/quickSupportOrg.ts': 'the Quick Support org helpers themselves',
  'services/timeSuggestionService.ts': 'attributes Quick Support session time to the customer org; a parked device never has a session',
  'services/orgArchive.ts': 'protected lifecycle: already refuses both types (NON_ARCHIVABLE_ORG_TYPES)',
  'services/orgMerge.ts': 'protected lifecycle: Quick Support merge refusal; the holding org is refused separately',
  'services/vulnerabilityCorrelation.ts': 'skips ephemeral Quick Support devices during correlation; org lists come from feature resolution',
  'services/unassignedPool/assignParkedDevice.ts': 'assignment refuses both hidden types as a destination',
  'services/unassignedPool/visibility.ts': 'the visibility list itself',
};

describe('contract: the holding org is hidden wherever Quick Support is', () => {
  const discovered = FILES.filter((f) => HAS_QS_LITERAL.test(read(f)) || VISIBILITY_HELPER.test(read(f))).sort();

  it('discovers the expected shape of the tree (not vacuous)', () => {
    expect(discovered.length).toBeGreaterThan(20);
    for (const f of ['routes/orgs.ts', 'routes/mcpServer.ts', 'services/auditOrgResolver.ts', 'routes/partnerApi/organizations.ts']) {
      expect(discovered, f).toContain(f);
    }
  });

  it('every visibility site uses the visibility helpers and no bare Quick Support exclusion', () => {
    const offenders = discovered
      .filter((f) => !(f in FANOUT_MODULES) && !(f in EXECUTION_SITES) && !(f in QUICK_SUPPORT_SPECIFIC))
      .map((f) => ({ file: f, quickSupportLiterals: count(read(f), QS_LITERAL), usesHelper: VISIBILITY_HELPER.test(read(f)) }))
      .filter(({ quickSupportLiterals, usesHelper }) => quickSupportLiterals > 0 || !usesHelper);
    expect(offenders, 'replace the Quick Support exclusion with notHiddenOrgType() / notInHiddenOrgCondition() / isHiddenOrgType()').toEqual([]);
  });

  it('every execution site carries a parked guard per Quick Support exclusion', () => {
    const short = Object.keys(EXECUTION_SITES)
      .map((f) => {
        const code = withoutImports(read(f));
        return { file: f, quickSupport: count(code, QS_LITERAL), parkedGuards: count(code, PARKED_GUARD) };
      })
      .filter(({ quickSupport, parkedGuards }) => parkedGuards < quickSupport);
    expect(short).toEqual([]);
  });

  it('execution sites never decide with the visibility list', () => {
    const offenders = Object.keys(EXECUTION_SITES).filter((f) => VISIBILITY_HELPER.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('has no stale entries', () => {
    const listed = [...Object.keys(EXECUTION_SITES), ...Object.keys(QUICK_SUPPORT_SPECIFIC)];
    expect(listed.filter((f) => !existsSync(join(SRC, f)))).toEqual([]);
    expect(listed.filter((f) => !discovered.includes(f))).toEqual([]);
  });
});

/**
 * Part two — device counts and listings.
 *
 * Quick Support devices are also hidden device-by-device with an
 * `is_ephemeral = false` filter. A parked device is not ephemeral, so such a
 * filter alone lets it through wherever the caller's org reach includes the
 * holding org (system scope). Discovery, over routes/, services/ and jobs/:
 * every ephemeral-device filter in code. Each occurrence must have a
 * parked/hidden-org guard within PAIR_WINDOW lines of it, unless the file is
 * an execution module (FANOUT_MODULES, pinned by the fanout contract) or is
 * classified in EPHEMERAL_ONLY with a reason. The discovered-file count is
 * pinned, so a file cannot drop out of (or join) the scan unnoticed.
 */
const EPHEMERAL_FILTER = /eq\(\s*devices\.isEphemeral,\s*false\s*\)|is_ephemeral\s*=\s*false|excludeEphemeralDevices\(/gi;
const PAIRED_GUARD = /\b(?:notParkedDeviceCondition|notInHoldingOrgCondition|notHoldingOrgCondition|isParkedDevice|isUnassignedPoolOrgType|notHiddenOrgType|notInHiddenOrgCondition|isHiddenOrgType)\(|\bUNASSIGNED_POOL_ORG_TYPE\b/;
const PAIR_WINDOW = 8;
const DEVICE_FILES = [...FILES, ...walk(join(SRC, 'jobs')).map(rel)];

/** Ephemeral-only filters where a parked device cannot appear, or must. */
const EPHEMERAL_ONLY: Record<string, string> = {
  'routes/agents/enrollment.ts': 'enrollment identity match for a new agent; deploy-key enrollment owns its own admission',
  'routes/partnerApi/deviceStatus.ts': 'partner API reach (partnerApiAuth) never includes the holding org; same org set as /devices',
  'routes/partnerApi/devices.ts': 'partner API reach (partnerApiAuth) never includes the holding org',
  'routes/portal/assets.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/deviceReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/hardwareHealthReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/hardwareInventoryReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/performanceReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/securityReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/portal/backupReadModel.ts': 'portal users belong to one customer org, never a holding org',
  'services/quickSupportOrg.ts': 'the Quick Support helpers themselves',
  'services/unassignedPool/assignParkedDeviceSteps.ts': 'identity collisions in the assignment destination, a real customer org',
  'services/abuseSignals/invariants.ts': 'abuse signals must count every device of a partner, parked devices included',
  'services/aiAgents/sweepSubjectProbe.ts': 're-probes one device already named by a sweep finding',
  'services/aiAgents/designEvidence.ts': 'pinned to the run\'s org, chosen by the sweep scheduler that leaves the holding org out',
  'services/aiAgents/narrativeContext.ts': 'pinned to the run\'s org, chosen by the sweep scheduler that leaves the holding org out',
  'services/aiAgents/patchEvidence.ts': 'pinned to the run\'s org, chosen by the sweep scheduler that leaves the holding org out',
  'services/aiAgents/sweepEvidence.ts': 'pinned to the run\'s org, chosen by the sweep scheduler that leaves the holding org out',
  'services/aiToolsTicketing.ts': 'identity match pinned to the ticket\'s own org',
  'services/filterEngine.ts': 'evaluates within one caller-supplied org; the holding org owns no groups or filters',
  'services/m365Sync/links.ts': 'pinned to an org with an M365 connection, which can never be a holding org',
  'services/monitors/networkCheckAlertDevice.ts': 'resolves a device inside the org chosen by the guarded network-check sweep',
  'services/topology/originEligibility.ts': 'pinned to the calling technician\'s org and site',
};

/** Pinned: every file with an ephemeral-device filter, all buckets together. */
const EPHEMERAL_DISCOVERED_FILES = 72;

describe('contract: device counts and listings leave parked devices out', () => {
  const found = DEVICE_FILES
    .map((file) => ({ file, code: read(file) }))
    .filter(({ code }) => { EPHEMERAL_FILTER.lastIndex = 0; return EPHEMERAL_FILTER.test(code); });

  it('discovers exactly the pinned number of files (update the pin on purpose)', () => {
    expect(found.map((f) => f.file).sort().length).toBe(EPHEMERAL_DISCOVERED_FILES);
  });

  it('every ephemeral-only filter outside execution modules has a parked guard beside it', () => {
    const unpaired: string[] = [];
    for (const { file, code } of found) {
      if (file in FANOUT_MODULES || file in EPHEMERAL_ONLY) continue;
      const lines = code.split('\n');
      lines.forEach((line, index) => {
        EPHEMERAL_FILTER.lastIndex = 0;
        if (!EPHEMERAL_FILTER.test(line)) return;
        const window = lines.slice(Math.max(0, index - PAIR_WINDOW), index + PAIR_WINDOW + 1).join('\n');
        if (!PAIRED_GUARD.test(window)) unpaired.push(`${file}: ${line.trim()}`);
      });
    }
    expect(unpaired, 'add notParkedDeviceCondition() next to the filter, or classify the file in EPHEMERAL_ONLY').toEqual([]);
  });

  it('has no stale EPHEMERAL_ONLY entries', () => {
    const names = found.map((f) => f.file);
    expect(Object.keys(EPHEMERAL_ONLY).filter((f) => !names.includes(f))).toEqual([]);
  });
});
