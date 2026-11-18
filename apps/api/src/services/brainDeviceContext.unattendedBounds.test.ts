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
          if (projection && 'active' in projection) {
            calls.push('count');
            return Promise.resolve([{ active: state.activeCount, recent: 0 }]);
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
  aiToolExecutions: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
  gt: vi.fn((...args: unknown[]) => ({ _gt: args })),
  inArray: vi.fn((...args: unknown[]) => ({ _inArray: args })),
  isNull: vi.fn((col: unknown) => ({ _isNull: col })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
  count: vi.fn(() => ({ _count: true })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: strings.join('?'), values })),
}));

import { createDeviceContext } from './brainDeviceContext';
import {
  UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE,
  UNATTENDED_NOTE_MAX_EXPIRY_DAYS,
  UNATTENDED_NOTE_UNAVAILABLE_MESSAGE,
} from './deviceNoteBounds';
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

  it('keys the lock on the stored device id, not the caller-supplied spelling (Strix)', async () => {
    const stored = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    state.deviceRows = [{ id: stored, orgId: 'org-1' }];
    await createDeviceContext(stored.toUpperCase(), 'issue', 'note', null, auth, inDays(30), { unattended: true });
    const lock = calls.find((c) => c.startsWith('execute:'))!;
    expect(lock).toContain(`brain_device_context:${stored}`);
    expect(lock).not.toContain(stored.toUpperCase());
  });

  it('two differently-cased spellings written in parallel share one lock key (Strix #12152)', async () => {
    const stored = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    state.deviceRows = [{ id: stored, orgId: 'org-1' }];
    await Promise.all([
      createDeviceContext(stored, 'issue', 'a', null, auth, inDays(30), { unattended: true }),
      createDeviceContext(stored.toUpperCase(), 'issue', 'b', null, auth, inDays(30), { unattended: true }),
    ]);
    const locks = calls.filter((c) => c.startsWith('execute:'));
    expect(locks).toHaveLength(2);
    expect(locks[0]).toBe(locks[1]);
    expect(locks[0]).toContain(`brain_device_context:${stored}`);
  });

  it('writes nothing once the device has the maximum active notes', async () => {
    state.activeCount = UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect(r).toEqual({ error: expect.stringContaining(`${UNATTENDED_NOTE_MAX_ACTIVE_PER_DEVICE} active notes`) });
    expect(calls).not.toContain('insert');
  });

  it('fails closed on a count that is not a number, logs it, and does not claim the device is full', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.activeCount = undefined;
    const r = await createDeviceContext('dev-1', 'issue', 'note', null, auth, inDays(30), { unattended: true });
    expect(r).toEqual({ error: UNATTENDED_NOTE_UNAVAILABLE_MESSAGE });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('count'));
    expect(calls).not.toContain('insert');
    log.mockRestore();
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
