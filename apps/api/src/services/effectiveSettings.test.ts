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
import { assertNotLocked, getEffectiveAiBudget, getEffectiveOrgSettings } from './effectiveSettings';

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

/**
 * getEffectiveOrgSettings and getEffectiveAiBudget each issue three sequential
 * reads, every one shaped `db.select(...).from(t).where(cond).then(rows => rows[0])`:
 *   1. the org row (partnerId [+ settings])
 *   2. the partner row (settings JSONB) — via readWithPartnerAxisVisibility,
 *      which under this mock invokes its callback synchronously, so it lands
 *      in the same call order as a plain `await`
 *   3. the org's `ai_budgets` table row
 * `getEffectiveAiBudget` fires (2) and (3) inside a `Promise.all([...])`, but
 * array literals evaluate left-to-right, so the db.select() call order is
 * identical to getEffectiveOrgSettings's sequential version.
 */
function primeSelectSeq(...rowSets: unknown[][]) {
  let call = 0;
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(rowSets[call++] ?? [])),
    })),
  })) as never);
}

function mockOrg(overrides: { partnerId: string }) {
  return [{ partnerId: overrides.partnerId, settings: {} }];
}

function mockPartnerSettings(settings: Record<string, unknown>) {
  return [{ settings }];
}

function mockOrgBudgetRow(overrides: Record<string, unknown>) {
  return [overrides];
}

describe('getEffectiveAiBudget alertThresholdPercents (#4388)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to [50,80,95] when neither org row nor partner sets it', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({}),
      mockOrgBudgetRow({ alertThresholdPercents: null }),
    );

    const budget = await getEffectiveAiBudget('org1');
    expect(budget.alertThresholdPercents).toEqual([50, 80, 95]);
  });

  it('keeps an explicit empty array (warnings off) instead of falling back to the default', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({}),
      mockOrgBudgetRow({ alertThresholdPercents: [] }),
    );

    const budget = await getEffectiveAiBudget('org1');
    expect(budget.alertThresholdPercents).toEqual([]);
  });

  it('partner JSONB overrides the org row and locks the field', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ aiBudgets: { alertThresholdPercents: [90] } }),
      mockOrgBudgetRow({ alertThresholdPercents: [50] }),
    );

    const { effective, locked } = await getEffectiveOrgSettings('org1');
    expect((effective.aiBudgets as Record<string, unknown>).alertThresholdPercents).toEqual([90]);
    expect(locked).toContain('aiBudgets.alertThresholdPercents');
  });

  // Regression for the #4388 review finding: `{ ...AI_BUDGET_DEFAULTS }` is a
  // shallow copy, so without an explicit fresh-array override, every org with
  // no org-row/partner override for `alertThresholdPercents` would receive
  // the SAME array object, process-wide, for the lifetime of the process — a
  // caller mutating one org's result in place (`.push()`) would silently
  // corrupt the default thresholds seen by every other org.
  it('returns a fresh alertThresholdPercents array on every call, not a shared reference', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({}),
      mockOrgBudgetRow({ alertThresholdPercents: null }),
    );
    const first = await getEffectiveAiBudget('org1');

    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({}),
      mockOrgBudgetRow({ alertThresholdPercents: null }),
    );
    const second = await getEffectiveAiBudget('org2');

    expect(first.alertThresholdPercents).toEqual(second.alertThresholdPercents);
    expect(first.alertThresholdPercents).not.toBe(second.alertThresholdPercents);

    first.alertThresholdPercents.push(1);
    expect(second.alertThresholdPercents).toEqual([50, 80, 95]);
  });
});
