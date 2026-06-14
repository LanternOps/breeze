import { beforeEach, describe, expect, it, vi } from 'vitest';

// Verify upsertAgentWarranty maps agent-reported coverage kind to the right
// persisted status / is_subscription flag without a live DB (#1320).
const insertMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: { deviceId: 'deviceWarranty.deviceId' },
  deviceHardware: {},
  devices: {},
}));

vi.mock('./warrantyProviders', () => ({
  getProviderForManufacturer: vi.fn(),
  normalizeManufacturer: (m: string) => m.toLowerCase(),
}));

const evaluateWarrantyAlertsMock = vi.fn().mockResolvedValue(null);
vi.mock('./warrantyAlertEvaluator', () => ({
  evaluateWarrantyAlerts: (...args: unknown[]) => evaluateWarrantyAlertsMock(...args),
}));

import { upsertAgentWarranty } from './warrantySync';

const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** Capture the values passed to db.insert().values(...).onConflictDoUpdate(...). */
function captureUpsert() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  insertMock.mockReturnValue({ values });
  return { values, onConflictDoUpdate };
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe('upsertAgentWarranty coverage-kind mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records an active subscription as subscription_active + is_subscription=true', async () => {
    const { values, onConflictDoUpdate } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'ABC123',
      coverageEndDate: inDays(28), // rolling renewal date, would otherwise read "expiring"
      coverageStartDate: inDays(-100),
      coverageType: 'AppleCare+',
      coverageKind: 'subscription',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'subscription_active', isSubscription: true })
    );
    // onConflictDoUpdate carries the same status/flag
    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ set: expect.objectContaining({ status: 'subscription_active', isSubscription: true }) })
    );
  });

  it('records fixed-term coverage with a computed status + is_subscription=false', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(400), // well in the future ⇒ active
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
      coverageKind: 'fixed',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', isSubscription: false })
    );
  });

  it('defaults to fixed-term behavior when no coverage kind is reported (back-compat)', async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(10), // within warn window ⇒ expiring
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expiring', isSubscription: false })
    );
  });

  it("treats an empty-string coverage kind as fixed-term (the value the agent actually sends for unclassified labels)", async () => {
    const { values } = captureUpsert();

    await upsertAgentWarranty(DEVICE_ID, ORG_ID, {
      source: 'agent_plist',
      manufacturer: 'Apple',
      serialNumber: 'XYZ789',
      coverageEndDate: inDays(10), // within warn window ⇒ expiring
      coverageStartDate: inDays(-100),
      coverageType: 'Limited Warranty',
      coverageKind: '', // timestamp-only / labelless / localized / plist fallback
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'expiring', isSubscription: false })
    );
  });
});
