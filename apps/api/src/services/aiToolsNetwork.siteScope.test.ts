import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerNetworkTools } from './aiToolsNetwork';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ALLOWED = '22222222-2222-4222-8222-222222222222';
const SITE_HIDDEN = '33333333-3333-4333-8333-333333333333';

function chain(rows: unknown[]): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

function updateChain(rows: unknown[] = []): any {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => {
        const result: any = Promise.resolve(rows);
        result.returning = vi.fn(() => Promise.resolve(rows));
        return result;
      }),
    })),
  };
}

function insertChain(rows: unknown[]): any {
  return {
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve(rows)) })),
    })),
  };
}

function handlerFor(name: string): AiTool['handler'] {
  const tools = new Map<string, AiTool>();
  registerNetworkTools(tools);
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.handler;
}

function restrictedAuth(allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'api_key', apiKeyId: 'key-1' },
    user: { id: 'user-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
    token: null,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: (orgId) => orgId === ORG_ID,
    allowedSiteIds,
    canAccessSite: (siteId) => !allowedSiteIds || (!!siteId && allowedSiteIds.includes(siteId)),
  };
}

describe('network AI/MCP tools preserve the caller site ceiling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns no network changes for an empty site allowlist without reading events', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{ id: 'hidden-event', siteId: SITE_HIDDEN }]) as never);

    const output = await handlerFor('get_network_changes')({}, restrictedAuth([]));

    expect(JSON.parse(output)).toMatchObject({ events: [], count: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('denies acknowledgment of an event in a hidden site before update', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      id: 'event-1', orgId: ORG_ID, siteId: SITE_HIDDEN, acknowledged: false, notes: null,
    }]) as never);
    vi.mocked(db.update).mockReturnValue(updateChain() as never);

    const output = await handlerFor('acknowledge_network_device')(
      { event_id: 'event-1' }, restrictedAuth([SITE_ALLOWED]),
    );

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies update of a baseline in a hidden site before update', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      id: 'baseline-1', orgId: ORG_ID, siteId: SITE_HIDDEN,
      scanSchedule: { enabled: true, intervalHours: 4 }, alertSettings: {},
    }]) as never);
    vi.mocked(db.update).mockReturnValue(updateChain() as never);

    const output = await handlerFor('configure_network_baseline')(
      { baseline_id: 'baseline-1', scan_interval_hours: 8 }, restrictedAuth([SITE_ALLOWED]),
    );

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('denies creation for a hidden site before site lookup or insert', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{ id: SITE_HIDDEN }]) as never);
    vi.mocked(db.insert).mockReturnValue(insertChain([{ id: 'baseline-new' }]) as never);

    const output = await handlerFor('configure_network_baseline')({
      org_id: ORG_ID,
      site_id: SITE_HIDDEN,
      subnet: '192.0.2.0/24',
    }, restrictedAuth([SITE_ALLOWED]));

    expect(JSON.parse(output).error).toMatch(/not found|access denied/i);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('returns no reverse IP history for an empty site allowlist without reading history', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      ipHistory: { firstSeen: new Date(), lastSeen: new Date() },
      device: { id: 'hidden-device', hostname: 'hidden', osType: 'linux', siteId: SITE_HIDDEN },
    }]) as never);

    const output = await handlerFor('get_ip_history')({
      ip_address: '192.0.2.10',
      at_time: '2026-01-01T00:00:00.000Z',
    }, restrictedAuth([]));

    expect(JSON.parse(output)).toMatchObject({ mode: 'reverse_lookup', results: [], count: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('preserves an unrestricted network-change read', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{ id: 'event-1', siteId: SITE_HIDDEN }]) as never);

    const output = await handlerFor('get_network_changes')({}, restrictedAuth());

    expect(JSON.parse(output)).toMatchObject({ count: 1 });
    expect(db.select).toHaveBeenCalledOnce();
  });

  it('preserves acknowledgment of an event in an allowed site', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{
      id: 'event-1', orgId: ORG_ID, siteId: SITE_ALLOWED, acknowledged: false, notes: null,
    }]) as never);
    vi.mocked(db.update).mockReturnValue(updateChain() as never);

    const output = await handlerFor('acknowledge_network_device')(
      { event_id: 'event-1' }, restrictedAuth([SITE_ALLOWED]),
    );

    expect(JSON.parse(output)).toMatchObject({ success: true, eventId: 'event-1' });
    expect(db.update).toHaveBeenCalledOnce();
  });

  it('preserves creation of a baseline in an allowed site', async () => {
    vi.mocked(db.select).mockReturnValue(chain([{ id: SITE_ALLOWED }]) as never);
    vi.mocked(db.insert).mockReturnValue(insertChain([{ id: 'baseline-new' }]) as never);

    const output = await handlerFor('configure_network_baseline')({
      org_id: ORG_ID,
      site_id: SITE_ALLOWED,
      subnet: '192.0.2.0/24',
    }, restrictedAuth([SITE_ALLOWED]));

    expect(JSON.parse(output)).toMatchObject({ success: true, action: 'created' });
    expect(db.insert).toHaveBeenCalledOnce();
  });
});
