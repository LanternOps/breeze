import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, getTableName } from 'drizzle-orm';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./securityComplianceReportVulnerabilities', () => ({
  loadFeedFreshness: vi.fn().mockResolvedValue([]),
  loadOpenFindings: vi.fn().mockResolvedValue([]),
}));

import { db } from '../db';
import { managedDeviceConditions } from './managedDeviceScope';
import {
  generateExecutiveSummaryReport,
  generateComplianceReport,
  generatePerformanceReport,
  generateDeviceInventoryReport,
  generateSoftwareInventoryReport,
} from './reportGenerationService';
import { generateThreatDetectionReport } from './threatDetectionReport';
import { generateEndpointManagementReport } from './endpointManagementReport';
import { generateVulnerabilityManagementReport } from './vulnerabilityManagementReport';
import type { OrgReportExecutionAuthority } from './siteScope';

const ORG = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();
const render = (frag: unknown) => dialect.sqlToQuery(frag as never);

const AUTH = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '33333333-3333-4333-8333-333333333333',
  capturedAt: new Date('2026-09-30T05:18:00.000Z'),
  fingerprint: 'f'.repeat(64),
} as unknown as OrgReportExecutionAuthority;

const PERIOD = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  generatedAt: '2026-09-30T05:18:00.000Z',
  deliverableId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

/** Every select resolves [] and records the SQL of each WHERE issued against
 *  the devices table (the table named by the preceding .from()). */
let deviceWheres: { sql: string; params: unknown[] }[] = [];
let firstSelect = true;
const ORG_ROW = [{ id: ORG, name: 'Acme', partnerId: null }];
function recordSelects() {
  deviceWheres = [];
  firstSelect = true;
  vi.mocked(db.select).mockImplementation((() => {
    let isDevices = false;
    let fromTable = '';
    const first = firstSelect;
    firstSelect = false;
    const chain: Record<string, unknown> = {};
    for (const m of ['orderBy', 'groupBy', 'limit']) chain[m] = () => chain;
    for (const m of ['innerJoin', 'leftJoin']) {
      chain[m] = (t: never) => {
        if (fromTable === 'device_software' && getTableName(t) === 'devices') isDevices = true;
        return chain;
      };
    }
    chain.from = (t: never) => {
      fromTable = getTableName(t);
      isDevices = getTableName(t) === 'devices';
      return chain;
    };
    chain.where = (...args: unknown[]) => {
      if (isDevices && args[0]) {
        const q = render(args[0]);
        deviceWheres.push({ sql: q.sql, params: q.params });
      }
      return chain;
    };
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(first ? ORG_ROW : []).then(resolve);
    return chain;
  }) as never);
}

const excludesDecommissioned = (w: { sql: string; params: unknown[] }) =>
  /"status"/.test(w.sql) && w.params.includes('decommissioned');

describe('managedDeviceConditions (#11562)', () => {
  it('excludes decommissioned, ephemeral and parked devices, scoped to the org', () => {
    const q = render(and(...managedDeviceConditions(ORG)));
    expect(q.sql).toMatch(/"org_id" = \$/);
    expect(q.sql).toMatch(/"is_ephemeral" = \$/);
    expect(q.sql).toMatch(/unassigned_pool|organizations/);
    expect(q.sql).toMatch(/"status"/);
    expect(q.params).toContain('decommissioned');
    expect(q.params).toContain(ORG);
  });
});

describe('every device-population report excludes decommissioned devices (#11562)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordSelects();
  });

  const cases: [string, () => Promise<unknown>][] = [
    ['executive_summary', () => generateExecutiveSummaryReport(ORG, {}, AUTH)],
    ['compliance', () => generateComplianceReport(ORG, {}, AUTH)],
    ['performance', () => generatePerformanceReport(ORG, {}, AUTH)],
    ['device_inventory', () => generateDeviceInventoryReport(ORG, {}, AUTH)],
    ['software_inventory', () => generateSoftwareInventoryReport(ORG, {}, AUTH)],
    ['threat_detection', () => generateThreatDetectionReport(ORG, {}, AUTH, PERIOD)],
    ['endpoint_management', () => generateEndpointManagementReport(ORG, {}, AUTH, PERIOD)],
    ['vulnerability_management', () => generateVulnerabilityManagementReport(ORG, {}, AUTH)],
  ];

  it.each(cases)('%s', async (_name, run) => {
    await run().catch(() => undefined); // empty fixtures may legitimately throw later
    expect(deviceWheres.length).toBeGreaterThan(0);
    for (const w of deviceWheres) expect(excludesDecommissioned(w)).toBe(true);
  });
});
