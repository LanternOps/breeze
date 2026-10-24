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
import {
  assertNotLocked,
  getEffectiveAiBudget,
  getEffectiveOrgSettings,
  resolveEffectiveAiBudgetFromRows,
  resolveEffectiveCategorySettings,
} from './effectiveSettings';

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
    autoEnrollment: { enabled: false, requireApproval: false },
  },
};

describe('assertNotLocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows a category with no partner-set fields', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: {} }]);

    await expect(
      assertNotLocked('org-1', 'defaults', { agentUpdatePolicy: 'manual' }),
    ).resolves.toBeUndefined();
  });

  // #9617: the partner-level deviceGroup/alertThreshold/sendWelcome were retired.
  // Legacy values a partner already stored must not lock the org's real group id
  // or reject an old client that still re-sends sendWelcome.
  it('ignores retired partner defaults (deviceGroup, alertThreshold, sendWelcome) when locking', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { defaults: {
        deviceGroup: 'Contractors',
        alertThreshold: 'high',
        autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: true },
      } } }],
    );

    await expect(
      assertNotLocked('org-1', 'defaults', {
        deviceGroup: '11111111-1111-4111-8111-111111111111',
        autoEnrollment: { enabled: false, requireApproval: false, sendWelcome: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a locked field the org is actually changing', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { defaults: { agentUpdatePolicy: 'auto' } } }],
    );

    await expect(
      assertNotLocked('org-1', 'defaults', { agentUpdatePolicy: 'manual' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('names every diverging field in the 403 message', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { defaults: { agentUpdatePolicy: 'auto', maintenanceWindow: '24/7' } } }],
    );

    const err = await assertNotLocked('org-1', 'defaults', {
      agentUpdatePolicy: 'manual',
      maintenanceWindow: 'Sun 02:00-04:00',
    }).catch((e) => e as HTTPException);

    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(403);
    expect((err as HTTPException).message).toContain('defaults.agentUpdatePolicy');
    expect((err as HTTPException).message).toContain('defaults.maintenanceWindow');
  });

  // Issue #2752 — the core regression. The org settings editors PUT the whole
  // category (indeed the whole settings blob) on every save, so a locked field is
  // re-submitted even when the operator never touched it. Echoing back the value
  // the partner already enforces is a no-op and must NOT 403.
  it('allows re-submitting a locked field with the value the partner already enforces', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: false, requireApproval: false },
      }),
    ).resolves.toBeUndefined();
  });

  // The amplification that turned one locked field into a total category lockout:
  // a no-op locked field must not block the unrelated fields alongside it.
  it('lets unrelated fields through when a locked field is re-submitted unchanged', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: false, requireApproval: false },
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
        autoEnrollment: { enabled: false, requireApproval: false },
      }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a locked object field when any nested value diverges', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(
      assertNotLocked('org-1', 'defaults', {
        autoEnrollment: { enabled: true, requireApproval: false },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  // A partner value of `false`/`0`/`''` locks just as hard as a truthy one — the
  // guard keys on presence-plus-divergence, never on truthiness.
  it('treats a falsy partner value as enforced', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: { defaults: { agentUpdatePolicy: '' } } }]);

    await expect(
      assertNotLocked('org-1', 'defaults', { agentUpdatePolicy: 'manual' }),
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
      assertNotLocked('missing-org', 'defaults', { agentUpdatePolicy: 'manual' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('404s when the partner does not exist', async () => {
    primeSelect([{ partnerId: 'partner-1' }], []);

    await expect(
      assertNotLocked('org-1', 'defaults', { agentUpdatePolicy: 'manual' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('accepts an empty patch without touching the partner settings', async () => {
    primeSelect([{ partnerId: 'partner-1' }], [{ settings: PARTNER_AUTO_ENROLLMENT_OFF }]);

    await expect(assertNotLocked('org-1', 'defaults', {})).resolves.toBeUndefined();
  });

  // The org editor re-posts its whole settings blob, with every stored secret
  // as the masked marker. The marker means "keep my stored value" — it is not
  // an attempt to change a field the partner locked.
  it('treats the masked marker for a locked secret as unchanged', async () => {
    primeSelect(
      [{ partnerId: 'partner-1', settings: { notifications: { slackWebhookUrl: 'enc:v1:org-slack', webhooks: ['enc:v1:org-hook'] } } }],
      [{ settings: { notifications: { slackWebhookUrl: 'enc:v1:partner-slack', webhooks: ['enc:v1:partner-hook'] } } }],
    );

    const { maskSettingsSecrets } = await import('./settingsSecretMasking');
    const echoed = (maskSettingsSecrets({ notifications: { webhooks: ['enc:v1:org-hook'] } }) as {
      notifications: { webhooks: string[] };
    }).notifications.webhooks;

    await expect(
      assertNotLocked('org-1', 'notifications', { slackWebhookUrl: '********', webhooks: echoed }),
    ).resolves.toBeUndefined();
  });

  it('still rejects a typed value for a locked secret', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { notifications: { slackWebhookUrl: 'enc:v1:partner-slack' } } }],
    );

    await expect(
      assertNotLocked('org-1', 'notifications', { slackWebhookUrl: 'https://hooks.slack.example/org' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a marker list that would drop entries from the stored list', async () => {
    primeSelect(
      [{ partnerId: 'partner-1', settings: { notifications: { webhooks: ['enc:v1:org-a', 'enc:v1:org-b'] } } }],
      [{ settings: { notifications: { webhooks: ['enc:v1:partner-hook'] } } }],
    );

    const { maskSettingsSecrets } = await import('./settingsSecretMasking');
    const [keepA] = (maskSettingsSecrets({ notifications: { webhooks: ['enc:v1:org-a'] } }) as {
      notifications: { webhooks: string[] };
    }).notifications.webhooks;

    await expect(
      assertNotLocked('org-1', 'notifications', { webhooks: [keepA] }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('does not treat an asterisk string as a stand-in for a locked non-secret field', async () => {
    primeSelect(
      [{ partnerId: 'partner-1' }],
      [{ settings: { notifications: { slackChannel: '#ops-alerts' } } }],
    );

    await expect(
      assertNotLocked('org-1', 'notifications', { slackChannel: '********' }),
    ).rejects.toMatchObject({ status: 403 });
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

describe('getEffectiveAiBudget toolRateLimitMultiplier (#6476)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to 1 when neither org row nor partner sets it', async () => {
    primeSelectSeq(mockOrg({ partnerId: 'p1' }), mockPartnerSettings({}), []);
    const budget = await getEffectiveAiBudget('org1');
    expect(budget.toolRateLimitMultiplier).toBe(1);
  });

  it('uses the org row value when the partner does not set it', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ aiBudgets: {} }),
      mockOrgBudgetRow({ toolRateLimitMultiplier: 4 }),
    );
    const budget = await getEffectiveAiBudget('org1');
    expect(budget.toolRateLimitMultiplier).toBe(4);
  });

  it('partner value wins over the org row (runtime helper)', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ aiBudgets: { toolRateLimitMultiplier: 2 } }),
      mockOrgBudgetRow({ toolRateLimitMultiplier: 8 }),
    );
    const budget = await getEffectiveAiBudget('org1');
    expect(budget.toolRateLimitMultiplier).toBe(2);
  });

  it('partner value wins and locks the field (effective settings)', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ aiBudgets: { toolRateLimitMultiplier: 2 } }),
      mockOrgBudgetRow({ toolRateLimitMultiplier: 8 }),
    );
    const { effective, locked } = await getEffectiveOrgSettings('org1');
    expect((effective.aiBudgets as Record<string, unknown>).toolRateLimitMultiplier).toBe(2);
    expect(locked).toContain('aiBudgets.toolRateLimitMultiplier');
  });

  it('assertNotLocked 403s an org trying to change a partner-set multiplier', async () => {
    primeSelect(
      [{ partnerId: 'p1' }],
      [{ settings: { aiBudgets: { toolRateLimitMultiplier: 2 } } }],
    );
    await expect(
      assertNotLocked('org1', 'aiBudgets', { toolRateLimitMultiplier: 10 }),
    ).rejects.toBeInstanceOf(HTTPException);
  });
});

