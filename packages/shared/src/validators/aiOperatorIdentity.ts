import { z } from 'zod';

/**
 * `identity_offboarding`'s wire contracts (Recipe Library spec §6.2, §6.3).
 *
 * This file is in `packages/shared` because three consumers need the same
 * objects: the API's recipe (which freezes the input at admission), the web
 * start form, and the eval corpus. It holds NO logic — the ordering contract,
 * the effect catalog and the degradation rules all live in the recipe, which
 * is the only place that may know them.
 */

const uuid = z.string().uuid();

/**
 * Per-effect toggles.
 *
 * The default of each is the answer to "which way round is the DAMAGE if the
 * technician never looks at this switch?".
 *
 *  - Mail continuity (autoReply, forwarding): default ON. Leaving a departed
 *    person's mail silently unrouted is the failure an MSP gets a complaint
 *    about, and neither effect destroys anything.
 *  - Access removal (removeGroups, removeLicenses, revokeSessions,
 *    disableAccount): default ON. This is the outcome the recipe exists to
 *    prove; a leaver who can still sign in is the failure spec §3 names.
 *  - mailDelegate: default OFF. Granting a second person full read of a
 *    mailbox is a data-access decision with a legal dimension, and it must be
 *    chosen, never inherited from a default.
 *  - wipeMobile: default OFF. The device is very often the person's own
 *    property. Even the SELECTIVE wipe removes their work mail from a phone
 *    they own, and an MSP should say so out loud before doing it.
 */
export const identityOffboardingEffectsSchema = z.object({
  autoReply: z.boolean().default(true),
  forwarding: z.boolean().default(true),
  mailDelegate: z.boolean().default(false),
  removeGroups: z.boolean().default(true),
  removeLicenses: z.boolean().default(true),
  revokeSessions: z.boolean().default(true),
  wipeMobile: z.boolean().default(false),
  disableAccount: z.boolean().default(true),
}).strict();

export const IDENTITY_OFFBOARDING_EFFECT_TOGGLES = Object.freeze([
  'autoReply', 'forwarding', 'mailDelegate', 'removeGroups',
  'removeLicenses', 'revokeSessions', 'wipeMobile', 'disableAccount',
] as const);

export const identityOffboardingInputSchema = z.object({
  /** The resolved person, when the technician already knows who they mean. */
  contactId: uuid.nullable().default(null),
  /** Free text for the `intake` reason step to resolve. Never used as a target. */
  personHint: z.string().min(1).max(200).nullable().default(null),

  /** Who inherits the mail — a contact, or a raw address, never both. */
  inheritorContactId: uuid.nullable().default(null),
  forwardTo: z.string().email().max(320).nullable().default(null),

  autoReplyMessage: z.string().min(1).max(4000).nullable().default(null),
  /** The scheduled last-day cutoff. Absent means "start now". */
  cutoffAt: z.string().datetime().nullable().default(null),

  /**
   * Keep the mailbox after the licence comes off. On M365 this makes licence
   * removal depend on a shared-mailbox conversion that has no Graph API
   * (spec §7.3), so the recipe inserts a mandatory human-work step BEFORE the
   * licence effect. See the recipe's ordering contract.
   */
  keepMailbox: z.boolean().default(false),

  /**
   * Breeze devices the technician explicitly selected. There is no device ↔
   * person link in this schema (`devices.last_user` is an unvalidated OS
   * username string), so this list is never derived — it is chosen.
   */
  deviceIds: z.array(uuid).max(10).default([]),

  // `.prefault`, not `.default`: zod 4 returns a `.default()` value as-is
  // without parsing it, which would skip every per-toggle default above.
  effects: identityOffboardingEffectsSchema.prefault({}),
}).strict()
  .superRefine((v, ctx) => {
    const named = [v.contactId, v.personHint].filter((x) => x !== null).length;
    if (named !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['contactId'],
        message: 'Provide exactly one of contactId or personHint.',
      });
    }
    if (v.inheritorContactId !== null && v.forwardTo !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['forwardTo'],
        message: 'Provide at most one of inheritorContactId or forwardTo.',
      });
    }
  });
export type IdentityOffboardingInput = z.infer<typeof identityOffboardingInputSchema>;

/**
 * `intake`'s output — what the model may propose into `confirm_identity`.
 *
 * IDS AND PROSE ONLY. There is deliberately no `chosenContactId`: the model
 * proposes candidates and a HUMAN confirms one (spec §11, risk row 1, and
 * §6.2 "Output is candidate ids; the technician confirms"). `.strict()` is
 * what makes an added field a refusal rather than an ignored one.
 */
export const identityIntakeOutputSchema = z.object({
  candidateContactIds: z.array(uuid).min(0).max(5),
  ambiguous: z.boolean(),
  rationale: z.string().min(1).max(1000),
}).strict();
export type IdentityIntakeOutput = z.infer<typeof identityIntakeOutputSchema>;

/** The CLOSED set of things `review` may flag. Anything else is prose in `summary`. */
export const IDENTITY_REVIEW_FLAGS = Object.freeze([
  'sole_group_owner',
  'dynamic_group_membership',
  'role_assignable_group',
  'shared_mailbox_risk',
  'service_account_suspected',
  'license_orphans_mailbox',
  'no_mail_destination',
  'unverified_forward_address',
] as const);
export type IdentityReviewFlag = (typeof IDENTITY_REVIEW_FLAGS)[number];

export const IDENTITY_EXCEPTION_CLASSES = Object.freeze(['retry', 'human_work', 'handoff'] as const);
export type IdentityExceptionClass = (typeof IDENTITY_EXCEPTION_CLASSES)[number];

/**
 * `review`'s output — what the model may propose into `effects` (amended 2026-10-18).
 *
 * Flags come from the closed enum above so the recipe can act on them
 * mechanically (each one maps to a generated human-work item or a plan
 * exclusion, in the recipe, not here). Exceptions are classified into the
 * three dispositions spec §6.2 item 3 permits. There is no effect list, no
 * ordinal and no argument anywhere in this object: the model never edits the
 * plan.
 */
export const identityReviewOutputSchema = z.object({
  flags: z.array(z.object({
    code: z.enum(IDENTITY_REVIEW_FLAGS),
    subject: z.string().min(1).max(320),
    detail: z.string().min(1).max(500),
  }).strict()).max(40),
  exceptions: z.array(z.object({
    toolName: z.string().min(1).max(128),
    classification: z.enum(IDENTITY_EXCEPTION_CLASSES),
    detail: z.string().min(1).max(500),
  }).strict()).max(20),
  summary: z.string().min(1).max(2000),
}).strict();
export type IdentityReviewOutput = z.infer<typeof identityReviewOutputSchema>;
