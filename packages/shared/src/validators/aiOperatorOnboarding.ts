import { z } from 'zod';
import { IDENTITY_EXCEPTION_CLASSES } from './aiOperatorIdentity';

/**
 * `identity_onboarding`'s wire contracts (Recipe Library spec §6.3, §6.2, §7.1;
 * W07 Amendment B3).
 *
 * In `packages/shared` because three consumers need the same objects: the API's
 * recipe (which freezes the input at admission), the web start form, and the
 * eval corpus. It holds NO logic — the staging contract, the effect catalog,
 * the privileged-group filter and the degradation rules all live in the recipe,
 * which is the only place that may know them.
 *
 * THE POLARITY IS INVERTED FROM OFFBOARDING. There, a forgotten switch leaves
 * access in place, so destructive effects default ON. Here, a forgotten switch
 * would GRANT access nobody chose, so every grant list defaults EMPTY and there
 * is no "give them what everyone gets" default anywhere in this file.
 *
 * NO `.transform()` (B.0 item 11). The task checkpoint stores the parsed
 * OUTPUT and re-parses it on every wake, and the input is `.strict()`; a
 * transform that added a key would make the stored value unparseable. Values
 * derived from the input are pure helpers (`onboardingProviders`). The list
 * de-duplication uses `.overwrite()`, which keeps the type and is idempotent,
 * so a parsed value parses again to itself.
 */

const uuid = z.string().uuid();
const addressSchema = z.string().email().max(320);
/** ISO 3166-1 alpha-2. Graph rejects anything else, and a licence cannot be
 *  assigned to a user with no usageLocation (W05's `usageLocationSchema`). */
const usageLocationSchema = z.string().regex(/^[A-Z]{2}$/);
/** Graph's mailNickname alphabet, mirroring W05's arm for `m365.user.create`. */
const mailNicknameSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);

/**
 * Bounded BEFORE de-duplication (the bound is on what was sent), then
 * lowercased and de-duplicated in place. Lowercase is the canonical form for
 * every list this is used on: Graph GUIDs compare case-insensitively, and the
 * recipe and discovery compare Google group addresses by their lowercase
 * form. Lowercasing an already-lowercase list is a no-op, so this stays
 * idempotent (a parsed value parses again to itself).
 */
const uniqueLowercaseArray = (inner: z.ZodString, max: number) =>
  z.array(inner).max(max).overwrite((xs) => [...new Set(xs.map((x) => x.toLowerCase()))]);

/**
 * The Microsoft 365 account to create and what it gets.
 *
 * `userPrincipalName` is the technician's choice and is the ONLY thing the
 * create effect addresses — the immutable object id does not exist yet, which
 * is why provisioning is a second plan stage (see the recipe's staging
 * contract). `skuIds` and `groupIds` are Graph GUIDs; the recipe never derives
 * them and never adds to them.
 */
const m365BlockSchema = z.object({
  userPrincipalName: addressSchema,
  mailNickname: mailNicknameSchema,
  usageLocation: usageLocationSchema,
  skuIds: uniqueLowercaseArray(uuid, 20).default([]),
  groupIds: uniqueLowercaseArray(uuid, 50).default([]),
}).strict();

/**
 * The Google Workspace account and what it gets.
 *
 * Breeze has no Google create-user tool at this baseline, so the account
 * itself is created by hand from a generated human-work item and these fields
 * are the instructions for that step as well as the arguments for the
 * provisioning effects. `orgUnitPath` must be absolute because that is what
 * the Directory API takes.
 */
