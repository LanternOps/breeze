import { describe, expect, it } from 'vitest';
import { isStreamDue, planCadence } from './scheduler';
import type { EdrCapabilities } from './types';

const cap = (over: Partial<EdrCapabilities> = {}): EdrCapabilities => ({
  tenantModel: 'partner', perTenantHost: false, detectionDelivery: 'poll',
  detectionStatusModel: 'reread_open_on_inventory', actions: [], endpointIdentifiers: ['hostname'],
  installer: 'none', requestBudget: { perSecond: 10 },
  defaultIntervals: { detectionsMinutes: 10, inventoryMinutes: 60 },
  maxActionTargets: 0, firstSyncLookbackDays: 30, tenantFetchConcurrency: 4, ...over,
});
const est = { perTenantDetection: 2, perTenantInventory: 3, perConnectionOverhead: 5 };

describe('planCadence', () => {
  it('defaults fit 200 companies at 10 req/s', () => {
    const r = planCadence({
      tenants: 200, mappedTenants: 200, capabilities: cap(),
      requested: { detectionsMinutes: null, inventoryMinutes: null }, estimatedCalls: est,
    });
    expect(r).toEqual({ detectionsMinutes: 10, inventoryMinutes: 60, lengthened: false });
  });

  it('doubles the interval until it fits and reports lengthened', () => {
    const r = planCadence({
      tenants: 200, mappedTenants: 200, capabilities: cap({ requestBudget: { perMinute: 30 } }),
      requested: { detectionsMinutes: null, inventoryMinutes: null }, estimatedCalls: est,
    });
    expect(r.lengthened).toBe(true);
    expect(r.detectionsMinutes).toBeGreaterThan(10);
    expect(Number.isInteger(Math.log2(r.detectionsMinutes / 10)) || Number.isInteger(Math.log2(r.inventoryMinutes / 60))).toBe(true);
    const load = (200 * 2 + 5) / r.detectionsMinutes + (200 * 3 + 5) / r.inventoryMinutes;
    expect(load).toBeLessThanOrEqual(30 * 0.8);
  });

  it('raises requested intervals below the adapter floor', () => {
    const r = planCadence({
      tenants: 1, mappedTenants: 1, capabilities: cap(),
      requested: { detectionsMinutes: 1, inventoryMinutes: 5 }, estimatedCalls: est,
    });
    expect(r).toEqual({ detectionsMinutes: 10, inventoryMinutes: 60, lengthened: false });
  });

  it('honours a requested interval above the floor', () => {
    const r = planCadence({
      tenants: 1, mappedTenants: 1, capabilities: cap(),
      requested: { detectionsMinutes: 30, inventoryMinutes: 120 }, estimatedCalls: est,
    });
    expect(r).toMatchObject({ detectionsMinutes: 30, inventoryMinutes: 120, lengthened: false });
  });

  it('treats incidents as one connection-wide call per cycle, independent of tenant count', () => {
    const r = planCadence({
      tenants: 100, mappedTenants: 100,
      capabilities: cap({ operationBudgets: { incidents: { perMinute: 2 } } }),
      requested: { detectionsMinutes: null, inventoryMinutes: null }, estimatedCalls: est,
    });
    expect(r).toEqual({ detectionsMinutes: 10, inventoryMinutes: 60, lengthened: false });
  });

  it('lengthens detections when even one incidents call per cycle exceeds the budget', () => {
    const r = planCadence({
      tenants: 1, mappedTenants: 1,
      capabilities: cap({ operationBudgets: { incidents: { perMinute: 0.05 } } }),
      requested: { detectionsMinutes: null, inventoryMinutes: null }, estimatedCalls: est,
    });
    // usable 0.04/min: 1/10 and 1/20 exceed it, 1/40 fits.
    expect(r.detectionsMinutes).toBe(40);
    expect(r.lengthened).toBe(true);
  });
});

describe('isStreamDue', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  it('is due when never run', () => expect(isStreamDue(null, 10, now)).toBe(true));
  it('is due exactly at the interval, not before', () => {
    expect(isStreamDue(new Date(now.getTime() - 10 * 60_000), 10, now)).toBe(true);
    expect(isStreamDue(new Date(now.getTime() - 9 * 60_000), 10, now)).toBe(false);
  });
});