describe('getEffectiveOrgSettings security.sessionTimeout clamp (#6111)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clamps a stored partner value above 720 down to 720 (partner still locks)', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ security: { sessionTimeout: 1440 } }),
      [],
    );
    const { effective, locked } = await getEffectiveOrgSettings('org1');
    expect(effective.security?.sessionTimeout).toBe(720);
    expect(locked).toContain('security.sessionTimeout');
  });

  it('clamps a stored org value above 720 when the partner has not set one', async () => {
    primeSelectSeq(
      [{ partnerId: 'p1', settings: { security: { sessionTimeout: 99999 } } }],
      mockPartnerSettings({}),
      [],
    );
    const { effective } = await getEffectiveOrgSettings('org1');
    expect(effective.security?.sessionTimeout).toBe(720);
  });

  it('leaves values at or below 720 untouched', async () => {
    primeSelectSeq(
      mockOrg({ partnerId: 'p1' }),
      mockPartnerSettings({ security: { sessionTimeout: 720 } }),
      [],
    );
    const { effective } = await getEffectiveOrgSettings('org1');
    expect(effective.security?.sessionTimeout).toBe(720);
  });
});

// ---------------------------------------------------------------------------
// Pure cores (#9170): the async resolvers above are thin loaders around these,
// so the runtime and the partner settings inheritance read model share one
// implementation. Each fixture is asserted on the core directly, then fed as
// mocked DB rows through the async wrapper, which must return the same thing.
// ---------------------------------------------------------------------------