const googleBlockSchema = z.object({
  primaryEmail: addressSchema,
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  orgUnitPath: z.string().min(1).max(512).regex(/^\//).nullable().default(null),
  /** `[productId, skuId]` pairs — Google's licensing API takes both. */
  licenses: z.array(z.object({
    productId: z.string().min(1).max(128),
    skuId: z.string().min(1).max(128),
  }).strict()).max(10).default([]),
  groupEmails: uniqueLowercaseArray(addressSchema, 50).default([]),
}).strict();

export const IDENTITY_ONBOARDING_PROVIDERS = Object.freeze(['m365', 'google'] as const);
export type IdentityOnboardingProvider = (typeof IDENTITY_ONBOARDING_PROVIDERS)[number];

export const identityOnboardingInputSchema = z.object({
  /** The new hire's display name. Required: it is the contact's identity, the
   *  created account's displayName, and the target label frozen on the task. */
  displayName: z.string().min(1).max(255),
  jobTitle: z.string().min(1).max(255).nullable().default(null),
  /** The site the new contact belongs to, when the technician picked one. */
  siteId: uuid.nullable().default(null),
  /** Who the new hire reports to. Recorded on the contact and named in the
   *  handover instructions; never an effect target. */
  managerContactId: uuid.nullable().default(null),
  /**
   * Copy this person's groups and licences. A SOURCE, not an authority:
   * discovery reads their memberships, the recipe REMOVES every privileged
   * and dynamic one, and the technician confirms what is left in the
   * plan-approval card. Nothing about that lives in this schema.
   */
  modelAfterContactId: uuid.nullable().default(null),
  /** When the person starts. Absent means "provision now and hand over now". */
  startAt: z.string().datetime().nullable().default(null),

  m365: m365BlockSchema.nullable().default(null),
  google: googleBlockSchema.nullable().default(null),
}).strict()
  .refine((v) => v.m365 !== null || v.google !== null, {
    path: ['m365'],
    message: 'Provide at least one provider block (m365 and/or google).',
  });
export type IdentityOnboardingInput = z.infer<typeof identityOnboardingInputSchema>;

/**
 * Which providers are in scope. Derived, never supplied: a provider is enabled
 * iff its block is present. A separate boolean map on the wire could contradict
 * the blocks, and the recipe would then have two sources of truth for "is
 * Google in scope". Pure, so it is safe on a re-parsed checkpoint.
 */
export function onboardingProviders(
  input: Pick<IdentityOnboardingInput, 'm365' | 'google'>,
): { m365: boolean; google: boolean } {
  return { m365: input.m365 !== null, google: input.google !== null };
}

/**
 * `intake`'s output — what the model may propose into `confirm_details`.
 *
 * IDS, ONE BOOLEAN AND PROSE. There is deliberately no chosen id: the model
 * proposes candidates for the manager and the model-after person and a HUMAN
 * confirms (spec §6.2 "Output is candidate ids; the technician confirms").
 * `.strict()` makes an added field a refusal rather than an ignored one.
 */
export const identityOnboardingConfirmOutputSchema = z.object({
  managerCandidateContactIds: z.array(uuid).min(0).max(5),
  modelAfterCandidateContactIds: z.array(uuid).min(0).max(5),
  ambiguous: z.boolean(),
  rationale: z.string().min(1).max(1000),
}).strict();
export type IdentityOnboardingConfirmOutput = z.infer<typeof identityOnboardingConfirmOutputSchema>;

/** The CLOSED set of things `review` may flag. Anything else is prose in `summary`. */
export const IDENTITY_ONBOARDING_REVIEW_FLAGS = Object.freeze([
  'upn_collision',
  'email_collision',
  'no_seat_available',
  'privileged_group_in_model',
  'dynamic_group_membership',
  'role_assignable_group',
  'unverified_domain',
  'model_after_service_account',
  'missing_usage_location',
  'manager_not_in_org',
] as const);
export type IdentityOnboardingReviewFlag = (typeof IDENTITY_ONBOARDING_REVIEW_FLAGS)[number];

/**
 * `review`'s output — the model's flags and exception classifications.
 *
 * Each flag maps mechanically to a plan exclusion or a generated human-work
 * item, in the recipe, not here. Exceptions are classified into R1's three
 * dispositions, imported rather than re-declared. There is no effect list, no
 * ordinal, no SKU and no group id anywhere in this object: the model never
 * edits the plan (spec §6.2's closing rule).
 */
export const identityOnboardingReviewOutputSchema = z.object({
  flags: z.array(z.object({
    code: z.enum(IDENTITY_ONBOARDING_REVIEW_FLAGS),
    subject: z.string().min(1).max(320),
    detail: z.string().min(1).max(500),
  }).strict()).max(60),
  exceptions: z.array(z.object({
    toolName: z.string().min(1).max(128),
    classification: z.enum(IDENTITY_EXCEPTION_CLASSES),
    detail: z.string().min(1).max(500),
  }).strict()).max(20),
  summary: z.string().min(1).max(2000),
}).strict();
export type IdentityOnboardingReviewOutput = z.infer<typeof identityOnboardingReviewOutputSchema>;
