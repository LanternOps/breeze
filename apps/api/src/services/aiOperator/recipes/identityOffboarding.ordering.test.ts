// apps/api/src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts
/**
 * THE ORDERING SAFETY CONTRACT (spec §6.3, §9(b), §11 risk row 2).
 *
 * A task can stop at ANY point: a deadline, a cancel, a handoff, a worker that
 * never comes back. The recipe's ordering is what makes every one of those
 * stops safe, and "safe" has a precise meaning:
 *
 *   For every prefix P of the plan, and for every provider p, the state
 *   reached by executing P must NEVER be "p's account is disabled or
 *   suspended while p's mail is unrouted".
 *
 * Equivalently: within each provider, the disable/suspend effect is preceded
 * by every mail-routing effect that provider's plan contains. That is why
 * mailbox effects run while the account is still active (suspension blocks
 * Gmail impersonation) and why disable/suspend is last.
 *
 * The second property is M365-specific: when the plan KEEPS the mailbox,
 * licence removal must never happen before the shared-mailbox conversion is
 * confirmed. Because that conversion has no Graph API (spec §7.3), the recipe
 * satisfies it by not planning the licence removal at all — so the property is
 * stated as "no m365_remove_license effect exists in any prefix", which is the
 * strongest possible form of "never precedes".
 *
 * Both properties are checked over a CROSS-PRODUCT of inputs and facts, not
 * one hand-picked plan, because the ordering bug this guards against is
 * exactly the one that appears only when some effects are toggled off and the
 * dense renumbering shifts everything.
 */
import { describe, expect, it } from 'vitest';
import type { IdentityOffboardingInput } from '@breeze/shared';
import type { PlannedEffect } from './types';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  buildIdentityOffboardingManualWork,
  buildIdentityOffboardingPlan,
  identityOffboardingRecipe,
} from './identityOffboarding';

/** Effects that change where a person's mail GOES or how it is answered. */
const MAIL_ROUTING: Record<'google' | 'm365', readonly string[]> = {
  google: ['google_set_vacation', 'google_set_forwarding', 'google_add_mail_delegate'],
  m365: ['m365_set_auto_reply'],
};
/** The effect after which the account can no longer sign in. */
const LOCKOUT: Record<'google' | 'm365', string> = {
  google: 'google_suspend_user',
  m365: 'm365_disable_user',
};

function facts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    google: {
      present: true, externalId: '101', primaryEmail: 'dana@customer.example',
      groups: [{ id: 'g1', email: 'all@customer.example', name: 'All', ownership: 'shared', dynamic: false, roleAssignable: false }],
      licenses: [{ productId: 'Google-Apps', skuId: '1010020020', name: 'Business Standard' }],
      mobileDevices: [{ id: 'md1', model: 'Pixel', status: 'APPROVED' }],
    },
    m365: {
      present: true, externalId: 'obj-1', userPrincipalName: 'dana@customer.example',
      groups: [{ id: 'mg1', name: 'Marketing', ownership: 'shared', dynamic: false, roleAssignable: false }],
      licenses: [{ skuId: '18181a46-0d4e-45cd-891e-60aabd171b4e', skuPartNumber: 'STANDARDPACK' }],
      intuneDevices: [{ id: 'id1', deviceName: 'DANA-IPHONE' }],
    },
    breeze: { suggestedDevices: [] },
    flags: [],
    // Frozen by `discover` into the planning snapshot; buildPlan throws without them.
    targets: { contactTargetId: '00000000-0000-4000-8000-0000000000e1' },
    degradedTools: [],
    ...over,
  };
}

/** Every combination of the eight toggles would be 256 plans; these 24 cover
 *  the dimensions that can reorder a plan: which provider is present, whether
 *  a mail destination exists, keepMailbox, and each mail/lockout toggle off. */
