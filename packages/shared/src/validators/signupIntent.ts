import { z } from 'zod';
import { launchPurchaseSelectionSchema } from './launchPurchaseSelection';

// What a signup is for. Core holds no prices: the billing service resolves the
// offer to terms. The offer is an opaque slug.
const SIGNUP_OFFER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export const signupIntentSchema = z.object({
  intent: z.enum(['cloud', 'wisp']),
  offer: z.string().regex(SIGNUP_OFFER_PATTERN).optional(),
}).strict();

export type SignupIntent = z.infer<typeof signupIntentSchema>;

export const DEFAULT_SIGNUP_INTENT: Readonly<SignupIntent> = Object.freeze({ intent: 'cloud' });

/** Column type for partners.purchase_selection: a new intent or a legacy launch tuple. */
export const partnerPurchaseSelectionSchema = z.union([signupIntentSchema, launchPurchaseSelectionSchema]);
export type PartnerPurchaseSelection = z.infer<typeof partnerPurchaseSelectionSchema>;

const INTENT_KEYS = ['intent', 'offer'] as const;
// Legacy launch-tuple params: the page treats them as the cloud intent.
const ALIAS_KEYS = [...INTENT_KEYS, 'catalog', 'capacity', 'billing'] as const;

/** Lenient URL parse: anything unknown, malformed or duplicated falls back to the default. */
export function parseSignupIntentParams(params: URLSearchParams): SignupIntent {
  if (INTENT_KEYS.some((key) => params.getAll(key).length > 1)) return { ...DEFAULT_SIGNUP_INTENT };
  const candidate: Record<string, string> = {};
  if (params.has('intent')) candidate.intent = params.get('intent')!;
  if (params.has('offer')) candidate.offer = params.get('offer')!;
  if (!params.has('intent') && !params.has('offer')) return { ...DEFAULT_SIGNUP_INTENT };
  const result = signupIntentSchema.safeParse(candidate);
  return result.success ? result.data : { ...DEFAULT_SIGNUP_INTENT };
}

/** API input: omitted or a legacy launch tuple becomes the default; anything else invalid throws ZodError. */
export function normalizeSignupIntent(input: unknown): SignupIntent {
  if (input === undefined) return { ...DEFAULT_SIGNUP_INTENT };
  if (launchPurchaseSelectionSchema.safeParse(input).success) return { ...DEFAULT_SIGNUP_INTENT };
  return signupIntentSchema.parse(input);
}

export function signupIntentHandoffQuery(selection: SignupIntent): string {
  const valid = signupIntentSchema.parse(selection);
  const query = new URLSearchParams({ intent: valid.intent });
  if (valid.offer) query.set('offer', valid.offer);
  return query.toString();
}

/** /register alias: carries only intent, offer and the legacy launch params; everything else (next, utm) is dropped. */
export function registrationAliasTarget(params: URLSearchParams): string {
  const allowed = new URLSearchParams();
  for (const key of ALIAS_KEYS) {
    for (const value of params.getAll(key)) allowed.append(key, value);
  }
  const query = allowed.toString();
  return `/register-partner${query ? `?${query}` : ''}`;
}
