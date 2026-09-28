import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * AI device verifiers never resolve a device parked in a holding org — not
 * even for a system-scope session, whose org condition is empty. The lookup
 * carries the shared parked-device predicate; the real-DB half lives in
 * integration/parkedRemoteAndAi.integration.test.ts.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  hasDbAccessContext: vi.fn(() => false),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { verifyDeviceAccess } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const DEVICE = '33333333-3333-3333-3333-333333333333';

function systemAuth(): AuthContext {
  return {
    user: { id: 'system', email: 'system', name: 'System' },
    token: {} as any,
    partnerId: null,
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

beforeEach(() => vi.clearAllMocks());

describe('verifyDeviceAccess excludes parked devices', () => {
  it('adds the parked-device predicate to the lookup for a system-scope caller', async () => {
    const where = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
    vi.mocked(db.select).mockReturnValue({ from: vi.fn().mockReturnValue({ where }) } as any);

    const result = await verifyDeviceAccess(DEVICE, systemAuth());

    expect(result).toEqual({ error: 'Device not found or access denied' });
    const rendered = new PgDialect().sqlToQuery(where.mock.calls[0]![0]).sql;
    expect(rendered).toContain("parked_org.type = 'unassigned_pool'");
  });

  it('every AI device verifier in services/ carries the parked-device predicate', () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    let verifiers = 0;
    for (const name of readdirSync(dir)) {
      if (!/^aiTools.*\.ts$/.test(name) || name.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, name), 'utf8');
      const re = /async function verifyDeviceAccess\([\s\S]*?\n}\n/g;
      for (const m of text.matchAll(re)) {
        verifiers++;
        if (!m[0].includes('notParkedDeviceCondition()')) offenders.push(name);
      }
    }
    expect(verifiers).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
