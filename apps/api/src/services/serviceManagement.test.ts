import { describe, expect, it, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

vi.mock('../db/schema/orgs', () => ({
  partners: { id: 'id', serviceManagementMode: 'service_management_mode' },
}));

import {
  SERVICE_MANAGEMENT_MODES,
  ServiceManagementOffError,
  assertTicketCreationAllowed,
  getServiceManagementMode,
} from './serviceManagement';

const PARTNER = '11111111-1111-4111-8111-111111111111';

/** `db.select({...}).from(partners).where(...).limit(1)` → `rows`. */
function mockPartnerRows(rows: Array<{ serviceManagementMode: string | null }>) {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  });
}

beforeEach(() => {
  selectMock.mockReset();
});

describe('SERVICE_MANAGEMENT_MODES', () => {
  it('is exactly the three modes the CHECK constraint allows', () => {
    expect([...SERVICE_MANAGEMENT_MODES]).toEqual(['native', 'external', 'off']);
  });
});

describe('getServiceManagementMode', () => {
  it('returns the stored mode', async () => {
    mockPartnerRows([{ serviceManagementMode: 'off' }]);
    await expect(getServiceManagementMode(PARTNER)).resolves.toBe('off');
  });

  it('returns external when the partner runs a PSA', async () => {
    mockPartnerRows([{ serviceManagementMode: 'external' }]);
    await expect(getServiceManagementMode(PARTNER)).resolves.toBe('external');
  });

  // Fail open: a missing partner row must not withdraw the service desk from a
  // caller that legitimately has one (the gate is a product module switch, not
  // authorization — every route keeps its own permission checks).
  it('falls back to native when the partner row is missing', async () => {
    mockPartnerRows([]);
    await expect(getServiceManagementMode(PARTNER)).resolves.toBe('native');
  });

  it('falls back to native when the stored value is NULL', async () => {
    mockPartnerRows([{ serviceManagementMode: null }]);
    await expect(getServiceManagementMode(PARTNER)).resolves.toBe('native');
  });

  it('falls back to native on an unrecognised stored value', async () => {
    mockPartnerRows([{ serviceManagementMode: 'bogus' }]);
    await expect(getServiceManagementMode(PARTNER)).resolves.toBe('native');
  });

  it('falls back to native when no partner id is known', async () => {
    await expect(getServiceManagementMode(null)).resolves.toBe('native');
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe('assertTicketCreationAllowed', () => {
  it('throws ServiceManagementOffError when the partner is off', async () => {
    mockPartnerRows([{ serviceManagementMode: 'off' }]);
    const err = await assertTicketCreationAllowed(PARTNER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceManagementOffError);
    expect((err as ServiceManagementOffError).code).toBe('service_management_off');
    expect((err as ServiceManagementOffError).status).toBe(409);
  });

  it('resolves for native', async () => {
    mockPartnerRows([{ serviceManagementMode: 'native' }]);
    await expect(assertTicketCreationAllowed(PARTNER)).resolves.toBeUndefined();
  });

  // 'external' still creates Breeze-side rows (the shadow row the follow-on
  // feature links to the PSA), so it must NOT be refused here.
  it('resolves for external', async () => {
    mockPartnerRows([{ serviceManagementMode: 'external' }]);
    await expect(assertTicketCreationAllowed(PARTNER)).resolves.toBeUndefined();
  });

  it('resolves when the partner is unknown (fails open)', async () => {
    await expect(assertTicketCreationAllowed(null)).resolves.toBeUndefined();
  });
});
