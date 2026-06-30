import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Tests for the API-key-authenticated device custom-field VALUE endpoints
// (issue #2066). The bug: writing a custom-field value was only reachable via
// PATCH /devices/:id, which is gated on the session-JWT `authMiddleware` and so
// rejected an `X-API-Key` request with 401 before any handler ran. These tests
// exercise the new dual-auth (API key OR JWT) value endpoints and assert the
// API-key write path succeeds while tenant isolation + scope gates still hold.

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const API_KEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

// Use the real schema so the route's real `eq(devices.id,...)`/`and(...)` and the
// real `getDeviceWithOrgCheck` helper run against the mocked db query chain.
vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

// Realistic JWT auth: 401 when there's no Bearer header (mirrors the real
// authMiddleware), so a test that hits the API-key branch proves it never
// touches the session-only gate.
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      const header = c.req.header('Authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
      }
      c.set('auth', {
        user: { id: USER_ID, email: 'tech@example.com' },
        scope: 'organization',
        orgId: ORG_A,
        partnerId: null,
        accessibleOrgIds: [ORG_A],
        canAccessOrg: (orgId: string) => orgId === ORG_A,
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn(() => async (c: any, next: any) => {
      c.set('permissions', { permissions: [], orgId: ORG_A, scope: 'organization' });
      return next();
    }),
    requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

// API-key auth driven by test headers: x-test-org sets the key's org, and
// x-test-scopes is a comma-separated scope list. requireApiKeyScope is the real
// allow/deny logic so the under-scoped 403 path is genuinely exercised.
vi.mock('../../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((c: any, next: any) => {
    const org = c.req.header('x-test-org') ?? ORG_A;
    const scopes = (c.req.header('x-test-scopes') ?? '').split(',').filter(Boolean);
    c.set('apiKey', {
      id: API_KEY_ID,
      orgId: org,
      partnerId: null,
      name: 'Automation key',
      keyPrefix: 'brz_test',
      scopes,
      rateLimit: 1000,
      createdBy: USER_ID,
    });
    return next();
  }),
  // Mirrors the real requireApiKeyScope, which THROWS HTTPException(403) on an
  // insufficient scope (it does not return a Response). The dualAuth wrapper
  // relies on that throw to abort the chain.
  requireApiKeyScope: vi.fn((...required: string[]) => async (c: any, next: any) => {
    const apiKey = c.get('apiKey');
    if (!apiKey?.scopes?.length || !required.some((s) => apiKey.scopes.includes(s))) {
      throw new HTTPException(403, { message: 'API key does not have required permissions' });
    }
    return next();
  }),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

import { customFieldValuesRoutes } from './customFieldValues';
import { db } from '../../db';
import { writeAuditEvent } from '../../services/auditEvents';

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: DEVICE_ID,
    orgId: ORG_A,
    siteId: null,
    hostname: 'WS-001',
    displayName: 'Workstation 1',
    customFields: { existing_field: 'keep-me' },
    ...overrides,
  };
}

function rigDeviceLookup(device: unknown) {
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValue({ from } as never);
}

function rigUpdate(updatedRow: unknown) {
  const returning = vi.fn().mockResolvedValue(updatedRow ? [updatedRow] : []);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where, returning };
}

describe('device custom-field value routes (#2066)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', customFieldValuesRoutes);
  });

  describe('API-key write path', () => {
    it('writes a custom-field value with a devices:write API key', async () => {
      rigDeviceLookup(makeDevice());
      rigUpdate(makeDevice({ customFields: { existing_field: 'keep-me', bitlocker_recovery_key: 'ABC-123' } }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:write',
        },
        body: JSON.stringify({ bitlocker_recovery_key: 'ABC-123' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Merge semantics: existing values are preserved alongside the new one.
      expect(body.customFields).toEqual({ existing_field: 'keep-me', bitlocker_recovery_key: 'ABC-123' });
      // Audited as an api_key actor (not anonymous, not a user).
      expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorType: 'api_key', actorId: API_KEY_ID, action: 'device.custom_field.update', orgId: ORG_A }),
      );
    });

    it('rejects an API key that lacks the devices:write scope (403)', async () => {
      rigDeviceLookup(makeDevice());
      const updateSpy = rigUpdate(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:read',
        },
        body: JSON.stringify({ bitlocker_recovery_key: 'ABC-123' }),
      });

      expect(res.status).toBe(403);
      expect(updateSpy.set).not.toHaveBeenCalled();
    });

    it('does not let a key write a custom field on a device in another org (404)', async () => {
      // Device belongs to ORG_B; key is scoped to ORG_A. The org-scoped lookup
      // denies access, so the write never happens (cross-tenant isolation).
      rigDeviceLookup(makeDevice({ orgId: ORG_B }));
      const updateSpy = rigUpdate(makeDevice({ orgId: ORG_B }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:write',
        },
        body: JSON.stringify({ bitlocker_recovery_key: 'ABC-123' }),
      });

      expect(res.status).toBe(404);
      expect(updateSpy.set).not.toHaveBeenCalled();
      expect(vi.mocked(writeAuditEvent)).not.toHaveBeenCalled();
    });

    it('rejects an empty field map (400)', async () => {
      rigDeviceLookup(makeDevice());
      rigUpdate(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:write',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('API-key read path', () => {
    it('reads custom-field values with a devices:read API key', async () => {
      rigDeviceLookup(makeDevice({ customFields: { asset_tag: 'A-42' } }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'GET',
        headers: { 'X-API-Key': 'brz_test', 'x-test-org': ORG_A, 'x-test-scopes': 'devices:read' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.customFields).toEqual({ asset_tag: 'A-42' });
    });
  });

  describe('JWT session path', () => {
    it('writes a custom-field value with a Bearer session token', async () => {
      rigDeviceLookup(makeDevice());
      rigUpdate(makeDevice({ customFields: { existing_field: 'keep-me', note: 'hi' } }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(writeAuditEvent)).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorType: 'user', actorId: USER_ID }),
      );
    });

    it('rejects a request with neither an API key nor a Bearer token (401)', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(401);
    });
  });
});
