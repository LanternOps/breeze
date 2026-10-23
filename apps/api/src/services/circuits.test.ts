import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  CircuitError,
  canSeeCircuit,
  circuitBodySchema,
  circuitDeleteSiteIds,
  circuitListQuerySchema,
  circuitPatchSchema,
  circuitPrimarySiteIds,
  circuitWriteSiteIds,
  interfaceRoleBodySchema,
  redactCircuitDto,
  servedSitesBodySchema,
  terminationBodySchema,
  type CircuitDto,
} from './circuits';

describe('circuit request schemas', () => {
  it('accepts a minimal circuit and defaults nothing persisted by the schema', () => {
    const parsed = circuitBodySchema.parse({ providerName: ' Acme Fiber ', cid: 'CID-001' });
    expect(parsed.providerName).toBe('Acme Fiber');
    expect(parsed.cid).toBe('CID-001');
    expect(parsed.administrativeStatus).toBeUndefined();
  });

  it('rejects blank provider and CID', () => {
    expect(circuitBodySchema.safeParse({ providerName: '   ', cid: 'x' }).success).toBe(false);
    expect(circuitBodySchema.safeParse({ providerName: 'x', cid: '' }).success).toBe(false);
  });

  it('rejects a non-positive bandwidth and unknown administrative status', () => {
    expect(circuitBodySchema.safeParse({ providerName: 'a', cid: 'b', bandwidthBps: 0 }).success).toBe(false);
    expect(circuitBodySchema.safeParse({ providerName: 'a', cid: 'b', bandwidthBps: -5 }).success).toBe(false);
    expect(circuitBodySchema.safeParse({ providerName: 'a', cid: 'b', administrativeStatus: 'live' }).success).toBe(false);
  });

  it('allows partial patches but still validates the fields it carries', () => {
    expect(circuitPatchSchema.safeParse({ administrativeStatus: 'suspended' }).success).toBe(true);
    expect(circuitPatchSchema.safeParse({ cid: '' }).success).toBe(false);
  });

  it('requires a UUID for termination and for served sites', () => {
    expect(terminationBodySchema.safeParse({ interfaceId: '3f1c0d52-7a7b-4b8e-9d5a-1e2f3a4b5c6d' }).success).toBe(true);
    expect(terminationBodySchema.safeParse({ interfaceId: 'not-a-uuid' }).success).toBe(false);
    expect(servedSitesBodySchema.safeParse({ siteIds: ['not-a-uuid'] }).success).toBe(false);
    expect(servedSitesBodySchema.safeParse({ siteIds: [] }).success).toBe(true);
  });

  it('accepts only the wan role or a clear (null) for interface role', () => {
    expect(interfaceRoleBodySchema.safeParse({ role: 'wan' }).success).toBe(true);
    expect(interfaceRoleBodySchema.safeParse({ role: null }).success).toBe(true);
    expect(interfaceRoleBodySchema.safeParse({ role: 'lan' }).success).toBe(false);
  });
});

describe('CircuitError', () => {
  it('carries a stable code and HTTP status for the route layer', () => {
    const err = new CircuitError('Interface must be marked as WAN', 'INTERFACE_NOT_WAN', 422);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('INTERFACE_NOT_WAN');
    expect(err.status).toBe(422);
    expect(err.name).toBe('CircuitError');
  });
});

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SITE_C = '33333333-3333-4333-8333-333333333333';

