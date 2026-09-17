/**
 * Exact-device axis (#6086) for the FLEET branches of get_active_users and
 * get_user_experience_metrics.
 *
 * Both query device_sessions org-wide when no deviceId is supplied and were
 * narrowed only on the SITE axis, so a device-bound preconfigured agent run saw
 * every SIBLING device's sessions — and a device-LESS analysis run (no
 * allowedSiteIds at all) was not narrowed on any axis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('./aiDispatch', () => ({ aiExecuteCommand: vi.fn() }));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerPerformanceTools } from './aiToolsPerformance';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
/** Same org, same site — only the exact-device allowlist separates it. */
const SIBLING_DEVICE_ID = '44444444-4444-4444-8444-444444444444';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function captureSingleWhere(rows: unknown[]): { capturedWhere: () => unknown } {
  let captured: unknown;
  mockDb.select.mockImplementationOnce(() => {
    const chain: Record<string, any> = {};
    for (const m of ['from', 'innerJoin', 'groupBy', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
    chain.where = vi.fn((condition: unknown) => {
      captured = condition;
      return chain;
    });
    chain.then = (ok?: (v: unknown) => unknown, err?: (r: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, err);
    return chain;
  });
  return { capturedWhere: () => captured };
}

function sessionRow(deviceId: string) {
  return {
    sessionId: `s-${deviceId.slice(0, 4)}`,
    deviceId,
    hostname: `host-${deviceId.slice(0, 4)}`,
    deviceStatus: 'online',
    username: 'alice',
    sessionType: 'console',
    osSessionId: '1',
    loginAt: new Date('2026-09-10T00:00:00.000Z'),
    logoutAt: null,
    durationSeconds: 100,
    idleMinutes: 0,
    activityState: 'active',
    loginPerformanceSeconds: 12,
    lastActivityAt: new Date('2026-09-10T01:00:00.000Z'),
    isActive: true,
  };
}

function handlerFor(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerPerformanceTools(registry);
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

const FLEET_TOOLS: Array<[string, Record<string, unknown>]> = [
  ['get_active_users', { limit: 10 }],
  ['get_user_experience_metrics', { limit: 10 }],
];

describe('fleet session tools — exact-device narrowing', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(FLEET_TOOLS)(
    '%s cannot reach a sibling device at the same site (device-bound run)',
    async (tool, input) => {
      const { capturedWhere } = captureSingleWhere([]);

      await handlerFor(tool)(input, deviceBoundAuth());

      const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
      expect(rendered.params).toContain(DEVICE_ID);
      expect(rendered.params).not.toContain(SIBLING_DEVICE_ID);
    },
  );

  it.each(FLEET_TOOLS)('%s still returns its own device sessions (no over-blocking)', async (tool, input) => {
    captureSingleWhere([sessionRow(DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor(tool)(input, deviceBoundAuth()));

    expect(parsed.totalActiveSessions ?? parsed.totalSessions).toBe(1);
  });

  it.each(FLEET_TOOLS)('%s narrows for the device-LESS shape too (no allowedSiteIds)', async (tool, input) => {
    const { capturedWhere } = captureSingleWhere([]);

    await handlerFor(tool)(input, deviceOnlyAuth());

    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).toContain(DEVICE_ID);
  });

  it.each(FLEET_TOOLS)('%s is not narrowed for an unrestricted caller (no regression)', async (tool, input) => {
    const { capturedWhere } = captureSingleWhere([sessionRow(DEVICE_ID), sessionRow(SIBLING_DEVICE_ID)]);

    const parsed = JSON.parse(await handlerFor(tool)(input, makeAuth()));

    expect(parsed.totalActiveSessions ?? parsed.totalSessions).toBe(2);
    const rendered = new PgDialect().sqlToQuery(capturedWhere() as SQL);
    expect(rendered.params).not.toContain(DEVICE_ID);
  });
});
