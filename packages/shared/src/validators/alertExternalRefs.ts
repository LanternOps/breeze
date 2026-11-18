import { z } from 'zod';
import { externalTicketIdSchema, externalTicketUrlSchema } from './tickets';

// Match Partner API ticket writes: tabs/newlines are allowed, other control
// characters cannot enter the external identifier/number displayed in feeds.
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/u;

/** Alert refs require https; the existing ticket-ref http(s) contract is unchanged. */
export const alertExternalTicketUrlSchema = externalTicketUrlSchema.refine(
  (url) => /^https:\/\//i.test(url),
  'externalUrl must be an https URL',
);

export const alertExternalTicketPutSchema = z.object({
  externalId: z.string().regex(NO_CONTROL_CHARS, 'control characters are not allowed').pipe(externalTicketIdSchema),
  externalUrl: alertExternalTicketUrlSchema.nullable().optional(),
  externalNumber: z.string().regex(NO_CONTROL_CHARS, 'control characters are not allowed')
    .trim().min(1).max(255).nullable().optional(),
}).strict();