function cases(): Array<{ name: string; input: IdentityOffboardingInput; facts: Record<string, unknown> }> {
  const parse = (o: Record<string, unknown>): IdentityOffboardingInput =>
    identityOffboardingRecipe.inputSchema.parse({ contactId: '00000000-0000-4000-8000-000000000001', ...o });
  const dest = { forwardTo: 'sam@customer.example' };
  const out: Array<{ name: string; input: IdentityOffboardingInput; facts: Record<string, unknown> }> = [];
  const factSets: Array<[string, Record<string, unknown>]> = [
    ['both providers', facts()],
    ['google only', facts({ m365: { ...(facts().m365 as object), present: false } })],
    ['m365 only', facts({ google: { ...(facts().google as object), present: false } })],
  ];
  const inputSets: Array<[string, Record<string, unknown>]> = [
    ['defaults', {}],
    ['with destination', dest],
    ['with destination + delegate', { ...dest, effects: { mailDelegate: true } }],
    ['keepMailbox', { ...dest, keepMailbox: true }],
    ['no autoReply', { ...dest, effects: { autoReply: false } }],
    ['no forwarding', { ...dest, effects: { forwarding: false } }],
    ['no groups, no licences', { ...dest, effects: { removeGroups: false, removeLicenses: false } }],
    ['wipe mobile on', { ...dest, effects: { wipeMobile: true } }],
  ];
  for (const [fn, f] of factSets) for (const [inName, i] of inputSets) {
    out.push({ name: `${fn} / ${inName}`, input: parse(i), facts: f });
  }
  return out;
}

describe('PROPERTY: no prefix leaves an account locked out with mail unrouted', () => {
  for (const c of cases()) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      for (const provider of ['google', 'm365'] as const) {
        const ofProvider = plan.filter((e) => e.provider === provider);
        const plannedMail = ofProvider.filter((e) => MAIL_ROUTING[provider].includes(e.toolName));
        const lockout = ofProvider.find((e) => e.toolName === LOCKOUT[provider]);
        if (!lockout) continue;
        for (const mail of plannedMail) {
          expect(
            mail.ordinal,
            `${provider}: ${mail.toolName} (#${mail.ordinal}) must run BEFORE ${LOCKOUT[provider]} (#${lockout.ordinal})`,
          ).toBeLessThan(lockout.ordinal);
        }
        // Stated the other way round, over every prefix, so the assertion is
        // about REACHABLE STATES and not merely about two indices.
        for (let n = 0; n <= plan.length; n += 1) {
          const prefix: PlannedEffect[] = plan.slice(0, n);
          const lockedOut = prefix.some((e) => e.toolName === LOCKOUT[provider]);
          const mailDone = plannedMail.every((m) => prefix.some((e) => e.ordinal === m.ordinal));
          expect(
            !lockedOut || mailDone,
            `${provider}: prefix of length ${n} disables the account with ${plannedMail.length - prefix.filter((e) => MAIL_ROUTING[provider].includes(e.toolName)).length} mail effect(s) still pending`,
          ).toBe(true);
        }
      }
    });
  }
});

/** Every non-empty subset of a list. */
function subsets<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < (1 << xs.length); mask += 1) out.push(xs.filter((_, i) => (mask & (1 << i)) !== 0));
  return out;
}

