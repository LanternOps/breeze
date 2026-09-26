import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getDeviceMock } = vi.hoisted(() => ({ getDeviceMock: vi.fn() }));

vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return { ...actual, getDevice: getDeviceMock };
});

import { certExpiryHandler } from './certExpiry';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('certExpiryHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getDeviceMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('fires when the agent mTLS certificate expires inside the window and says which cert', async () => {
    getDeviceMock.mockResolvedValue({ mtlsCertExpiresAt: new Date(NOW.getTime() + 10 * DAY) });
    const result = await certExpiryHandler.evaluate({ type: 'cert_expiry', withinDays: 30 }, 'dev-1');
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(10);
    // The only certificate this handler can see is the agent's own mTLS client
    // cert; the description must not imply arbitrary endpoint certificates.
    expect(result.description).toMatch(/agent mTLS certificate/i);
  });

  it('does not fire when the certificate expires outside the window', async () => {
    getDeviceMock.mockResolvedValue({ mtlsCertExpiresAt: new Date(NOW.getTime() + 90 * DAY) });
    const result = await certExpiryHandler.evaluate({ type: 'cert_expiry', withinDays: 30 }, 'dev-1');
    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/agent mTLS certificate/i);
  });

  it('fires for an already-expired certificate', async () => {
    getDeviceMock.mockResolvedValue({ mtlsCertExpiresAt: new Date(NOW.getTime() - 2 * DAY) });
    const result = await certExpiryHandler.evaluate({ type: 'cert_expiry', withinDays: 30 }, 'dev-1');
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(-2);
  });

  it('reports no data when the agent has no mTLS certificate', async () => {
    getDeviceMock.mockResolvedValue({ mtlsCertExpiresAt: null });
    const result = await certExpiryHandler.evaluate({ type: 'cert_expiry', withinDays: 30 }, 'dev-1');
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('reports no data when the device is missing', async () => {
    getDeviceMock.mockResolvedValue(null);
    const result = await certExpiryHandler.evaluate({ type: 'cert_expiry', withinDays: 30 }, 'dev-1');
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });
});
