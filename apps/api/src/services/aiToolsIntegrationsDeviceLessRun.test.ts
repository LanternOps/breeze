/**
 * RC3 (#6096) — the device-LESS analysis run shape, for the integration /
 * security tool files.
 *
 * `agentAuthContext.ts` produces two restricted shapes:
 *   - device-BOUND run: allowedDeviceIds = [id], allowedSiteIds = [site], canAccessSite
 *   - device-LESS run:  allowedDeviceIds = [...] and NO allowedSiteIds, NO canAccessSite
 *
 * Every guard written `if (auth.allowedSiteIds && auth.canAccessSite)` silently
 * no-ops for the second shape, so the run reads ORG-WIDE. These tests pin the
 * device axis for the tools in aiToolsSentinelOne / Pam / Monitoring / Dns /
 * Compliance / CisBenchmark / Huntress / Peripherals / Vault: with
 * `allowedDeviceIds: ['d-1']` and no site axis, each tool must narrow its
 * device column to d-1 and never reach sibling d-2.
 *
 * Each tool also carries an UNRESTRICTED control proving the fix adds no
 * narrowing (and no device query) for an ordinary admin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));

// Pass-through spy on `inArray` so a test can prove WHICH column was narrowed
// to WHICH ids — an empty-set short-circuit assertion cannot catch a mis-wired
// column, and the device axis is exactly a column+id-set claim.
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return { ...actual, inArray: vi.fn(actual.inArray) };
});

vi.mock('./eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('./pamRuleEngine', () => ({ evaluatePamRules: vi.fn() }));
vi.mock('../jobs/dnsSyncJob', () => ({ schedulePolicySync: vi.fn() }));
vi.mock('../jobs/huntressSync', () => ({ scheduleHuntressSync: vi.fn() }));
vi.mock('../jobs/cisJobs', () => ({ scheduleCisRemediationWithResult: vi.fn() }));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('./commandQueue', () => ({ CommandTypes: { VAULT_SYNC: 'vault_sync', VAULT_VERIFY: 'vault_verify' } }));
vi.mock('./aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn(async () => ({ command: { id: 'c1', status: 'sent' } })) }));
vi.mock('./assetReachabilityLoader', () => ({ loadReachability: vi.fn(async () => new Map()) }));
vi.mock('./softwarePolicyService', () => ({
  evaluateSoftwarePolicyArming: vi.fn(() => ({ armed: true })),
  normalizeSoftwarePolicyRules: vi.fn((r: unknown) => r),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));
vi.mock('./sentinelOne/actions', () => ({
  getActiveS1IntegrationForOrg: vi.fn(async () => ({ id: 'int-1', orgId: 'org-1', name: 'S1' })),
  executeS1IsolationForOrg: vi.fn(),
  executeS1ThreatActionForOrg: vi.fn(),
}));

import { db } from '../db';
import { inArray } from 'drizzle-orm';
import {
  automationPolicyCompliance, cisBaselineResults, deviceChangeLog, dnsSecurityEvents,
  elevationRequests, huntressAgents, huntressIncidents, localVaults, peripheralEvents,
  s1Threats, serviceProcessCheckResults, softwareComplianceStatus,
} from '../db/schema';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { registerSentinelOneTools } from './aiToolsSentinelOne';
import { registerPamTools } from './aiToolsPam';
import { registerMonitoringTools } from './aiToolsMonitoring';
import { registerDnsTools } from './aiToolsDns';
import { registerComplianceTools } from './aiToolsCompliance';
import { registerCisBenchmarkTools } from './aiToolsCisBenchmark';
import { registerHuntressTools } from './aiToolsHuntress';
import { registerPeripheralTools } from './aiToolsPeripherals';
import { registerVaultTools } from './aiToolsVault';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const inArraySpy = vi.mocked(inArray);

/** The id list (if any) that a narrowing `inArray` applied to `column`. */
function narrowedIds(column: PgColumn): unknown[] | undefined {
  const call = inArraySpy.mock.calls.find(([col]) => col === column);
  return call?.[1] as unknown[] | undefined;
}

function handlerFor(
  register: (m: Map<string, AiTool>) => void,
  name: string,
): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  register(reg);
  return reg.get(name)!.handler;
}

/** device-LESS analysis run: a frozen device allowlist and NO site axis. */
function deviceLessAuth(allowedDeviceIds: string[] = ['d-1']): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: undefined, allowedDeviceIds,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as unknown as AuthContext;
}

/** Unrestricted human: `canAccessSite` is ALWAYS defined and always true. */
function unrestrictedAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: undefined, allowedDeviceIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