describe('PROPERTY: a DEGRADED mail step holds the lockout back (never "disabled with mail unrouted")', () => {
  // The property above checks the plan's own order. This one checks what the
  // plan leaves OUT: a requested mail effect that cannot run (degraded) must
  // not be silently replaced by a manual item that a person does AFTER the
  // account is already locked — the lockout is held back with it.
  const both = cases().filter((c) => c.name.startsWith('both providers'));
  for (const provider of ['google', 'm365'] as const) {
    for (const degradedMail of subsets(MAIL_ROUTING[provider])) {
      for (const c of both) {
        it(`${provider}: degraded [${degradedMail.join(', ')}] / ${c.name}`, () => {
          const requested = buildIdentityOffboardingPlan(c.input, c.facts)
            .filter((e) => e.provider === provider).map((e) => e.toolName);
          const asked = degradedMail.filter((t) => requested.includes(t));
          const plan = buildIdentityOffboardingPlan(c.input, { ...c.facts, degradedTools: degradedMail });
          const tools = plan.filter((e) => e.provider === provider).map((e) => e.toolName);
          for (const t of degradedMail) expect(tools).not.toContain(t);
          if (asked.length > 0 && requested.includes(LOCKOUT[provider])) {
            expect(tools, `${provider}: ${LOCKOUT[provider]} planned although ${asked.join(', ')} cannot run`)
              .not.toContain(LOCKOUT[provider]);
            const manual = buildIdentityOffboardingManualWork(
              c.input, { ...c.facts, degradedTools: degradedMail }, {}, [],
            ).map((i) => i.key);
            expect(manual).toContain(`lockout_held:${provider}`);
          } else if (requested.includes(LOCKOUT[provider])) {
            // Nothing the plan asked for is missing: the lockout stays.
            expect(tools).toContain(LOCKOUT[provider]);
          }
          // ONLY the lockout is held: every other non-degraded effect of this
          // provider (groups, licences, sessions, other mail tools) still runs.
          const keptElsewhere = buildIdentityOffboardingPlan(c.input, c.facts)
            .filter((e) => e.provider === provider && e.toolName !== LOCKOUT[provider] && !degradedMail.includes(e.toolName))
            .map((e) => e.toolName);
          expect(tools.filter((t) => t !== LOCKOUT[provider])).toEqual(keptElsewhere);
          // The OTHER provider is untouched by this provider's degradation.
          const other = provider === 'google' ? 'm365' : 'google';
          expect(plan.filter((e) => e.provider === other).map((e) => e.toolName))
            .toEqual(buildIdentityOffboardingPlan(c.input, c.facts).filter((e) => e.provider === other).map((e) => e.toolName));
        });
      }
    }
  }

  it('the lockout itself being degraded does not invent a lockout_held item', () => {
    const c = cases().find((x) => x.name === 'both providers / with destination')!;
    const f = { ...c.facts, degradedTools: ['google_suspend_user', 'google_set_vacation'] };
    expect(buildIdentityOffboardingManualWork(c.input, f, {}, []).map((i) => i.key)).not.toContain('lockout_held:google');
  });
});

describe('PROPERTY: M365 licence removal never precedes shared-mailbox conversion', () => {
  for (const c of cases().filter((x) => (x.input as { keepMailbox: boolean }).keepMailbox)) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      expect(plan.map((e) => e.toolName)).not.toContain('m365_remove_license');
      const manual = buildIdentityOffboardingManualWork(c.input, c.facts, {}, []).map((i) => i.key);
      const m365Present = (c.facts.m365 as { present: boolean }).present;
      if (m365Present) expect(manual).toContain('shared_mailbox_conversion');
    });
  }

  it('DOES plan the licence removal when the mailbox is not being kept', () => {
    const c = cases().find((x) => x.name === 'both providers / with destination')!;
    expect(buildIdentityOffboardingPlan(c.input, c.facts).map((e) => e.toolName)).toContain('m365_remove_license');
  });
});

describe('PROPERTY: the catalog is closed and the ordinals are dense, for every case', () => {
  for (const c of cases()) {
    it(`holds for ${c.name}`, () => {
      const plan = buildIdentityOffboardingPlan(c.input, c.facts);
      expect(plan.map((e) => e.ordinal)).toEqual(plan.map((_, i) => i));
      for (const e of plan) expect(IDENTITY_OFFBOARDING_EFFECT_TOOLS).toContain(e.toolName);
      expect(plan.map((e) => e.toolName)).not.toContain('google_offboard_user');
      expect(plan.map((e) => e.toolName)).not.toContain('google_wipe_mobile_device');
    });
  }
});

describe('the control: the property TEST would catch a broken order', () => {
  it('fails on a deliberately reversed plan', () => {
    const c = cases()[0]!;
    const reversed = [...buildIdentityOffboardingPlan(c.input, c.facts)].reverse()
      .map((e, i) => ({ ...e, ordinal: i }));
    const mail = reversed.find((e) => e.toolName === 'google_set_vacation');
    const lock = reversed.find((e) => e.toolName === 'google_suspend_user');
    // Proves the assertion above is discriminating and not vacuously true —
    // without this, a buildPlan that emitted an empty list would pass every
    // case in this file.
    expect(mail).toBeDefined();
    expect(lock).toBeDefined();
    expect(mail!.ordinal).toBeGreaterThan(lock!.ordinal);
  });
});
