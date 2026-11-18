import { describe, it, expect, vi, beforeEach } from 'vitest';

// #12140: an unattended note (no person approved it, e.g. over MCP) is counted
// under a per-device advisory lock in the insert's own transaction, and is not
// written while the device has UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE active notes.

const calls: string[] = [];
const state = { inContext: true, activeCount: 0 as unknown, deviceRows: [{ id: 'dev-1', orgId: 'org-1' }] as unknown[] };

vi.mock('../db', () => ({
  hasDbAccessContext: vi.fn(() => state.inContext),
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if (projection && 'n' in projection) {
            calls.push('count');
            return Promise.resolve([{ n: state.activeCount }]);
          }
          return { limit: () => { calls.push('device'); return Promise.resolve(state.deviceRows); } };
        },
      }),
    })),
    execute: vi.fn(async (q: unknown) => { calls.push(`execute:${JSON.stringify(q)}`); return []; }),
    insert: vi.fn(() => ({
      values: (v: unknown) => { calls.push('insert'); return { returning: async () => [{ id: 'ctx-1', ...(v as object) }] }; },
    })),
  },
}));

vi.mock('../db/schema', () => ({
  brainDeviceContext: {
    id: 'id', orgId: 'org_id', deviceId: 'device_id', contextType: 'context_type', summary: 'summary',
    details: 'details', createdAt: 'created_at', expiresAt: 'expires_at', resolvedAt: 'resolved_at',
  },
  devices: { id: 'id', orgId: 'org_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
  gt: vi.fn((...args: unknown[]) => ({ _gt: args })),
  isNull: vi.fn((col: unknown) => ({ _isNull: col })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
  count: vi.fn(() => ({ _count: true })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings.join('?'), values })),
}));

import { createDeviceContext } from './brainDeviceContext';
import { UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE, UNATTENDED_NOTE_MAX_EXPIRY_DAYS } from './deviceNoteBounds';
import type { AuthContext } from '../middleware/auth';

const auth = { orgCondition: () => undefined } as unknown as AuthContext;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);

describe('createDeviceContext — unattended bounds (#12140)', () => {
  beforeEach(() => {
    calls.length = 0;
    state.inContext = true;
    state.activeCount = 0;
    state.deviceRows = [{ id: 'dev-1', orgId: 'org-1' }];
  });

  it('takes the per-device lock, then counts, then inserts', async () => {
    state.activeCount = UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE - 1;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect('error' in r).toBe(false);
    expect(calls[0]).toBe('device');
    expect(calls[1]).toMatch(/^execute:.*pg_advisory_xact_lock.*brain_device_context:dev-1/);
    expect(calls.slice(2)).toEqual(['count', 'insert']);
  });

  it('writes nothing once the device has the maximum active notes', async () => {
    state.activeCount = UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect(r).toEqual({ error: expect.stringContaining(`${UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE} active notes`) });
    expect(calls).not.toContain('insert');
  });

  it('fails closed when the count is not a number', async () => {
    state.activeCount = undefined;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect('error' in r).toBe(true);
    expect(calls).not.toContain('insert');
  });

  it('refuses outside a DB context (no transaction to hold the lock)', async () => {
    state.inContext = false;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect('error' in r).toBe(true);
    expect(calls.filter((c) => c !== 'device')).toEqual([]);
  });

  it('refuses a missing or over-cap expiry (the handler should have set one)', async () => {
    for (const expiresAt of [undefined, inDays(UNATTENDED_NOTE_MAX_EXPIRY_DAYS + 1)]) {
      calls.length = 0;
      const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, expiresAt, { unattended: true });
      expect('error' in r).toBe(true);
      expect(calls).not.toContain('insert');
    }
  });

  it('does not lock or count for an inaccessible device', async () => {
    state.deviceRows = [];
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect(r).toEqual({ error: 'Device not found or access denied' });
    expect(calls).toEqual(['device']);
  });

  it('takes no lock and counts nothing without the flag', async () => {
    state.activeCount = 1_000;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth);
    expect('error' in r).toBe(false);
    expect(calls).toEqual(['device', 'insert']);
  });
});
