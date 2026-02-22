import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================
// Mocks
// ============================================

const mockSelectFrom = vi.fn();
const mockInsertValues = vi.fn();
const mockUpdateSet = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockSelectFrom })),
    insert: vi.fn(() => ({ values: mockInsertValues })),
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
}));

vi.mock('../db/schema', () => ({
  brainDeviceContext: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    contextType: 'context_type',
    summary: 'summary',
    details: 'details',
    createdAt: 'created_at',
    expiresAt: 'expires_at',
    resolvedAt: 'resolved_at',
  },
  devices: {
    id: 'id',
    orgId: 'org_id',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ _eq: args })),
  and: vi.fn((...args: unknown[]) => ({ _and: args })),
  or: vi.fn((...args: unknown[]) => ({ _or: args })),
  gt: vi.fn((...args: unknown[]) => ({ _gt: args })),
  isNull: vi.fn((col: unknown) => ({ _isNull: col })),
  desc: vi.fn((col: unknown) => ({ _desc: col })),
}));

import {
  getActiveDeviceContext,
  getAllDeviceContext,
  createDeviceContext,
  resolveDeviceContext,
} from './brainDeviceContext';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

// ============================================
// Helpers
// ============================================

function makeAuth(orgId: string): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: vi.fn(() => ({ _eq: ['org_id', orgId] })),
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

function makeSystemAuth(): AuthContext {
  return {
    user: { id: 'user-sys', email: 'admin@test.com', name: 'Admin' },
    orgId: null,
    scope: 'system',
    accessibleOrgIds: null,
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function makeContextEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ctx-1',
    orgId: 'org-1',
    deviceId: 'dev-1',
    contextType: 'issue',
    summary: 'Disk full',
    details: null,
    createdAt: new Date('2026-02-20T07:00:00Z'),
    expiresAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

/** Set up mock chain: db.select().from().where().orderBy().limit() */
function mockSelectChain(rows: unknown[]) {
  mockSelectFrom.mockReturnValue({
    where: vi.fn().mockReturnValue({
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

/** Set up mock chain: db.select().from().where().limit() (for device lookup) */
function mockDeviceLookup(device: unknown | null) {
  mockSelectFrom.mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(device ? [device] : []),
    }),
  });
}

/** Set up mock chain: db.insert().values().returning() */
function mockInsertChain(entry: unknown) {
  mockInsertValues.mockReturnValue({
    returning: vi.fn().mockResolvedValue([entry]),
  });
}

/** Set up mock chain: db.update().set().where().returning() */
function mockUpdateChain(returned: unknown[]) {
  mockUpdateSet.mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(returned),
    }),
  });
}

// ============================================
// Tests
// ============================================

describe('brainDeviceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- getActiveDeviceContext ---

  describe('getActiveDeviceContext', () => {
    it('returns active entries for a device', async () => {
      const entry = makeContextEntry();
      mockSelectChain([entry]);

      const result = await getActiveDeviceContext('dev-1', makeAuth('org-1'));

      expect(result).toEqual([entry]);
      expect(db.select).toHaveBeenCalled();
    });

    it('returns empty array when no context exists', async () => {
      mockSelectChain([]);

      const result = await getActiveDeviceContext('dev-1', makeAuth('org-1'));

      expect(result).toEqual([]);
    });

    it('applies org condition for org-scoped auth', async () => {
      const auth = makeAuth('org-1');
      mockSelectChain([]);

      await getActiveDeviceContext('dev-1', auth);

      expect(auth.orgCondition).toHaveBeenCalled();
    });

    it('skips org condition for system-scoped auth', async () => {
      const auth = makeSystemAuth();
      mockSelectChain([]);

      await getActiveDeviceContext('dev-1', auth);

      // orgCondition returns undefined for system scope, so it shouldn't be added
      expect(auth.orgCondition).toHaveBeenCalled();
    });
  });

  // --- getAllDeviceContext ---

  describe('getAllDeviceContext', () => {
    it('returns all entries including resolved', async () => {
      const active = makeContextEntry();
      const resolved = makeContextEntry({
        id: 'ctx-2',
        resolvedAt: new Date('2026-02-21T00:00:00Z'),
      });
      mockSelectChain([active, resolved]);

      const result = await getAllDeviceContext('dev-1', makeAuth('org-1'));

      expect(result).toHaveLength(2);
    });

    it('applies org condition', async () => {
      const auth = makeAuth('org-1');
      mockSelectChain([]);

      await getAllDeviceContext('dev-1', auth);

      expect(auth.orgCondition).toHaveBeenCalled();
    });
  });

  // --- createDeviceContext ---

  describe('createDeviceContext', () => {
    it('creates a context entry for an accessible device', async () => {
      const device = { id: 'dev-1', orgId: 'org-1' };
      const created = makeContextEntry();

      // First call: device lookup, second call: insert
      mockDeviceLookup(device);
      mockInsertChain(created);

      const result = await createDeviceContext(
        'dev-1',
        'issue',
        'Disk full',
        null,
        makeAuth('org-1'),
      );

      expect(result).toEqual(created);
      expect(db.insert).toHaveBeenCalled();
    });

    it('returns error when device not found', async () => {
      mockDeviceLookup(null);

      const result = await createDeviceContext(
        'dev-nonexistent',
        'issue',
        'Test',
        null,
        makeAuth('org-1'),
      );

      expect(result).toEqual({ error: 'Device not found or access denied' });
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('passes details and expiresAt to insert', async () => {
      const device = { id: 'dev-1', orgId: 'org-1' };
      const details = { symptom: 'slow', workaround: 'reboot' };
      const expiresAt = new Date('2026-03-01T00:00:00Z');
      const created = makeContextEntry({ details, expiresAt });

      mockDeviceLookup(device);
      mockInsertChain(created);

      const result = await createDeviceContext(
        'dev-1',
        'quirk',
        'Runs hot',
        details,
        makeAuth('org-1'),
        expiresAt,
      );

      expect(result).toEqual(created);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          details,
          expiresAt,
        }),
      );
    });

    it('defaults expiresAt to null when not provided', async () => {
      const device = { id: 'dev-1', orgId: 'org-1' };
      mockDeviceLookup(device);
      mockInsertChain(makeContextEntry());

      await createDeviceContext('dev-1', 'issue', 'Test', null, makeAuth('org-1'));

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: null }),
      );
    });

    it('applies org condition on device lookup', async () => {
      const auth = makeAuth('org-1');
      mockDeviceLookup(null);

      await createDeviceContext('dev-1', 'issue', 'Test', null, auth);

      expect(auth.orgCondition).toHaveBeenCalled();
    });
  });

  // --- resolveDeviceContext ---

  describe('resolveDeviceContext', () => {
    it('returns updated: true when entry is found and resolved', async () => {
      mockUpdateChain([{ id: 'ctx-1' }]);

      const result = await resolveDeviceContext('ctx-1', makeAuth('org-1'));

      expect(result).toEqual({ updated: true });
    });

    it('returns updated: false when entry not found or wrong org', async () => {
      mockUpdateChain([]);

      const result = await resolveDeviceContext('ctx-nonexistent', makeAuth('org-1'));

      expect(result).toEqual({ updated: false });
    });

    it('applies org condition', async () => {
      const auth = makeAuth('org-1');
      mockUpdateChain([]);

      await resolveDeviceContext('ctx-1', auth);

      expect(auth.orgCondition).toHaveBeenCalled();
    });
  });
});
