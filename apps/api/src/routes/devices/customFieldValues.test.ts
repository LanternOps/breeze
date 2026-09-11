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
    // Sets the permissions context the same way the real requirePermission does.
    // An `x-test-allowed-sites` header (comma-separated) opts the session into a
    // site allowlist so the site-scope branch in loadAccessibleDevice runs.
    // `x-test-drop-perms` simulates a (hypothetical) bug where a session reaches
    // the handler WITHOUT a permissions context — to prove the fail-closed guard.
    requirePermission: vi.fn(() => async (c: any, next: any) => {
      if (c.req.header('x-test-drop-perms')) {
        return next();
      }
      const allowedSiteIds = c.req.header('x-test-allowed-sites')
        ? (c.req.header('x-test-allowed-sites') as string).split(',')
        : undefined;
      c.set('permissions', {
        permissions: [],
        orgId: ORG_A,
        scope: 'organization',
        ...(allowedSiteIds ? { allowedSiteIds } : {}),
      });
      return next();
    }),
    requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  };
});

// API-key auth driven by test headers: x-test-org sets the key's org, and
// x-test-scopes is a comma-separated scope list. NOTE: this is app-layer only —
// these mocks stand in for apiKeyAuthMiddleware/requireApiKeyScope and do NOT
// establish the real DB RLS context. The reimplemented requireApiKeyScope below
// matches the real module's allow/deny shape (it throws 403) so the scope-gate
// branch in dualAuth is exercised, but RLS-level isolation is covered by the
// rls-coverage integration suite, not here.
vi.mock('../../middleware/apiKeyAuth', () => ({
  apiKeyAuthMiddleware: vi.fn((c: any, next: any) => {
    const org = c.req.header('x-test-org') ?? ORG_A;
    const scopes = (c.req.header('x-test-scopes') ?? '').split(',').filter(Boolean);
    c.set('apiKey', {
      id: API_KEY_ID,
      orgId: org,
      partnerId: null,
      allowedSiteIds: c.req.header('x-test-key-sites') === undefined
        ? undefined : c.req.header('x-test-key-sites').split(',').filter(Boolean),
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

// The write path audits SYNCHRONOUSLY via createAuditLog (awaited). Mock it so
// the assertions can verify attribution without a real DB. ANONYMOUS_ACTOR_ID
// and the client-IP helper stay real (cheap, no DB).
vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn().mockResolvedValue(undefined),
}));

// #3257 W04: every write now validates against the bounded, SYSTEM-context
// definition lookup BEFORE merging. Mocked at the module boundary rather than
// standing up the two-select db.select chain it drives internally (see
// services/customFields/queries.test.ts for that).
//
// #3257 W05: the actual write is `persistDeviceCustomFieldValues`, which
// upserts into `device_custom_field_values` (a real Drizzle
// onConflictDoUpdate) — mocked here too, same reasoning. The route no longer
// calls `db.update` at all; after the write it RE-READS the
// trigger-maintained `devices.custom_fields` projection via `db.select`, so
// `db.select` is now called TWICE per successful PATCH (device lookup, then
// projection re-read) — see `rigDeviceLookup` / `rigProjectionRead` below.
vi.mock('../../services/customFields/queries', () => ({
  loadVisibleCustomFieldDefinitions: vi.fn(),
  persistDeviceCustomFieldValues: vi.fn(),
}));

import { customFieldValuesRoutes } from './customFieldValues';
import { db } from '../../db';
import { createAuditLog } from '../../services/auditService';
import { loadVisibleCustomFieldDefinitions, persistDeviceCustomFieldValues } from '../../services/customFields/queries';
import type { VisibleCustomFieldDefinition } from '../../services/customFields/queries';

const ORG_A_ID = ORG_A;

function mockVisibleDefinitions(defs: Array<Partial<VisibleCustomFieldDefinition> & { fieldKey: string }>) {
  const full: VisibleCustomFieldDefinition[] = defs.map((d) => ({
    id: d.id ?? `def-${d.fieldKey}`,
    fieldKey: d.fieldKey,
    name: d.name ?? d.fieldKey,
    type: d.type ?? 'text',
    options: d.options ?? null,
    deviceTypes: d.deviceTypes ?? null,
    required: d.required ?? false,
    scriptWrite: d.scriptWrite ?? false,
    orgId: d.orgId ?? ORG_A_ID,
    partnerId: d.partnerId ?? null,
  }));
  vi.mocked(loadVisibleCustomFieldDefinitions).mockResolvedValue(full);
}

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

// `db.select` is called once per request for the device lookup
// (`getDeviceWithOrgCheck`, in helpers.ts) and — for a PATCH that reaches the
// write — a SECOND time for the post-write projection re-read. Each rig
// queues exactly one `mockReturnValueOnce`, so call order = registration
// order: register `rigDeviceLookup` first, then `rigProjectionRead` (when the
// flow is expected to reach it) for every test.
function rigDeviceLookup(device: unknown) {
  const limit = vi.fn().mockResolvedValue(device ? [device] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
}

// The re-read of `devices.custom_fields` (the trigger-maintained projection)
// that now follows `persistDeviceCustomFieldValues` — replaces the old
// `db.update(...).returning()` rig. `updatedRow` is a bare
// `{ customFields: ... }` shape, matching the route's
// `db.select({ customFields: devices.customFields })`.
function rigProjectionRead(updatedRow: { customFields: unknown } | null) {
  const limit = vi.fn().mockResolvedValue(updatedRow ? [updatedRow] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  vi.mocked(db.select).mockReturnValueOnce({ from } as never);
  return { from, where, limit };
}

describe('device custom-field value routes (#2066)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', customFieldValuesRoutes);
    // Default: the free-form field keys used by the pre-existing tests below
    // (predating per-value validation) resolve to a permissive text
    // definition, so those tests keep asserting the merge/audit/isolation
    // behaviour they were written for rather than becoming validation tests.
    mockVisibleDefinitions([{ fieldKey: 'bitlocker_recovery_key' }, { fieldKey: 'note' }]);
    // Return value is never read by the route (it re-reads the projection
    // instead), but must resolve rather than throw.
    vi.mocked(persistDeviceCustomFieldValues).mockResolvedValue([]);
  });

  describe('API-key write path', () => {
    it('writes a custom-field value with a devices:write API key', async () => {
      rigDeviceLookup(makeDevice());
      rigProjectionRead({ customFields: { existing_field: 'keep-me', bitlocker_recovery_key: 'ABC-123' } });

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
      // Merge semantics: existing values are preserved alongside the new one
      // (now the upsert only touching the requested key, echoed back via the
      // re-read projection rather than an app-layer merged object).
      expect(body.customFields).toEqual({ existing_field: 'keep-me', bitlocker_recovery_key: 'ABC-123' });
      // The write itself goes to `device_custom_field_values`, source 'api'
      // for an API-key caller (#3257 W05).
      expect(vi.mocked(persistDeviceCustomFieldValues)).toHaveBeenCalledWith(
        DEVICE_ID,
        ORG_A,
        [{ definitionId: 'def-bitlocker_recovery_key', fieldKey: 'bitlocker_recovery_key', type: 'text', value: 'ABC-123' }],
        'api',
      );
      // Audited synchronously as an api_key actor (not anonymous, not a user).
      expect(vi.mocked(createAuditLog)).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'api_key',
          actorId: API_KEY_ID,
          action: 'device.custom_field.update',
          orgId: ORG_A,
          initiatedBy: 'integration',
          result: 'success',
        }),
      );
    });

    it('rejects an API key that lacks the devices:write scope (403)', async () => {
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
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('does not let a key write a custom field on a device in another org (404)', async () => {
      // Device belongs to ORG_B; key is scoped to ORG_A. The org-scoped lookup
      // denies access, so the write never happens (cross-tenant isolation).
      rigDeviceLookup(makeDevice({ orgId: ORG_B }));

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
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
      expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    });

    it('rejects an empty field map (400)', async () => {
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

    it('rejects a non-scalar field value (400)', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:write',
        },
        // A structured object is not an allowed value — only string/number/boolean/null.
        body: JSON.stringify({ blob: { nested: 'no' } }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('fails closed if the projection re-read finds no row (404, not a false 200)', async () => {
      // The device passes the org-scoped lookup and the write happens, but the
      // post-write re-read of `devices.custom_fields` returns no row — the
      // RLS-silent-zero-row failure mode. The handler must 404, not report
      // success. (#3257 W05: the write itself is now an upsert into
      // `device_custom_field_values`, which has no "matched zero rows" outcome
      // of its own — this is the re-read's failure mode instead.)
      rigDeviceLookup(makeDevice());
      rigProjectionRead(null);

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
      // The sensitive write must not be reported as audited success.
      expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    });
  });

  describe('delegated API-key site scope', () => {
    it.each([
      ['GET', 'allowed-other-site'], ['PATCH', 'allowed-other-site'],
      ['GET', ''], ['PATCH', ''],
    ])('denies %s outside the live allowlist %s without mutation', async (method, sites) => {
      rigDeviceLookup(makeDevice({ siteId: 'denied-site' }));
      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method,
        headers: { 'X-API-Key': 'brz_test', 'x-test-scopes': 'devices:read,devices:write',
          'x-test-key-sites': sites, 'Content-Type': 'application/json' },
        ...(method === 'PATCH' ? { body: JSON.stringify({ note: 'unchanged' }) } : {}),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Access to this site denied' });
      expect(persistDeviceCustomFieldValues).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
    });

    it('permits an allowed-site key read', async () => {
      rigDeviceLookup(makeDevice({ siteId: 'allowed-site' }));
      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        headers: { 'X-API-Key': 'brz_test', 'x-test-scopes': 'devices:read', 'x-test-key-sites': 'allowed-site' },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ customFields: { existing_field: 'keep-me' } });
    });
  });

  describe('site-scope gate (JWT session with allowedSiteIds)', () => {
    const SITE_IN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const SITE_OUT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    it('rejects a PATCH when the device site is outside the allowlist (403, no write)', async () => {
      rigDeviceLookup(makeDevice({ siteId: SITE_OUT }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token',
          'x-test-allowed-sites': SITE_IN,
        },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
      expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    });

    it('rejects a GET when the device site is outside the allowlist (403)', async () => {
      rigDeviceLookup(makeDevice({ siteId: SITE_OUT, customFields: { asset_tag: 'A-42' } }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'GET',
        headers: { Authorization: 'Bearer session-token', 'x-test-allowed-sites': SITE_IN },
      });

      expect(res.status).toBe(403);
    });

    it('fails closed if a SESSION reaches the handler with no permissions context (403, no write)', async () => {
      // Simulates a dropped requirePermission gate on the JWT path. A user caller
      // with no permissions context must be denied, never silently skip the site
      // check — only org-scoped API keys legitimately carry no permissions.
      rigDeviceLookup(makeDevice({ siteId: SITE_OUT }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token',
          'x-test-drop-perms': '1',
        },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(403);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
      expect(vi.mocked(createAuditLog)).not.toHaveBeenCalled();
    });

    it('allows a PATCH when the device site is inside the allowlist', async () => {
      rigDeviceLookup(makeDevice({ siteId: SITE_IN }));
      rigProjectionRead({ customFields: { existing_field: 'keep-me', note: 'hi' } });

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer session-token',
          'x-test-allowed-sites': `${SITE_IN},${SITE_OUT}`,
        },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(200);
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
      rigProjectionRead({ customFields: { existing_field: 'keep-me', note: 'hi' } });

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ note: 'hi' }),
      });

      expect(res.status).toBe(200);
      expect(vi.mocked(createAuditLog)).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'user', actorId: USER_ID, initiatedBy: 'manual', result: 'success' }),
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

  describe('value validation against the definition (#3257 W04)', () => {
    it('rejects a value whose type does not match its definition', async () => {
      mockVisibleDefinitions([{ fieldKey: 'rack_units', type: 'number' }]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ rack_units: 'abc' }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'invalid-custom-field-value',
        fields: [{ fieldKey: 'rack_units', reason: 'invalid_type' }],
      });
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('rejects a key with no visible definition', async () => {
      mockVisibleDefinitions([]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ nope: 'x' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).fields).toEqual([{ fieldKey: 'nope', reason: 'unknown_field' }]);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('rejects a dropdown value outside options.choices', async () => {
      mockVisibleDefinitions([
        { fieldKey: 'tier', type: 'dropdown', options: { choices: [{ label: 'Gold', value: 'gold' }] } },
      ]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ tier: 'bronze' }),
      });

      expect((await res.json()).fields).toEqual([{ fieldKey: 'tier', reason: 'not_a_choice' }]);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range number', async () => {
      mockVisibleDefinitions([{ fieldKey: 'rack_units', type: 'number', options: { min: 0, max: 8 } }]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ rack_units: 99 }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).fields).toEqual([{ fieldKey: 'rack_units', reason: 'out_of_range' }]);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('is all-or-nothing on a MIXED valid+invalid payload: one bad key rejects the whole PATCH', async () => {
      // The single-key tests above can't distinguish "atomic across the whole
      // map" from "the one field it saw happened to fail" — this is the case
      // that actually exercises the all-or-nothing contract.
      mockVisibleDefinitions([
        { fieldKey: 'rack_units', type: 'number' },
        { fieldKey: 'notes', type: 'text' },
      ]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ rack_units: 'abc', notes: 'a perfectly valid note' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).fields).toEqual([{ fieldKey: 'rack_units', reason: 'invalid_type' }]);
      // The valid `notes` key must not be written even though it validated fine.
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('rejects a value for a definition scoped to a device type the device is not', async () => {
      mockVisibleDefinitions([{ fieldKey: 'rustdesk_id', type: 'text', deviceTypes: ['windows'] }]);
      rigDeviceLookup(makeDevice({ osType: 'macos' }));

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ rustdesk_id: 'abc123' }),
      });

      expect(res.status).toBe(400);
      expect((await res.json()).fields).toEqual([{ fieldKey: 'rustdesk_id', reason: 'not_applicable_to_device' }]);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });

    it('treats an empty string as a clear for a dropdown field, not a rejection', async () => {
      // Regression: the device-edit UI's <select> reports a clear as ''.
      mockVisibleDefinitions([{ fieldKey: 'tier', type: 'dropdown', options: { choices: ['gold'] } }]);
      rigDeviceLookup(makeDevice());
      rigProjectionRead({ customFields: { existing_field: 'keep-me', tier: null } });

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ tier: '' }),
      });

      expect(res.status).toBe(200);
    });

    it('stores the COERCED value, not the raw string', async () => {
      // #3257 W05: there is no `db.update` call to inspect anymore — the
      // coerced value is what `validateCustomFieldMap` resolves into
      // `CustomFieldValueWrite.value`, captured here via the
      // `persistDeviceCustomFieldValues` mock instead.
      mockVisibleDefinitions([{ fieldKey: 'rack_units', type: 'number' }]);
      rigDeviceLookup(makeDevice());
      rigProjectionRead({ customFields: { rack_units: 4 } });

      await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' },
        body: JSON.stringify({ rack_units: '4' }),
      });

      expect(vi.mocked(persistDeviceCustomFieldValues)).toHaveBeenCalledWith(
        DEVICE_ID,
        ORG_A,
        [{ definitionId: 'def-rack_units', fieldKey: 'rack_units', type: 'number', value: 4 }],
        'manual',
      );
    });

    it('rejects an API-key write that fails validation, same as a session write', async () => {
      // The API-key branch is the trivially scriptable one; validating only
      // the JWT branch would leave the interesting path open.
      mockVisibleDefinitions([{ fieldKey: 'rack_units', type: 'number' }]);
      rigDeviceLookup(makeDevice());

      const res = await app.request(`/devices/${DEVICE_ID}/custom-fields`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'brz_test',
          'x-test-org': ORG_A,
          'x-test-scopes': 'devices:write',
        },
        body: JSON.stringify({ rack_units: 'abc' }),
      });

      expect(res.status).toBe(400);
      expect(vi.mocked(persistDeviceCustomFieldValues)).not.toHaveBeenCalled();
    });
  });
});
