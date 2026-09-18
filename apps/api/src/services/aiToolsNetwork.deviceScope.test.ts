/**
 * Exact-device axis (#6086) for get_ip_history reverse lookup.
 *
 * "Which device held this IP at time T" was scoped by org (+ the SITE axis
 * only), so a device-bound preconfigured agent run learned about SIBLING
 * devices. The device axis must apply independently: a device-LESS analysis run
 * carries allowedDeviceIds with NO allowedSiteIds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerNetworkTools } from './aiToolsNetwork';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
/** Same org, same site — only the exact-device allowlist separates it. */
const SIBLING_DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function captureWhere(rows: unknown[]): { capturedWhere: () => unknown } {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => {
    const chain: any = Promise.resolve(rows);
    for (const m of ['from', 'innerJoin', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
    chain.where = vi.fn((condition: unknown) => {
      captured = condition;
      return chain;
    });
    return chain;
  });
  return { capturedWhere: () => captured };
}

function row(deviceId: string) {
  return {
    ipHistory: {
      deviceId,
      interfaceName: 'eth0',
      assignmentType: 'dhcp',
      firstSeen: new Date('2026-09-01T00:00:00.000Z'),
      lastSeen: new Date('2026-09-10T00:00:00.000Z'),
      isActive: true,
    },
    device: { id: deviceId, hostname: `host-${deviceId.slice(0, 4)}`, osType: 'windows', siteId: SITE_ID },
  };
}

function handlerFor(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerNetworkTools(registry);
  return registry.get(name)!.handler;
}

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 't@example.com', name: 'T', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
    ...over,
  } as unknown as AuthContext;
}

const deviceBoundAuth = () =>
  makeAuth({
    allowedDeviceIds: [DEVICE_ID],
    allowedSiteIds: [SITE_ID],
    canAccessSite: () => true,
  } as Partial<AuthContext>);

const deviceOnlyAuth = () =>
  makeAuth({
    allowedDeviceIds: [DEVICE_ID],
    allowedSiteIds: undefined,
    canAccessSite: undefined,
  } as Partial<AuthContext>);

const LOOKUP = { ip_address: '10.0.0.5', at_time: '2026-09-05T00:00:00.000Z' };