function dto(overrides: Partial<CircuitDto> = {}): CircuitDto {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    orgId: '55555555-5555-4555-8555-555555555555',
    providerName: 'Acme',
    cid: 'CID-1',
    bandwidthBps: null,
    serviceType: null,
    administrativeStatus: 'active',
    terminationState: 'unassigned',
    termination: null,
    additionalServedSites: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function assigned(primary: string, served: string[] = []): CircuitDto {
  return dto({
    terminationState: 'assigned',
    termination: {
      interfaceId: '66666666-6666-4666-8666-666666666666',
      interfaceName: 'Gi0/1',
      asset: null,
      primarySite: { id: primary, name: `site-${primary.slice(0, 2)}` },
      placement: null,
    },
    additionalServedSites: served.map((id) => ({ id, name: `site-${id.slice(0, 2)}` })),
  });
}

describe('circuit list query', () => {
  it('defaults the page size and bounds it', () => {
    expect(circuitListQuerySchema.parse({}).limit).toBe(50);
    expect(circuitListQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(circuitListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
    expect(circuitListQuerySchema.parse({ limit: '200' }).limit).toBe(200);
  });

  it('accepts only a UUID cursor and rejects unknown keys', () => {
    expect(circuitListQuerySchema.safeParse({ cursor: SITE_A }).success).toBe(true);
    expect(circuitListQuerySchema.safeParse({ cursor: 'nope' }).success).toBe(false);
    expect(circuitListQuerySchema.safeParse({ orgId: SITE_A }).success).toBe(false);
  });
});

describe('circuit site visibility (spec 7.2)', () => {
  it('shows every circuit to an unrestricted caller', () => {
    expect(canSeeCircuit(dto(), { allowedSiteIds: null })).toBe(true);
    expect(canSeeCircuit(assigned(SITE_A), { allowedSiteIds: null })).toBe(true);
  });

  it('shows an assigned circuit only through its primary site', () => {
    const circuit = assigned(SITE_A, [SITE_B]);
    expect(canSeeCircuit(circuit, { allowedSiteIds: [SITE_A] })).toBe(true);
    // An accessible served site alone does not expose a circuit that has a current termination.
    expect(canSeeCircuit(circuit, { allowedSiteIds: [SITE_B] })).toBe(false);
    expect(canSeeCircuit(circuit, { allowedSiteIds: [SITE_C] })).toBe(false);
  });

  it('shows a circuit without a current termination only through an accessible served site', () => {
    const unassigned = dto({ additionalServedSites: [{ id: SITE_B, name: 'b' }] });
    expect(canSeeCircuit(unassigned, { allowedSiteIds: [SITE_B] })).toBe(true);
    expect(canSeeCircuit(unassigned, { allowedSiteIds: [SITE_A] })).toBe(false);
    expect(canSeeCircuit(dto({ terminationState: 'needs_reassociation' }), { allowedSiteIds: [SITE_A] })).toBe(false);
  });

  it('hides everything from a restricted caller with no sites', () => {
    expect(canSeeCircuit(assigned(SITE_A), { allowedSiteIds: [] })).toBe(false);
    expect(canSeeCircuit(dto(), { allowedSiteIds: [] })).toBe(false);
  });

  it('redacts served-site names the caller cannot access without hint of their existence', () => {
    const circuit = assigned(SITE_A, [SITE_B, SITE_C]);
    const redacted = redactCircuitDto(circuit, { allowedSiteIds: [SITE_A, SITE_B] });
    expect(redacted.additionalServedSites).toEqual([{ id: SITE_B, name: 'site-22' }]);
    expect(JSON.stringify(redacted)).not.toContain(SITE_C);
    expect(redactCircuitDto(circuit, { allowedSiteIds: null })).toBe(circuit);
  });
});

describe('circuit write sites (spec 7.2)', () => {
  it('requires the primary site for an assigned circuit', () => {
    const circuit = assigned(SITE_A, [SITE_B]);
    expect(circuitPrimarySiteIds(circuit)).toEqual([SITE_A]);
    expect(circuitWriteSiteIds(circuit, { allowedSiteIds: [SITE_A] })).toEqual([SITE_A]);
    expect(circuitWriteSiteIds(circuit, { allowedSiteIds: null })).toEqual([SITE_A]);
  });

  it('requires every served site from a restricted caller editing a circuit without a termination', () => {
    const unassigned = dto({ additionalServedSites: [{ id: SITE_B, name: 'b' }, { id: SITE_C, name: 'c' }] });
    expect(circuitWriteSiteIds(unassigned, { allowedSiteIds: [SITE_B, SITE_C] })).toEqual([SITE_B, SITE_C]);
    expect(circuitWriteSiteIds(unassigned, { allowedSiteIds: null })).toEqual([]);
  });

  it('requires the primary plus every served site to delete', () => {
    expect(circuitDeleteSiteIds(assigned(SITE_A, [SITE_B, SITE_C]))).toEqual([SITE_A, SITE_B, SITE_C]);
    expect(circuitDeleteSiteIds(dto())).toEqual([]);
  });
});