describe('resolveEffectiveAiBudgetFromRows (pure core, #9170)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fixtures: {
    name: string;
    partnerAiBudgets: Record<string, unknown> | undefined;
    orgRow: Record<string, unknown> | null;
    expected: Record<string, unknown>;
  }[] = [
    { name: 'neither level sets anything', partnerAiBudgets: undefined, orgRow: null, expected: { maxTurnsPerSession: 50, monthlyBudgetCents: null } },
    { name: 'the org row fills defaults', partnerAiBudgets: {}, orgRow: { maxTurnsPerSession: 12, monthlyBudgetCents: 500 }, expected: { maxTurnsPerSession: 12, monthlyBudgetCents: 500 } },
    { name: 'the partner value wins over the org row', partnerAiBudgets: { maxTurnsPerSession: 7 }, orgRow: { maxTurnsPerSession: 12 }, expected: { maxTurnsPerSession: 7 } },
    // A partner property present as null is a set value ("no cap") and wins;
    // an absent one lets the org row through.
    { name: 'a partner property present as null wins', partnerAiBudgets: { monthlyBudgetCents: null }, orgRow: { monthlyBudgetCents: 500 }, expected: { monthlyBudgetCents: null } },
    { name: 'an absent partner property lets the org row through', partnerAiBudgets: { dailyBudgetCents: 9 }, orgRow: { monthlyBudgetCents: 500 }, expected: { monthlyBudgetCents: 500, dailyBudgetCents: 9 } },
  ];

  for (const f of fixtures) {
    it(`${f.name}: core output`, () => {
      expect(resolveEffectiveAiBudgetFromRows(f.partnerAiBudgets, f.orgRow)).toMatchObject(f.expected);
    });

    it(`${f.name}: the async wrapper returns the core output`, async () => {
      primeSelectSeq(
        mockOrg({ partnerId: 'p1' }),
        mockPartnerSettings(f.partnerAiBudgets === undefined ? {} : { aiBudgets: f.partnerAiBudgets }),
        f.orgRow ? [f.orgRow] : [],
      );
      expect(await getEffectiveAiBudget('org1')).toEqual(resolveEffectiveAiBudgetFromRows(f.partnerAiBudgets, f.orgRow));
    });
  }
});

describe('resolveEffectiveCategorySettings (pure core, #9170)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const fixtures: { name: string; partner: Record<string, unknown>; org: Record<string, unknown>; requireMfa: unknown; locked: boolean }[] = [
    { name: 'neither level sets the field', partner: {}, org: {}, requireMfa: undefined, locked: false },
    { name: 'the org value applies when the partner has not set it', partner: {}, org: { security: { requireMfa: true } }, requireMfa: true, locked: false },
    { name: 'the partner value wins and locks', partner: { security: { requireMfa: false } }, org: { security: { requireMfa: true } }, requireMfa: false, locked: true },
    { name: 'a partner key present as null still locks', partner: { security: { requireMfa: null } }, org: { security: { requireMfa: true } }, requireMfa: null, locked: true },
  ];

  for (const f of fixtures) {
    it(`${f.name}: core output`, () => {
      const result = resolveEffectiveCategorySettings(f.partner, f.org);
      expect(result.effective.security?.requireMfa).toBe(f.requireMfa);
      expect(result.locked.includes('security.requireMfa')).toBe(f.locked);
    });

    it(`${f.name}: the async wrapper returns the core output`, async () => {
      primeSelectSeq([{ partnerId: 'p1', settings: f.org }], mockPartnerSettings(f.partner), []);
      const { effective, locked } = await getEffectiveOrgSettings('org1');
      const core = resolveEffectiveCategorySettings(f.partner, f.org);
      expect({ ...effective, aiBudgets: undefined }).toEqual({ ...core.effective, aiBudgets: undefined });
      expect(locked.filter((path) => !path.startsWith('aiBudgets.'))).toEqual(core.locked);
    });
  }
});