describe('get_ip_history reverse lookup — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not reveal a sibling device at the same site (device-bound run)', async () => {
    const { capturedWhere } = captureWhere([row(SIBLING_DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor('get_ip_history')(LOOKUP, deviceBoundAuth()));

    expect(parsed.mode).toBe('reverse_lookup');
    expect(parsed.results).toEqual([]);
    expect(parsed.count).toBe(0);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
    expect(rendered.params).not.toContain(SIBLING_DEVICE_ID);
  });

  it('still resolves its own device (no over-blocking)', async () => {
    captureWhere([row(DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor('get_ip_history')(LOOKUP, deviceBoundAuth()));

    expect(parsed.count).toBe(1);
    expect(parsed.results[0].device.id).toBe(DEVICE_ID);
  });

  it('does not reveal a sibling for the device-LESS shape (no allowedSiteIds)', async () => {
    const { capturedWhere } = captureWhere([row(SIBLING_DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor('get_ip_history')(LOOKUP, deviceOnlyAuth()));

    expect(parsed.results).toEqual([]);
    expect(parsed.count).toBe(0);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('unrestricted caller sees every match (no regression)', async () => {
    const { capturedWhere } = captureWhere([row(DEVICE_ID), row(SIBLING_DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor('get_ip_history')(LOOKUP, makeAuth()));

    expect(parsed.count).toBe(2);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).not.toContain(DEVICE_ID);
  });
});

/**
 * #6096 I4 — network CHANGE EVENTS were scoped by org + site only, so a
 * device-bound run read (and could acknowledge) rogue/new-device findings for
 * every sibling device at its site, and a device-LESS analysis run read the
 * whole org. Rows with a NULL `linkedDeviceId` are not attributable to the
 * run's device either, so a device-restricted caller must not see them — which
 * `inArray` gives for free (SQL `IN` is never true for NULL).
 */
describe('network change events — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  const EVENT_ID = '55555555-5555-4555-8555-555555555555';

  it('get_network_changes narrows on linked_device_id for a device-bound run', async () => {
    const { capturedWhere } = captureWhere([]);
    await handlerFor('get_network_changes')({}, deviceBoundAuth());
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.sql).toContain('linked_device_id');
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('get_network_changes narrows for the device-LESS shape (no site axis)', async () => {
    const { capturedWhere } = captureWhere([]);
    await handlerFor('get_network_changes')({}, deviceOnlyAuth());
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.sql).toContain('linked_device_id');
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('get_network_changes leaves an unrestricted caller unnarrowed', async () => {
    const { capturedWhere } = captureWhere([]);
    await handlerFor('get_network_changes')({}, makeAuth());
    const captured = capturedWhere();
    if (captured) {
      expect(new PgDialect().sqlToQuery(captured as SQL).sql).not.toContain('linked_device_id');
    }
  });

  function mockAckEvent(event: Record<string, unknown> | undefined) {
    let captured: unknown;
    mockDb.select.mockImplementation(() => {
      const chain: any = {};
      chain.from = () => chain;
      chain.where = (c: unknown) => { captured = c; return chain; };
      chain.limit = () => Promise.resolve(event ? [event] : []);
      return chain;
    });
    (db as any).update.mockReturnValue({ set: () => ({ where: () => Promise.resolve() }) });
    return () => captured;
  }

  it('acknowledge_network_device narrows the lookup to the allowlist', async () => {
    const captured = mockAckEvent({ id: EVENT_ID, siteId: SITE_ID, linkedDeviceId: DEVICE_ID, acknowledged: false, notes: null });
    const parsed = JSON.parse(await handlerFor('acknowledge_network_device')({ event_id: EVENT_ID }, deviceOnlyAuth()));
    expect(parsed.success).toBe(true);
    const rendered = new PgDialect().sqlToQuery(captured() as SQL);
    expect(rendered.sql).toContain('linked_device_id');
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it('acknowledge_network_device denies a sibling-linked event that slipped past the query', async () => {
    mockAckEvent({ id: EVENT_ID, siteId: SITE_ID, linkedDeviceId: SIBLING_DEVICE_ID, acknowledged: false, notes: null });
    const parsed = JSON.parse(await handlerFor('acknowledge_network_device')({ event_id: EVENT_ID }, deviceBoundAuth()));
    expect(parsed.error).toMatch(/not found or access denied/i);
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('acknowledge_network_device denies an UNLINKED (rogue) event for a device-restricted caller', async () => {
    mockAckEvent({ id: EVENT_ID, siteId: SITE_ID, linkedDeviceId: null, acknowledged: false, notes: null });
    const parsed = JSON.parse(await handlerFor('acknowledge_network_device')({ event_id: EVENT_ID }, deviceOnlyAuth()));
    expect(parsed.error).toMatch(/not found or access denied/i);
    expect((db as any).update).not.toHaveBeenCalled();
  });

  it('acknowledge_network_device still works unrestricted for an unlinked event', async () => {
    mockAckEvent({ id: EVENT_ID, siteId: SITE_ID, linkedDeviceId: null, acknowledged: false, notes: null });
    const parsed = JSON.parse(await handlerFor('acknowledge_network_device')({ event_id: EVENT_ID }, makeAuth()));
    expect(parsed.success).toBe(true);
  });
});

describe('get_network_asset_reachability — exact-device narrowing on linked_device_id', () => {
  beforeEach(() => vi.clearAllMocks());

  const ASSET_ID = '66666666-6666-4666-8666-666666666666';

  it.each([
    ['device-bound run', deviceBoundAuth],
    ['device-LESS run', deviceOnlyAuth],
  ])('%s: the asset lookup carries the device axis, so a sibling-linked or unlinked asset is not found', async (_n, auth) => {
    const { capturedWhere } = captureWhere([]);
    const result = JSON.parse(await handlerFor('get_network_asset_reachability')({ asset_id: ASSET_ID }, auth()));
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.sql).toMatch(/"linked_device_id" in \(/);
    expect(rendered.params).toContain(DEVICE_ID);
    expect(result.error).toBe('Asset not found or access denied');
  });

  it('leaves an unrestricted caller unnarrowed', async () => {
    const { capturedWhere } = captureWhere([]);
    await handlerFor('get_network_asset_reachability')({ asset_id: ASSET_ID }, makeAuth());
    expect(new PgDialect().sqlToQuery(capturedWhere() as SQL).sql).not.toContain('linked_device_id');
  });
});
