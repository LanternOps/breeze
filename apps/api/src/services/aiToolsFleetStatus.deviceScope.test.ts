import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * Exact-device axis for get_invite_funnel (#6096).
 *
 * The funnel was narrowed on the SITE axis only (`auth.canAccessSite`). A
 * device-bound agent run shares its site with every sibling device, and a
 * device-LESS analysis run has no site axis at all, so both could read sibling
 * devices' enrolment rows and the org's device-less invites.
 */
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

import { db } from '../db';
import { registerFleetStatusTools } from './aiToolsFleetStatus';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerFleetStatusTools(reg);
  return reg.get(name)!.handler;
}

function deviceBoundAuth(): AuthContext {
  return {
    principal: { kind: 'ai_agent', agentId: 'ag-1', runId: 'run-1' } as any,
    user: { id: 'ag-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null as any, partnerId: 'p1', orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    allowedSiteIds: ['site-1'], canAccessSite: () => true,
    allowedDeviceIds: ['dev-1'],
  } as AuthContext;
}

function deviceLessRunAuth(): AuthContext {
  const auth = deviceBoundAuth() as any;
  delete auth.allowedSiteIds;
  delete auth.canAccessSite;
  return auth as AuthContext;
}

function unrestrictedAuth(): AuthContext {
  const auth = deviceLessRunAuth() as any;
  delete auth.allowedDeviceIds;
  return auth as AuthContext;
}

const NOW = new Date('2026-09-16T00:00:00.000Z');

function invite(id: string, deviceId: string | null) {
  return {
    id, email: `${id}@b.c`, status: deviceId ? 'enrolled' : 'sent',
    clickedAt: NOW, enrolledAt: deviceId ? NOW : null, deviceId, keySiteId: 'site-1',
  };
}

function mockSelects(
  inviteRows: Array<Record<string, unknown>>,
  deviceRows: Array<Record<string, unknown>>,
  capture?: (cond: SQL) => void,
) {
  let call = 0;
  mockDb.select.mockImplementation(() => {
    call++;
    if (call === 1) {
      return { from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(inviteRows) }) }) };
    }
    return { from: () => ({ where: (cond: SQL) => { capture?.(cond); return Promise.resolve(deviceRows); } }) };
  });
}

describe('get_invite_funnel — exact-device axis (#6096)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes a sibling device at the same site for a device-bound run', async () => {
    let deviceWhere: SQL | undefined;
    mockSelects(
      [invite('i1', 'dev-1'), invite('i2', 'dev-2')],
      [
        { id: 'dev-1', hostname: 'own', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1' },
        { id: 'dev-2', hostname: 'sibling', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1' },
      ],
      (cond) => { deviceWhere = cond; },
    );
    const r = await handlerFor('get_invite_funnel')({}, deviceBoundAuth());
    const funnel = JSON.parse(r).invite_funnel;
    expect(funnel.devices_online).toBe(1);
    expect(funnel.devices_enrolled).toBe(1);
    expect(funnel.total_invited).toBe(1);
    expect(funnel.recent_enrollments.map((e: any) => e.device_id)).toEqual(['dev-1']);
    expect(deviceWhere, 'the device query must carry the device-axis narrowing').toBeDefined();
    const rendered = new PgDialect().sqlToQuery(deviceWhere!);
    expect(rendered.params).toContain('dev-1');
  });

  it('keeps the run device visible (dev-1 still works)', async () => {
    mockSelects(
      [invite('i1', 'dev-1')],
      [{ id: 'dev-1', hostname: 'own', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1' }],
    );
    const funnel = JSON.parse(await handlerFor('get_invite_funnel')({}, deviceBoundAuth())).invite_funnel;
    expect(funnel.devices_online).toBe(1);
    expect(funnel.recent_enrollments[0].hostname).toBe('own');
  });

  it('excludes device-LESS invites for a device-LESS analysis run (no site axis)', async () => {
    mockSelects(
      [invite('i1', 'dev-1'), invite('i2', 'dev-2'), invite('i3', null)],
      [
        { id: 'dev-1', hostname: 'own', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1' },
        { id: 'dev-2', hostname: 'sibling', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-9' },
      ],
    );
    const funnel = JSON.parse(await handlerFor('get_invite_funnel')({}, deviceLessRunAuth())).invite_funnel;
    expect(funnel.total_invited).toBe(1);
    expect(funnel.devices_online).toBe(1);
    expect(funnel.recent_enrollments.map((e: any) => e.device_id)).toEqual(['dev-1']);
  });

  it('unrestricted caller is unaffected (no regression)', async () => {
    mockSelects(
      [invite('i1', 'dev-1'), invite('i2', 'dev-2'), invite('i3', null)],
      [
        { id: 'dev-1', hostname: 'own', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-1' },
        { id: 'dev-2', hostname: 'sibling', osType: 'windows', status: 'online', orgId: 'org-1', siteId: 'site-9' },
      ],
    );
    const funnel = JSON.parse(await handlerFor('get_invite_funnel')({}, unrestrictedAuth())).invite_funnel;
    expect(funnel.total_invited).toBe(3);
    expect(funnel.devices_online).toBe(2);
  });
});
