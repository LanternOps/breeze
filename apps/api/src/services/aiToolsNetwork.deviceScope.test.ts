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
    user: { id: 'user-1', email: 't@e.st', name: 'T', isPlatformAdmin: false },
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