/** `resolveSiteAllowedDeviceIds` / `deviceIdSiteDenied` device scan. */
function isDeviceResolverSelect(cols: unknown): boolean {
  return (
    !!cols && typeof cols === 'object' &&
    'id' in (cols as object) && 'siteId' in (cols as object) &&
    Object.keys(cols as object).length === 2
  );
}

/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'as', 'having']) {
    p[m] = () => p;
  }
  return p;
}

/** Org has the run's device plus a sibling the run must never reach. */
const ORG_DEVICES = [
  { id: 'd-1', siteId: 'site-A' },
  { id: 'd-2', siteId: 'site-A' },
];

let deviceScans = 0;

/**
 * Standard select mock: the device-partition scan returns both org devices;
 * every other query resolves to `rows` (default empty).
 */
function mockSelect(rows: unknown = [], special?: (cols: any) => unknown | undefined) {
  deviceScans = 0;
  mockDb.select.mockImplementation((cols?: any) => {
    if (isDeviceResolverSelect(cols)) {
      deviceScans += 1;
      return { from: () => ({ where: () => Promise.resolve(ORG_DEVICES) }) };
    }
    const s = special?.(cols);
    if (s !== undefined) return s;
    return chain(rows);
  });
}

beforeEach(() => vi.clearAllMocks());

// ------------------------------------------------------------ SentinelOne

