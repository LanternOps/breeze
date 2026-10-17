// Owner: W02d (gated documents and access requests) — Trust Center W2 (#8770).
// Anonymous request → email verification → MSP approval → 7-day download link (spec trust-center §12, amendments 32/35).
// Raw tokens travel only in POST bodies (and in URL fragments on the portal side), never in a path or query string.
import { z } from 'zod';
import { trustSlugSchema } from './trustCenter';

export const TRUST_ACCESS_VERIFY_TTL_HOURS = 24;
export const TRUST_ACCESS_GRANT_TTL_DAYS = 7;
export const TRUST_ACCESS_DECISION_NOTE_MAX = 500;

export const trustAccessRequestCreateSchema = z.strictObject({
  partnerSlug: trustSlugSchema,
  orgSlug: trustSlugSchema.nullable(),
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().min(2).max(200),
  company: z.string().trim().min(2).max(200),
  purpose: z.string().trim().min(10).max(2000),
  ndaAccepted: z.boolean(),
});
export type TrustAccessRequestCreate = z.infer<typeof trustAccessRequestCreateSchema>;

/** Raw tokens are 48-char nanoids; the bounds leave room without accepting arbitrary blobs. */
export const trustAccessTokenBodySchema = z.strictObject({ token: z.string().min(40).max(64) });
export const trustAccessDownloadSchema = trustAccessTokenBodySchema.extend({ documentId: z.string().guid() });
export const trustAccessDecisionSchema = z.strictObject({
  note: z.string().trim().max(TRUST_ACCESS_DECISION_NOTE_MAX).nullable().optional(),
});
export type TrustAccessDecisionInput = z.infer<typeof trustAccessDecisionSchema>;

export const TRUST_ACCESS_REQUEST_STATUSES = ['pending_verification', 'pending_approval', 'approved', 'denied', 'revoked'] as const;
export type TrustAccessRequestStatus = (typeof TRUST_ACCESS_REQUEST_STATUSES)[number];
export const trustAccessRequestStatusSchema = z.enum(TRUST_ACCESS_REQUEST_STATUSES);
