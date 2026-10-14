import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  CircuitError,
  circuitBodySchema,
  circuitPatchSchema,
  interfaceRoleBodySchema,
  servedSitesBodySchema,
  terminationBodySchema,
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
