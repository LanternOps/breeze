/**
 * The onboarding wire contract (Recipe Library spec §6.3's last paragraph,
 * §6.2, §7.1; W07 Amendment B3).
 *
 * Five properties carry this file:
 *
 *  1. A NEW PERSON IS DESCRIBED, NOT RESOLVED. Offboarding names an existing
 *     person (a contact id or a hint to resolve). Onboarding's subject does not
 *     exist yet, so the required fields are a display name and, per enabled
 *     provider, the principal the technician has chosen. There is no
 *     `contactId` input at all: admission CREATES the contact (spec §5.2).
 *  2. NOTHING IS PROVISIONED BY DEFAULT. Every licence SKU and every group is
 *     explicit. The defaults are empty lists, because the damage from a
 *     forgotten switch here is a new hire silently granted access nobody
 *     chose — the opposite polarity from offboarding.
 *  3. THE MODEL-AFTER PERSON IS A SOURCE, NOT AN AUTHORITY. The schema says
 *     nothing about what is copied; filtering is the RECIPE's job.
 *  4. `confirm_details` accepts only ids and booleans; `review` accepts only
 *     flags from a CLOSED enum and the three exception classes (spec §9).
 *  5. THE INPUT ROUND-TRIPS (B.0 item 11). A checkpoint stores the parsed
 *     OUTPUT and re-parses it on every wake, so the schema carries no
 *     `.transform()`: `providers` is the pure helper `onboardingProviders`, and
 *     a parsed value parses again to itself.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IDENTITY_EXCEPTION_CLASSES } from './aiOperatorIdentity';
import {
  IDENTITY_ONBOARDING_PROVIDERS,
  IDENTITY_ONBOARDING_REVIEW_FLAGS,
  identityOnboardingConfirmOutputSchema,
  identityOnboardingInputSchema,
  identityOnboardingReviewOutputSchema,
  onboardingProviders,
} from './aiOperatorOnboarding';

const CONTACT = '00000000-0000-4000-8000-000000000001';
const SITE = '00000000-0000-4000-8000-000000000051';
const SKU = '18181a46-0d4e-45cd-891e-60aabd171b4e';
const GROUP = '00000000-0000-4000-8000-0000000000b1';

const base = {
  displayName: 'Priya Raman',
  m365: { userPrincipalName: 'priya@customer.example', mailNickname: 'priya', usageLocation: 'CA' },
};
const googleBlock = { primaryEmail: 'priya@customer.example', givenName: 'Priya', familyName: 'Raman' };

describe('identityOnboardingInputSchema — who is being onboarded', () => {
  it('accepts a display name plus one provider block', () => {
    const v = identityOnboardingInputSchema.parse(base);
    expect(v.displayName).toBe('Priya Raman');
    expect(onboardingProviders(v)).toEqual({ m365: true, google: false });
    expect(v.google).toBeNull();
  });

  it('REFUSES no provider block at all — an onboarding with no account is not a task', () => {
    expect(() => identityOnboardingInputSchema.parse({ displayName: 'Priya Raman' })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ displayName: 'Priya Raman', m365: null, google: null })).toThrow();
  });

  it('accepts both providers, and the providers helper derives the map from the blocks present', () => {
    const v = identityOnboardingInputSchema.parse({ ...base, google: googleBlock });
    expect(onboardingProviders(v)).toEqual({ m365: true, google: true });
    const googleOnly = identityOnboardingInputSchema.parse({ displayName: 'Priya Raman', google: googleBlock });
    expect(onboardingProviders(googleOnly)).toEqual({ m365: false, google: true });
  });

  it('carries NO contactId — admission creates the contact (spec §5.2)', () => {
    expect(() => identityOnboardingInputSchema.parse({ ...base, contactId: CONTACT })).toThrow();
  });

  it('REFUSES a UPN that is not an address, and bounds it', () => {
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, userPrincipalName: 'priya' } })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({
      ...base, m365: { ...base.m365, userPrincipalName: `${'p'.repeat(320)}@customer.example` },
    })).toThrow();
  });

  it('REFUSES a mailNickname with a character Graph rejects, and a usageLocation that is not two uppercase letters', () => {
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, mailNickname: 'pri ya' } })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, usageLocation: 'CAN' } })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, usageLocation: 'ca' } })).toThrow();
  });

  it('REFUSES a Google block whose primaryEmail is not an address', () => {
    expect(() => identityOnboardingInputSchema.parse({
      ...base, google: { ...googleBlock, primaryEmail: 'priya' },
    })).toThrow();
  });
});

describe('identityOnboardingInputSchema — nothing is granted by default', () => {
  it('defaults every grant list EMPTY', () => {
    const v = identityOnboardingInputSchema.parse(base);
    expect(v.m365!.skuIds).toEqual([]);
    expect(v.m365!.groupIds).toEqual([]);
    expect(v.modelAfterContactId).toBeNull();
    expect(v.managerContactId).toBeNull();
    expect(v.startAt).toBeNull();
    expect(v.siteId).toBeNull();
    expect(v.jobTitle).toBeNull();
    const g = identityOnboardingInputSchema.parse({ ...base, google: googleBlock }).google!;
    expect(g.licenses).toEqual([]);
    expect(g.groupEmails).toEqual([]);
    expect(g.orgUnitPath).toBeNull();
  });

  it('accepts explicit, bounded, de-duplicated SKU and group lists', () => {
    const v = identityOnboardingInputSchema.parse({ ...base, siteId: SITE, m365: { ...base.m365, skuIds: [SKU, SKU], groupIds: [GROUP, GROUP] } });
    expect(v.m365!.skuIds).toEqual([SKU]);
    expect(v.m365!.groupIds).toEqual([GROUP]);
    expect(() => identityOnboardingInputSchema.parse({
      ...base, m365: { ...base.m365, skuIds: Array.from({ length: 21 }, (_, i) => SKU.replace(/.$/, String(i % 10))) },
    })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, skuIds: ['not-a-guid'] } })).toThrow();
  });

  it('de-duplicates uuid grant lists case-insensitively (lowercased) and Google group addresses by their canonical lowercase form', () => {
    const v = identityOnboardingInputSchema.parse({
      ...base,
      m365: { ...base.m365, skuIds: [SKU, SKU.toUpperCase()], groupIds: [GROUP.toUpperCase(), GROUP] },
      google: { ...googleBlock, groupEmails: ['Staff@Customer.Example', 'staff@customer.example', 'other@customer.example'] },
    });
    expect(v.m365!.skuIds).toEqual([SKU]);
    expect(v.m365!.groupIds).toEqual([GROUP]);
    expect(v.google!.groupEmails).toEqual(['staff@customer.example', 'other@customer.example']);
    // Idempotent: the stored output parses again to itself.
    expect(identityOnboardingInputSchema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it('bounds the Google group list and the OU path', () => {
    expect(identityOnboardingInputSchema.parse({ ...base, google: { ...googleBlock, orgUnitPath: '/Staff/Finance' } }).google!.orgUnitPath)
      .toBe('/Staff/Finance');
    expect(() => identityOnboardingInputSchema.parse({ ...base, google: { ...googleBlock, orgUnitPath: 'Staff' } })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({
      ...base, google: { ...googleBlock, groupEmails: Array.from({ length: 51 }, (_, i) => `g${i}@customer.example`) },
    })).toThrow();
    const dup = identityOnboardingInputSchema.parse({
      ...base, google: { ...googleBlock, groupEmails: ['staff@customer.example', 'staff@customer.example'] },
    });
    expect(dup.google!.groupEmails).toEqual(['staff@customer.example']);
  });

  it('accepts an optional ISO startAt and refuses a non-ISO one', () => {
    expect(identityOnboardingInputSchema.parse({ ...base, startAt: '2026-10-05T13:00:00.000Z' }).startAt)
      .toBe('2026-10-05T13:00:00.000Z');
    expect(() => identityOnboardingInputSchema.parse({ ...base, startAt: 'monday' })).toThrow();
  });

  it('is strict — an unknown key is a 400, not a silently ignored field', () => {
    expect(() => identityOnboardingInputSchema.parse({ ...base, skipConfirmDetails: true })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ ...base, m365: { ...base.m365, makeAdmin: true } })).toThrow();
    expect(() => identityOnboardingInputSchema.parse({ ...base, google: { ...googleBlock, superAdmin: true } })).toThrow();
  });

  it('exposes the provider list the recipe and the UI share', () => {
    expect([...IDENTITY_ONBOARDING_PROVIDERS]).toEqual(['m365', 'google']);
  });
});

describe('identityOnboardingInputSchema — round-trips through a stored checkpoint (B.0 item 11)', () => {
  it('has no transform: the schema is a plain object, and the output carries no derived providers key', () => {
    expect(identityOnboardingInputSchema).toBeInstanceOf(z.ZodObject);
    expect(Object.hasOwn(identityOnboardingInputSchema.parse(base), 'providers')).toBe(false);
  });

  it('a parsed value parses again to itself, byte for byte', () => {
    for (const x of [
      base,
      { ...base, google: googleBlock },
      { displayName: 'Priya Raman', google: { ...googleBlock, groupEmails: ['a@customer.example', 'a@customer.example'] } },
      { ...base, m365: { ...base.m365, skuIds: [SKU, SKU] }, startAt: '2026-10-05T13:00:00.000Z', siteId: SITE },
      { ...base, m365: { ...base.m365, skuIds: [SKU.toUpperCase(), SKU], groupIds: [GROUP.toUpperCase()] },
        google: { ...googleBlock, groupEmails: ['A@Customer.Example', 'a@customer.example'] } },
    ]) {
      const once = identityOnboardingInputSchema.parse(x);
      const twice = identityOnboardingInputSchema.parse(JSON.parse(JSON.stringify(once)));
      expect(twice).toEqual(once);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });

  it('onboardingProviders is pure and reads only the two blocks', () => {
    const v = identityOnboardingInputSchema.parse(base);
    const before = JSON.stringify(v);
    expect(onboardingProviders(v)).toEqual(onboardingProviders(v));
    expect(JSON.stringify(v)).toBe(before);
    expect(onboardingProviders({ m365: null, google: null })).toEqual({ m365: false, google: false });
  });
});

describe('identityOnboardingConfirmOutputSchema — the model returns IDS AND FLAGS, never a decision', () => {
  it('accepts the resolved manager and model-after candidates plus an ambiguity flag', () => {
    const v = identityOnboardingConfirmOutputSchema.parse({
      managerCandidateContactIds: [CONTACT],
      modelAfterCandidateContactIds: [],
      ambiguous: false,
      rationale: 'Exact name match on the ticket requester.',
    });
    expect(v.managerCandidateContactIds).toEqual([CONTACT]);
  });

  it('refuses more than five candidates in either list', () => {
    for (const key of ['managerCandidateContactIds', 'modelAfterCandidateContactIds']) {
      expect(() => identityOnboardingConfirmOutputSchema.parse({
        managerCandidateContactIds: [], modelAfterCandidateContactIds: [], ambiguous: true, rationale: 'x',
        [key]: Array(6).fill(CONTACT),
      })).toThrow();
    }
  });

  it('carries NO chosen id, NO principal and NO grant list', () => {
    for (const extra of [{ chosenManagerContactId: CONTACT }, { userPrincipalName: 'x@y.z' }, { skuIds: [SKU] }]) {
      expect(() => identityOnboardingConfirmOutputSchema.parse({
        managerCandidateContactIds: [], modelAfterCandidateContactIds: [], ambiguous: false, rationale: 'x', ...extra,
      })).toThrow();
    }
  });
});

describe('identityOnboardingReviewOutputSchema — flags from a CLOSED enum', () => {
  it('pins the flag enum', () => {
    expect([...IDENTITY_ONBOARDING_REVIEW_FLAGS]).toEqual([
      'upn_collision', 'email_collision', 'no_seat_available', 'privileged_group_in_model',
      'dynamic_group_membership', 'role_assignable_group', 'unverified_domain',
      'model_after_service_account', 'missing_usage_location', 'manager_not_in_org',
    ]);
  });

  it('accepts a known flag with its subject', () => {
    const v = identityOnboardingReviewOutputSchema.parse({
      flags: [{ code: 'no_seat_available', subject: 'STANDARDPACK', detail: 'All 25 seats are consumed.' }],
      exceptions: [], summary: 'One seat problem.',
    });
    expect(v.flags[0]!.code).toBe('no_seat_available');
  });

  it('REFUSES a flag code outside the enum', () => {
    expect(() => identityOnboardingReviewOutputSchema.parse({
      flags: [{ code: 'seems_fine', subject: 'x', detail: 'y' }], exceptions: [], summary: 's',
    })).toThrow();
  });

  it('reuses R1s three exception classes rather than declaring its own', () => {
    expect(IDENTITY_EXCEPTION_CLASSES).toEqual(['retry', 'human_work', 'handoff']);
    for (const klass of IDENTITY_EXCEPTION_CLASSES) {
      expect(identityOnboardingReviewOutputSchema.parse({
        flags: [], exceptions: [{ toolName: 'm365_assign_license', classification: klass, detail: 'd' }], summary: 's',
      }).exceptions[0]!.classification).toBe(klass);
    }
  });

  it('carries no effect list, no ordinal and no group id — the model never edits the plan', () => {
    for (const extra of [{ effects: [] }, { groupIds: [] }, { ordinals: [0] }]) {
      expect(() => identityOnboardingReviewOutputSchema.parse({ flags: [], exceptions: [], summary: 's', ...extra })).toThrow();
    }
  });
});
