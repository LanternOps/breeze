import { describe, it, expect } from 'vitest';
import {
  optionalQueryBooleanSchema,
  mapNetworkChangeRow,
  resolveOrgId,
  networkEventTypes
} from './networkShared';
import type { AuthContext } from '../middleware/auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrgAuth(orgId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId: null,
    user: { id: 'user-1', email: 'user@test.com', name: 'Test' },
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => null,
  } as unknown as AuthContext;
}

function makePartnerAuth(orgIds: string[]): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: 'partner-1',
    user: { id: 'user-1', email: 'partner@test.com', name: 'Partner' },
    accessibleOrgIds: orgIds,
    canAccessOrg: (id: string) => orgIds.includes(id),
    orgCondition: () => null,
  } as unknown as AuthContext;
}

function makeSystemAuth(): AuthContext {
  return {
    scope: 'system',
    orgId: null,
    partnerId: null,
    user: { id: 'admin-1', email: 'admin@test.com', name: 'Admin' },
    accessibleOrgIds: null,
    canAccessOrg: () => true,
    orgCondition: () => null,
  } as unknown as AuthContext;
}

// ---------------------------------------------------------------------------
// networkEventTypes
// ---------------------------------------------------------------------------

describe('networkEventTypes', () => {
  it('should contain expected event type values', () => {
    expect(networkEventTypes).toContain('new_device');
    expect(networkEventTypes).toContain('device_disappeared');
    expect(networkEventTypes).toContain('device_changed');
    expect(networkEventTypes).toContain('rogue_device');
    expect(networkEventTypes).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// optionalQueryBooleanSchema
// ---------------------------------------------------------------------------

describe('optionalQueryBooleanSchema', () => {
  it('should return undefined for undefined input', () => {
    const result = optionalQueryBooleanSchema.parse(undefined);
    expect(result).toBeUndefined();
  });

  it('should pass through boolean values', () => {
    expect(optionalQueryBooleanSchema.parse(true)).toBe(true);
    expect(optionalQueryBooleanSchema.parse(false)).toBe(false);
  });

  it('should coerce string "true" to boolean true', () => {
    expect(optionalQueryBooleanSchema.parse('true')).toBe(true);
    expect(optionalQueryBooleanSchema.parse('TRUE')).toBe(true);
    expect(optionalQueryBooleanSchema.parse(' True ')).toBe(true);
  });

  it('should coerce string "false" to boolean false', () => {
    expect(optionalQueryBooleanSchema.parse('false')).toBe(false);
    expect(optionalQueryBooleanSchema.parse('FALSE')).toBe(false);
    expect(optionalQueryBooleanSchema.parse(' False ')).toBe(false);
  });

  it('should reject non-boolean strings', () => {
    expect(() => optionalQueryBooleanSchema.parse('yes')).toThrow();
    expect(() => optionalQueryBooleanSchema.parse('1')).toThrow();
    expect(() => optionalQueryBooleanSchema.parse('no')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mapNetworkChangeRow
// ---------------------------------------------------------------------------

describe('mapNetworkChangeRow', () => {
  it('should convert dates to ISO strings', () => {
    const row = {
      id: 'evt-1',
      orgId: 'org-1',
      siteId: 'site-1',
      baselineId: 'bl-1',
      profileId: null,
      eventType: 'new_device' as const,
      ipAddress: '192.168.1.100',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      hostname: 'test-host',
      vendor: null,
      deviceData: null,
      previousData: null,
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      notes: null,
      alertId: null,
      linkedDeviceId: null,
      detectedAt: new Date('2026-03-01T12:00:00Z'),
      createdAt: new Date('2026-03-01T12:00:00Z'),
    } as any;

    const mapped = mapNetworkChangeRow(row);

    expect(mapped.detectedAt).toBe('2026-03-01T12:00:00.000Z');
    expect(mapped.createdAt).toBe('2026-03-01T12:00:00.000Z');
    expect(mapped.acknowledgedAt).toBeNull();
  });

  it('should convert acknowledgedAt when present', () => {
    const row = {
      id: 'evt-1',
      orgId: 'org-1',
      siteId: 'site-1',
      baselineId: 'bl-1',
      profileId: null,
      eventType: 'device_changed' as const,
      ipAddress: '10.0.0.1',
      macAddress: null,
      hostname: null,
      vendor: null,
      deviceData: null,
      previousData: null,
      acknowledged: true,
      acknowledgedBy: 'user-1',
      acknowledgedAt: new Date('2026-03-02T08:00:00Z'),
      notes: 'checked',
      alertId: null,
      linkedDeviceId: null,
      detectedAt: new Date('2026-03-01T12:00:00Z'),
      createdAt: new Date('2026-03-01T12:00:00Z'),
    } as any;

    const mapped = mapNetworkChangeRow(row);

    expect(mapped.acknowledgedAt).toBe('2026-03-02T08:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// resolveOrgId
// ---------------------------------------------------------------------------

describe('resolveOrgId', () => {
  // ---- Organization scope ----

  describe('organization scope', () => {
    it('should return own orgId when no requested orgId', () => {
      const auth = makeOrgAuth('org-A');
      const result = resolveOrgId(auth);
      expect(result).toEqual({ orgId: 'org-A' });
    });

    it('should return own orgId when requested orgId matches', () => {
      const auth = makeOrgAuth('org-A');
      const result = resolveOrgId(auth, 'org-A');
      expect(result).toEqual({ orgId: 'org-A' });
    });

    it('should deny access when requested orgId differs', () => {
      const auth = makeOrgAuth('org-A');
      const result = resolveOrgId(auth, 'org-B');
      expect(result).toEqual({ error: 'Access to this organization denied', status: 403 });
    });

    it('should return 403 when org context has no orgId', () => {
      const auth = {
        ...makeOrgAuth('org-A'),
        orgId: null,
      } as unknown as AuthContext;

      const result = resolveOrgId(auth);
      expect(result).toEqual({ error: 'Organization context required', status: 403 });
    });
  });

  // ---- Partner scope ----

  describe('partner scope', () => {
    it('should allow access to requested org when accessible', () => {
      const auth = makePartnerAuth(['org-A', 'org-B']);
      const result = resolveOrgId(auth, 'org-B');
      expect(result).toEqual({ orgId: 'org-B' });
    });

    it('should deny access to inaccessible org', () => {
      const auth = makePartnerAuth(['org-A']);
      const result = resolveOrgId(auth, 'org-C');
      expect(result).toEqual({ error: 'Access to this organization denied', status: 403 });
    });

    it('should auto-select single org when no requestedOrgId', () => {
      const auth = makePartnerAuth(['org-A']);
      const result = resolveOrgId(auth);
      expect(result).toEqual({ orgId: 'org-A' });
    });

    it('should return null orgId for multi-org partner with no request and no requirement', () => {
      const auth = makePartnerAuth(['org-A', 'org-B']);
      const result = resolveOrgId(auth);
      expect(result).toEqual({ orgId: null });
    });

    it('should return error when requireForNonOrg is true and multi-org partner has no orgId', () => {
      const auth = makePartnerAuth(['org-A', 'org-B']);
      const result = resolveOrgId(auth, undefined, true);
      expect(result).toEqual({
        error: 'orgId is required when partner has multiple organizations',
        status: 400,
      });
    });

    it('should auto-resolve single org even when requireForNonOrg is true', () => {
      const auth = makePartnerAuth(['org-A']);
      const result = resolveOrgId(auth, undefined, true);
      expect(result).toEqual({ orgId: 'org-A' });
    });
  });

  // ---- System scope ----

  describe('system scope', () => {
    it('should return requested orgId', () => {
      const auth = makeSystemAuth();
      const result = resolveOrgId(auth, 'org-X');
      expect(result).toEqual({ orgId: 'org-X' });
    });

    it('should return null orgId when no request and not required', () => {
      const auth = makeSystemAuth();
      const result = resolveOrgId(auth);
      expect(result).toEqual({ orgId: null });
    });

    it('should return error when requireForNonOrg is true and no orgId', () => {
      const auth = makeSystemAuth();
      const result = resolveOrgId(auth, undefined, true);
      expect(result).toEqual({ error: 'orgId is required for system scope', status: 400 });
    });
  });

  // ---- Unknown scope ----

  describe('unknown scope', () => {
    it('should deny access for unrecognized scope', () => {
      const auth = {
        scope: 'unknown',
        orgId: null,
        partnerId: null,
        user: { id: 'u1' },
        accessibleOrgIds: [],
        canAccessOrg: () => false,
      } as unknown as AuthContext;

      const result = resolveOrgId(auth);
      expect(result).toEqual({ error: 'Access denied', status: 403 });
    });
  });
});
