// packages/shared/src/validators/aiOperatorIdentity.test.ts
/**
 * The offboarding wire contract (Recipe Library spec §6.3, §6.2).
 *
 * Three properties carry this file and each has cases below:
 *
 *  1. A person is named EXACTLY ONE way — a contact id or a free-text hint,
 *     never both and never neither. "Both" is the shape where a UI bug sends a
 *     stale hint beside a corrected id and the server has to guess which one
 *     the technician meant; the answer to that is 400, not a coin toss.
 *  2. Every per-effect toggle has a SAFE DEFAULT, and the safe default for a
 *     destructive effect is ON only where leaving it off is what harms (mail
 *     routing), OFF where doing it is what harms (mobile wipe).
 *  3. `confirm_identity` accepts only ids; `effects` (review's output) accepts only flags
 *     from a CLOSED enum and exception classes from a three-value union. A
 *     model that returns free text at either step is refused, because a
 *     `deterministic` gate class means model output is "only ids, flags, and
 *     prose, all server-validated" (spec §9).
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_EXCEPTION_CLASSES,
  IDENTITY_REVIEW_FLAGS,
  identityIntakeOutputSchema,
  identityOffboardingInputSchema,
  identityReviewOutputSchema,
  SELF_INHERITANCE_MESSAGE,
  selfInheritanceField,
} from './aiOperatorIdentity';

const CONTACT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

describe('identityOffboardingInputSchema — who is being offboarded', () => {
  it('accepts a contact id alone', () => {
    const v = identityOffboardingInputSchema.parse({ contactId: CONTACT });
    expect(v.contactId).toBe(CONTACT);
    expect(v.personHint).toBeNull();
  });

  it('accepts a free-text person hint alone', () => {
    const v = identityOffboardingInputSchema.parse({ personHint: 'Dana in accounting' });
    expect(v.contactId).toBeNull();
    expect(v.personHint).toBe('Dana in accounting');
  });

  it('REFUSES both together', () => {
    expect(() => identityOffboardingInputSchema.parse({ contactId: CONTACT, personHint: 'Dana' })).toThrow();
  });

  it('REFUSES neither', () => {
    expect(() => identityOffboardingInputSchema.parse({})).toThrow();
  });
});

describe('identityOffboardingInputSchema — safe defaults (spec §6.3)', () => {
  const base = { contactId: CONTACT };

  it('defaults mail continuity ON: auto-reply and forwarding', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.autoReply).toBe(true);
    expect(v.effects.forwarding).toBe(true);
  });

  it('defaults access removal ON: groups, licences, sessions, disable', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.removeGroups).toBe(true);
    expect(v.effects.removeLicenses).toBe(true);
    expect(v.effects.revokeSessions).toBe(true);
    expect(v.effects.disableAccount).toBe(true);
  });

  it('defaults the MOBILE ACCOUNT WIPE OFF — a phone is usually personal property', () => {
    expect(identityOffboardingInputSchema.parse(base).effects.wipeMobile).toBe(false);
  });

  it('defaults mailbox delegation OFF and keepMailbox FALSE', () => {
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.effects.mailDelegate).toBe(false);
    expect(v.keepMailbox).toBe(false);
  });

  it('requires an inheritor when forwarding or delegation is on', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, effects: { forwarding: true } })).not.toThrow();
    // forwarding defaults on and is satisfied by forwardTo OR inheritorContactId;
    // with neither, the recipe degrades the effect — it is NOT a schema error,
    // because a technician who does not know the inheritor yet must still be
    // able to start the task and answer at confirm_identity.
    const v = identityOffboardingInputSchema.parse(base);
    expect(v.forwardTo).toBeNull();
    expect(v.inheritorContactId).toBeNull();
  });

  it('REFUSES an inheritor supplied two ways at once', () => {
    expect(() => identityOffboardingInputSchema.parse({
      ...base, inheritorContactId: CONTACT, forwardTo: 'sam@customer.example',
    })).toThrow();
  });

  // #10076: the person leaving was offered, and accepted, as their own inheritor.
  it('REFUSES the person leaving as their own inheritor contact, on the inheritor field', () => {
    const r = identityOffboardingInputSchema.safeParse({ ...base, inheritorContactId: CONTACT });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(['inheritorContactId']);
    expect(r.error!.issues[0]!.message).toBe(SELF_INHERITANCE_MESSAGE);
    // The same id in another case is the same contact.
    expect(identityOffboardingInputSchema.safeParse({ ...base, inheritorContactId: CONTACT.toUpperCase() }).success).toBe(false);
  });

  it('REFUSES a forward address equal to the e-mail the person was named by', () => {
    const r = identityOffboardingInputSchema.safeParse({ personHint: 'Dana@Customer.example', forwardTo: 'dana@customer.example' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(['forwardTo']);
  });

  it('accepts a different inheritor contact or address', () => {
    expect(identityOffboardingInputSchema.safeParse({ ...base, inheritorContactId: OTHER }).success).toBe(true);
    expect(identityOffboardingInputSchema.safeParse({ personHint: 'dana@customer.example', forwardTo: 'sam@customer.example' }).success).toBe(true);
    expect(identityOffboardingInputSchema.safeParse({ personHint: 'Dana Ruiz', forwardTo: 'dana@customer.example' }).success).toBe(true);
  });

  it('bounds the auto-reply message and refuses an empty one', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: '' })).toThrow();
    expect(() => identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: 'x'.repeat(4001) })).toThrow();
    expect(identityOffboardingInputSchema.parse({ ...base, autoReplyMessage: 'Dana has left.' }).autoReplyMessage)
      .toBe('Dana has left.');
  });

  it('accepts an optional ISO cutoff and refuses a non-ISO one', () => {
    expect(identityOffboardingInputSchema.parse({ ...base, cutoffAt: '2026-10-23T17:00:00.000Z' }).cutoffAt)
      .toBe('2026-10-23T17:00:00.000Z');
    expect(() => identityOffboardingInputSchema.parse({ ...base, cutoffAt: 'friday' })).toThrow();
  });

  it('accepts a bounded, explicit device list and defaults it empty', () => {
    expect(identityOffboardingInputSchema.parse(base).deviceIds).toEqual([]);
    expect(identityOffboardingInputSchema.parse({ ...base, deviceIds: [DEVICE] }).deviceIds).toEqual([DEVICE]);
    expect(() => identityOffboardingInputSchema.parse({ ...base, deviceIds: Array(11).fill(DEVICE) })).toThrow();
  });

  it('is strict — an unknown key is a 400, not a silently ignored field', () => {
    expect(() => identityOffboardingInputSchema.parse({ ...base, skipConfirmIdentity: true })).toThrow();
  });
});

describe('selfInheritanceField — the leaver cannot inherit their own mail (#10076)', () => {
  const none = { inheritorContactId: null, forwardTo: null };
  it('names the inheritor contact when it is the resolved person', () => {
    expect(selfInheritanceField({ ...none, inheritorContactId: CONTACT }, { contactId: CONTACT, email: null })).toBe('inheritorContactId');
  });
  it('names the forward address when it is the person\'s own address, ignoring case and spaces', () => {
    expect(selfInheritanceField({ ...none, forwardTo: ' Dana@Customer.example ' }, { contactId: CONTACT, email: 'dana@customer.example' })).toBe('forwardTo');
  });
  it('is null for someone else, for no inheritor, and for a person with no id or address', () => {
    expect(selfInheritanceField({ ...none, inheritorContactId: OTHER }, { contactId: CONTACT, email: 'dana@customer.example' })).toBeNull();
    expect(selfInheritanceField({ ...none, forwardTo: 'sam@customer.example' }, { contactId: CONTACT, email: 'dana@customer.example' })).toBeNull();
    expect(selfInheritanceField(none, { contactId: CONTACT, email: 'dana@customer.example' })).toBeNull();
    expect(selfInheritanceField({ inheritorContactId: CONTACT, forwardTo: 'dana@customer.example' }, { contactId: null, email: null })).toBeNull();
  });
});

describe('identityIntakeOutputSchema — the model returns IDS, never a decision', () => {
  it('accepts a bounded candidate list', () => {
    const v = identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT],
      ambiguous: false,
      rationale: 'Exact email match on dana@customer.example.',
    });
    expect(v.candidateContactIds).toEqual([CONTACT]);
  });

  it('refuses more than five candidates — a list that long is an unanswered question', () => {
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: Array(6).fill(CONTACT), ambiguous: true, rationale: 'x',
    })).toThrow();
  });

  it('refuses a non-uuid candidate', () => {
    expect(() => identityIntakeOutputSchema.parse({ candidateContactIds: ['dana'], ambiguous: false, rationale: 'x' })).toThrow();
  });

  it('carries NO chosen contact, NO account ids and NO effect toggles', () => {
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT], ambiguous: false, rationale: 'x', chosenContactId: CONTACT,
    })).toThrow();
    expect(() => identityIntakeOutputSchema.parse({
      candidateContactIds: [CONTACT], ambiguous: false, rationale: 'x', effects: { disableAccount: false },
    })).toThrow();
  });
});

describe('identityReviewOutputSchema — flags from a CLOSED enum, exceptions in three classes', () => {
  it('accepts a known flag with its subject', () => {
    const v = identityReviewOutputSchema.parse({
      flags: [{ code: 'sole_group_owner', subject: 'All Staff', detail: 'Dana is the only owner.' }],
      exceptions: [],
      summary: 'One ownership issue.',
    });
    expect(v.flags[0]!.code).toBe('sole_group_owner');
  });

  it('REFUSES a flag code outside the enum', () => {
    expect(() => identityReviewOutputSchema.parse({
      flags: [{ code: 'looks_fishy', subject: 'x', detail: 'y' }], exceptions: [], summary: 's',
    })).toThrow();
  });

  it('classifies an exception into exactly retry | human_work | handoff', () => {
    expect(IDENTITY_EXCEPTION_CLASSES).toEqual(['retry', 'human_work', 'handoff']);
    for (const klass of IDENTITY_EXCEPTION_CLASSES) {
      expect(identityReviewOutputSchema.parse({
        flags: [], exceptions: [{ toolName: 'google_remove_license', classification: klass, detail: 'd' }], summary: 's',
      }).exceptions[0]!.classification).toBe(klass);
    }
    expect(() => identityReviewOutputSchema.parse({
      flags: [], exceptions: [{ toolName: 'google_remove_license', classification: 'ignore', detail: 'd' }], summary: 's',
    })).toThrow();
  });

  it('carries no effect list — the model never edits the plan', () => {
    expect(() => identityReviewOutputSchema.parse({ flags: [], exceptions: [], summary: 's', effects: [] })).toThrow();
  });

  it('exposes the flag enum for the recipe and the UI to share', () => {
    expect([...IDENTITY_REVIEW_FLAGS]).toEqual([
      'sole_group_owner', 'dynamic_group_membership', 'role_assignable_group',
      'shared_mailbox_risk', 'service_account_suspected', 'license_orphans_mailbox',
      'no_mail_destination', 'unverified_forward_address',
    ]);
  });
});
