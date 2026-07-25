import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
  // readWithPartnerAxisVisibility (#2822) imports these by name; the escape is
  // a no-op under the unit mock — the fake db.select chain returns the same
  // rows regardless of RLS context.
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../db/schema/orgs', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id', settings: 'organizations.settings' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

vi.mock('../db/schema/ai', () => ({
  aiBudgets: { orgId: 'ai_budgets.org_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ a, b })),
}));

import { db } from '../db';
import { assertNotLocked } from './effectiveSettings';

/**
 * assertNotLocked issues two sequential reads, each shaped
 * `db.select({...}).from(t).where(cond).then(rows => rows[0])`:
 *   1. the org row (for partnerId)
 *   2. the partner row (for its settings JSONB)
 * `.where()` therefore has to return a thenable resolving to a row array.
 */
function primeSelect(orgRows: unknown[], partnerRows: unknown[]) {
  const seq = [orgRows, partnerRows];
  let call = 0;
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(seq[call++] ?? [])),
    })),
  })) as never);
}

/** Partner enforces `defaults.autoEnrollment` with everything switched off. */
const PARTNER_AUTO_ENROLLMENT_OFF = {
  defaults: {
    autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: false },
  },
};

describe('assertNotLocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a category with no partner-set fields', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: {} }]);

    await expect(
      assertNotLocked('org-1', 'defaults', { deviceGroup: 'Contractors' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a locked field the org is actually changing', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { defaults: { deviceGroup: 'Critical Infrastructure' } } }],
    );

    await expect(
      assertNotLocked('org-1', 'defaults', { deviceGroup: 'Contractors' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('names every diverging field in the 403 message', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { defaults: { deviceGroup: 'Contractors', alertThreshold: 'high' } } }],
    );

    const err = await assertNotLocked('org-1', 'defaults', {
      deviceGroup: 'Remote Staff',
      alertThreshold: 'medium',
    }).catch((e) => e as HTTPException);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(403);
    expect((err as HTTPException).message).toContain('defaults.deviceGroup');
    expect((err as HTTPException).message).toContain('defaults.alertThreshold');
  });

  // Issue #2752 — the core regression. The org settings editors PUT the whole
  // category (indeed the whole settings blob) on every save, so a locked field is
  // re-submitted even when the operator never touched it. Echoing back the value
  // the partner already enforces is a no-op and must NOT 403.
  it('allows re-submitting a locked field with the value the partner already enforces', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: false },
      }),
    ).resolves.toBeUndefined();
  });

  // The amplification that turned one locked field into a total category lockout:
  // a no-op locked field must not block the unrelated fields alongside it.
  it('lets unrelated fields through when a locked field is re-submitted unchanged', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: false },
        deviceGroup: 'Contractors',
        alertThreshold: 'medium',
        agentUpdatePolicy: 'manual',
        maintenanceWindow: '24/7',
      }),
    ).resolves.toBeUndefined();
  });

  it('compares nested objects structurally, not by key order or identity', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        // Same three booleans, declared in a different order.
        autoEnrollment: { sendWelcome: false, enabled: false, requireApproval: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a locked object field when any nested value diverges', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: true, requireApproval: false, sendWelcome: false },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // A partner value of `false`/`0`/`''` locks just as hard as a truthy one — the
  // guard keys on presence-plus-divergence, never on truthiness.
  it('treats a falsy partner value as enforced', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: { defaults: { deviceGroup: '' } } }]);

    await expect(
      assertNotLocked('org-1', 'defaults', { deviceGroup: 'Contractors' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not treat an absent partner field as locked even when the org sends null', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: { defaults: {} } }]);

    await expect(
      assertNotLocked('org-1', 'defaults', { autoEnrollment: null }),
    ).resolves.toBeUndefined();
  });

  it('works for the aiBudgets pseudo-category', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: { aiBudgets: { monthlyBudgetCents: 5000 } } }]);

    await expect(
      assertNotLocked('org-1', 'aiBudgets', { monthlyBudgetCents: 5000, dailyBudgetCents: 100 }),
    ).resolves.toBeUndefined();
  });

  it('404s when the org does not exist', async () => {
    primeSelect([], []);

    await expect(
      assertNotLocked('missing-org', 'defaults', { deviceGroup: 'Contractors' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('404s when the partner does not exist', async () => {
    primeSelect([{ partnerId: 'partner-1' }], []);

    await expect(
      assertNotLocked('org-1', 'defaults', { deviceGroup: 'Contractors' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('accepts an empty patch without touching the partner settings', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(assertNotLocked('org-1', 'defaults', {})).resolves.toBeUndefined();
  });
});
