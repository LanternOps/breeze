// Owner: W02f (subprocessors, FAQ, history) — Trust Center W2 (#8770).
import { z } from 'zod';
import { TRUST_FAQ_MAX, TRUST_SUBPROCESSORS_MAX } from './trustCenter';

/** Raw (pre-sanitization) FAQ answer cap; the stored, sanitized value is bounded by TRUST_FAQ_ANSWER_MAX_CHARS. */
export const TRUST_FAQ_ANSWER_RAW_MAX_CHARS = 2000;

const httpsWebsite = z.string().trim().max(2048)
  .refine((v) => /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'https URL required');

export const trustSubprocessorSourceSchema = z.enum(['manual', 'security_product', 'backup', 'm365']);

export const trustSubprocessorInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(300),
  location: z.string().trim().max(120).nullable(),
  websiteUrl: httpsWebsite.nullable(),
  source: trustSubprocessorSourceSchema,
  sourceKey: z.string().trim().min(1).max(120).nullable(),
});

/** Replace-all body: the whole list, under the page's revision lock (amendment 34). */
export const trustSubprocessorsPutSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  subprocessors: z.array(trustSubprocessorInputSchema).max(TRUST_SUBPROCESSORS_MAX),
});

export const trustFaqItemInputSchema = z.strictObject({
  question: z.string().trim().min(5).max(300),
  answerHtml: z.string().max(TRUST_FAQ_ANSWER_RAW_MAX_CHARS),
});

export const trustFaqPutSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  items: z.array(trustFaqItemInputSchema).max(TRUST_FAQ_MAX),
});

export type TrustSubprocessorInput = z.infer<typeof trustSubprocessorInputSchema>;
export type TrustSubprocessorsPut = z.infer<typeof trustSubprocessorsPutSchema>;
export type TrustFaqItemInput = z.infer<typeof trustFaqItemInputSchema>;
export type TrustFaqPut = z.infer<typeof trustFaqPutSchema>;