describe('get_s1_threats — device axis', () => {
  it('narrows s1Threats.deviceId to the frozen device set for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerSentinelOneTools, 'get_s1_threats')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(s1Threats.deviceId)).toEqual(['d-1']);
  });

  it('never returns a sibling device row to a device-less run', async () => {
    mockSelect([{ id: 't1', deviceId: 'd-2', deviceName: 'sibling-leak' }]);
    const r = await handlerFor(registerSentinelOneTools, 'get_s1_threats')({ deviceId: 'd-2' }, deviceLessAuth());
    expect(JSON.parse(r).threats ?? []).toEqual([]);
    expect(r).not.toContain('sibling-leak');
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerSentinelOneTools, 'get_s1_threats')({}, unrestrictedAuth());
    expect(narrowedIds(s1Threats.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// -------------------------------------------------------------------- PAM

describe('get_elevation_history — device axis', () => {
  it('narrows elevationRequests.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerPamTools, 'get_elevation_history')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(elevationRequests.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerPamTools, 'get_elevation_history')({}, unrestrictedAuth());
    expect(narrowedIds(elevationRequests.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// ------------------------------------------------------------- Monitoring

describe('get_service_monitoring_status — device axis', () => {
  it('results: narrows serviceProcessCheckResults.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerMonitoringTools, 'get_service_monitoring_status')(
      { action: 'results' }, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(serviceProcessCheckResults.deviceId)).toEqual(['d-1']);
  });

  it('known_services: narrows both name sources for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerMonitoringTools, 'get_service_monitoring_status')(
      { action: 'known_services' }, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(deviceChangeLog.deviceId)).toEqual(['d-1']);
    expect(narrowedIds(serviceProcessCheckResults.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerMonitoringTools, 'get_service_monitoring_status')(
      { action: 'results' }, unrestrictedAuth());
    expect(narrowedIds(serviceProcessCheckResults.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// -------------------------------------------------------------------- DNS

const DNS_INPUT = {
  timeRange: { start: new Date(Date.now() - 3600_000).toISOString(), end: new Date().toISOString() },
};

describe('get_dns_security — device axis', () => {
  it('narrows dnsSecurityEvents.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerDnsTools, 'get_dns_security')(DNS_INPUT, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(dnsSecurityEvents.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerDnsTools, 'get_dns_security')(DNS_INPUT, unrestrictedAuth());
    expect(narrowedIds(dnsSecurityEvents.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

describe('manage_dns_policy — device axis', () => {
  it('refuses an org-wide DNS policy write from a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerDnsTools, 'manage_dns_policy')(
      { integrationId: 'i1', action: 'add_block', domains: ['evil.test'] }, deviceLessAuth());
    expect(JSON.parse(r).error).toContain('full-organization access');
  });

  it('unrestricted control: proceeds past the scope gate', async () => {
    mockSelect([]);
    const r = await handlerFor(registerDnsTools, 'manage_dns_policy')(
      { integrationId: 'i1', action: 'add_block', domains: ['evil.test'] }, unrestrictedAuth());
    expect(JSON.parse(r).error).not.toContain('full-organization access');
  });
});

// ------------------------------------------------------------- Compliance

describe('get_software_compliance — device axis', () => {
  it('narrows softwareComplianceStatus.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerComplianceTools, 'get_software_compliance')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(softwareComplianceStatus.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerComplianceTools, 'get_software_compliance')({}, unrestrictedAuth());
    expect(narrowedIds(softwareComplianceStatus.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

describe('remediate_software_violation — device axis', () => {
  it('narrows the org-wide violation fan-out to the frozen device set', async () => {
    mockSelect([{ id: 'p1', orgId: 'org-1', partnerId: null, name: 'P', mode: 'enforce' }]);
    const r = await handlerFor(registerComplianceTools, 'remediate_software_violation')(
      { policyId: 'p1' }, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(softwareComplianceStatus.deviceId)).toEqual(['d-1']);
  });
});

describe('get_compliance_status — device axis', () => {
  it('narrows automationPolicyCompliance.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerComplianceTools, 'get_compliance_status')(
      { policyId: 'p1' }, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(automationPolicyCompliance.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerComplianceTools, 'get_compliance_status')(
      { policyId: 'p1' }, unrestrictedAuth());
    expect(narrowedIds(automationPolicyCompliance.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// ----------------------------------------------------------- CIS baseline

describe('get_cis_compliance — device axis', () => {
  it('narrows cisBaselineResults.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerCisBenchmarkTools, 'get_cis_compliance')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(cisBaselineResults.deviceId)).toEqual(['d-1']);
  });

  it('a device-less run asking for a SIBLING device id gets nothing', async () => {
    mockSelect([{ resultId: 'r1', deviceId: 'd-2', hostname: 'sibling-leak', score: 10 }]);
    const r = await handlerFor(registerCisBenchmarkTools, 'get_cis_compliance')(
      { deviceId: 'd-2' }, deviceLessAuth());
    expect(r).not.toContain('sibling-leak');
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerCisBenchmarkTools, 'get_cis_compliance')({}, unrestrictedAuth());
    expect(narrowedIds(cisBaselineResults.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// --------------------------------------------------------------- Huntress

const huntressIntegrationRow = [{
  id: 'int-1', partnerId: null, name: 'H', isActive: true,
  lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
}];

function mockHuntressSelect(rows: unknown = []) {
  mockSelect(rows, (cols: any) => (cols && 'lastSyncError' in cols ? chain(huntressIntegrationRow) : undefined));
}

describe('get_huntress_status — device axis', () => {
  it('narrows huntressAgents/huntressIncidents deviceId for a device-less run', async () => {
    mockHuntressSelect([]);
    const r = await handlerFor(registerHuntressTools, 'get_huntress_status')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(huntressAgents.deviceId)).toEqual(['d-1']);
    expect(narrowedIds(huntressIncidents.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockHuntressSelect([]);
    await handlerFor(registerHuntressTools, 'get_huntress_status')({}, unrestrictedAuth());
    expect(narrowedIds(huntressAgents.deviceId)).toBeUndefined();
    expect(narrowedIds(huntressIncidents.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

describe('get_huntress_incidents — device axis', () => {
  it('narrows huntressIncidents.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerHuntressTools, 'get_huntress_incidents')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(huntressIncidents.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerHuntressTools, 'get_huntress_incidents')({}, unrestrictedAuth());
    expect(narrowedIds(huntressIncidents.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// ------------------------------------------------------------ Peripherals

describe('get_peripheral_activity — device axis', () => {
  it('narrows peripheralEvents.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerPeripheralTools, 'get_peripheral_activity')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(peripheralEvents.deviceId)).toEqual(['d-1']);
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerPeripheralTools, 'get_peripheral_activity')({}, unrestrictedAuth());
    expect(narrowedIds(peripheralEvents.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});

// ------------------------------------------------------------------ Vault

describe('query_vaults — device axis', () => {
  it('narrows localVaults.deviceId for a device-less run', async () => {
    mockSelect([]);
    const r = await handlerFor(registerVaultTools, 'query_vaults')({}, deviceLessAuth());
    expect(JSON.parse(r).error).toBeUndefined();
    expect(narrowedIds(localVaults.deviceId)).toEqual(['d-1']);
  });

  it('a device-less run asking for a SIBLING device id gets nothing', async () => {
    mockSelect([{ id: 'v1', deviceId: 'd-2', hostname: 'sibling-leak' }]);
    const r = await handlerFor(registerVaultTools, 'query_vaults')({ deviceId: 'd-2' }, deviceLessAuth());
    const parsed = JSON.parse(r);
    expect(parsed.vaults).toEqual([]);
    expect(r).not.toContain('sibling-leak');
  });

  it('unrestricted control: no device narrowing, no device scan', async () => {
    mockSelect([]);
    await handlerFor(registerVaultTools, 'query_vaults')({}, unrestrictedAuth());
    expect(narrowedIds(localVaults.deviceId)).toBeUndefined();
    expect(deviceScans).toBe(0);
  });
});
