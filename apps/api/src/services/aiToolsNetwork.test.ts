/**
 * aiToolsNetwork — configure_network_baseline creation-path tests.
 *
 * Covers the duplicate-baseline case for `configure_network_baseline`. The
 * insert used to catch the unique violation on (org_id, site_id, subnet) and
 * map it to a friendly error, but this handler runs inside the AI tool's
 * withDbAccessContext transaction, which re-throws a caught unique violation
 * as a raw PostgresError at commit time (see createCatalogItem in
 * catalogService.ts). The fix suppresses the conflict at the statement level
 * via onConflictDoNothing(); these tests assert the friendly JSON result is
 * returned instead of a throw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  deviceIpHistory: {},
  networkBaselines: {
    id: 'nb.id',
    orgId: 'nb.orgId',
    siteId: 'nb.siteId',
    subnet: 'nb.subnet',
  },
  networkChangeEvents: {
    id: 'nce.id',
    orgId: 'nce.orgId',
    siteId: 'nce.siteId',
    baselineId: 'nce.baselineId',
    eventType: { enumValues: ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'] },
    acknowledged: 'nce.acknowledged',
    detectedAt: 'nce.detectedAt',
  },
  sites: { id: 'sites.id', orgId: 'sites.orgId' },
  discoveredAssetTypeEnum: {
    enumValues: [
      'workstation', 'server', 'printer', 'router', 'switch', 'firewall',
      'access_point', 'phone', 'iot', 'camera', 'nas', 'unknown',
    ],
  },
}));

import { db } from '../db';
import { registerNetworkTools } from './aiToolsNetwork';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ID = '22222222-2222-2222-2222-222222222222';
const BASELINE_ID = '33333333-3333-3333-3333-333333333333';
const SUBNET = '192.168.1.0/24';

function createSelectChain(rows: any[]) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createInsertChain(rows: any[]) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.onConflictDoNothing = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

describe('configure_network_baseline (create path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function registerAndGetTool() {
    const tools = new Map<string, any>();
    registerNetworkTools(tools);
    return tools.get('configure_network_baseline')!;
  }

  it('creates a baseline when no conflicting org/site/subnet exists', async () => {
    // 1st select: site lookup. Insert: succeeds with a returned row.
    vi.mocked(db.select).mockReturnValueOnce(createSelectChain([{ id: SITE_ID }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(createInsertChain([{ id: BASELINE_ID }]) as any);

    const tool = registerAndGetTool();
    const output = await tool.handler({
      org_id: ORG_ID,
      site_id: SITE_ID,
      subnet: SUBNET,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      success: true,
      baselineId: BASELINE_ID,
      action: 'created',
    });
  });

  it('returns a friendly error, not a throw, when a baseline already exists for this org/site/subnet', async () => {
    // Site lookup succeeds; the onConflictDoNothing insert returns zero rows
    // because a baseline for this (org_id, site_id, subnet) already exists.
    vi.mocked(db.select).mockReturnValueOnce(createSelectChain([{ id: SITE_ID }]) as any);
    vi.mocked(db.insert).mockReturnValueOnce(createInsertChain([]) as any);

    const tool = registerAndGetTool();
    const output = await tool.handler({
      org_id: ORG_ID,
      site_id: SITE_ID,
      subnet: SUBNET,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      error: 'Baseline already exists for this org/site/subnet',
    });
  });

  it('denies access to an organization the caller cannot access', async () => {
    const tool = registerAndGetTool();
    const output = await tool.handler({
      org_id: 'other-org',
      site_id: SITE_ID,
      subnet: SUBNET,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({ error: 'Access to this organization denied' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('requires org_id, site_id, and subnet when creating a baseline', async () => {
    const tool = registerAndGetTool();
    const output = await tool.handler({ org_id: ORG_ID, site_id: SITE_ID }, makeAuth());

    expect(JSON.parse(output)).toEqual({
      error: 'org_id, site_id, and subnet are required when creating a baseline',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns an error when the site is not found for the organization', async () => {
    vi.mocked(db.select).mockReturnValueOnce(createSelectChain([]) as any);

    const tool = registerAndGetTool();
    const output = await tool.handler({
      org_id: ORG_ID,
      site_id: SITE_ID,
      subnet: SUBNET,
    }, makeAuth());

    expect(JSON.parse(output)).toEqual({ error: 'Site not found for this organization' });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
