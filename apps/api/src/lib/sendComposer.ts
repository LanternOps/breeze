import type { Context } from 'hono';
import { z } from 'zod';

/**
 * The customer-email composer shared by the quote and invoice send paths.
 *
 * `.strict()` so a mis-keyed field (e.g. {"mesage":"hi"}) is a 400, not a
 * silently dropped note — a recipient or a personal message the sender believed
 * they had supplied must never vanish between the browser and the envelope.
 *
 * Extracted from routes/quotes/lifecycle.ts when the invoice routes grew the
 * same composer (re-send parity): the two schemas MUST agree, because the web
 * composer that posts to them is the same dialog shape and its client-side
 * guards (10 recipients, 2000-char note, 200-char subject) are written against
 * these limits.
 */
const sendEmailField = z.string().trim().email().max(255);

export const sendComposerSchema = z.object({
  message: z.string().trim().max(2000).optional(),
  // Composer fields (all optional — an empty body reproduces the classic send):
  // explicit recipients override the org billing-contact fallback.
  to: z.array(sendEmailField).min(1).max(10).optional(),
  cc: z.array(sendEmailField).max(10).optional(),
  subject: z.string().trim().max(200).optional(),
  includePdf: z.boolean().optional(),
  // #3205 W07: NOT a send option — the route persists it onto
  // invoices.device_appendix BEFORE issuing, because the PDF is rendered by an
  // async BullMQ job and deliverInvoiceEmail reuses a stored PDF. A flag passed
  // as a render argument would be dropped in the common path and silently lost
  // on any later re-render. composerOptions() deliberately does not forward it.
  includeDeviceAppendix: z.boolean().optional(),
}).strict();

export type SendComposerBody = z.infer<typeof sendComposerSchema>;

/**
 * Read an optional composer body.
 *
 * Distinguishes an ABSENT body (most callers — bulk-send/MCP/tests POST nothing,
 * yet fetchWithAuth still stamps a JSON content-type) from a PRESENT-but-broken
 * one. An empty body degrades to "no options"; a non-empty body that fails to
 * parse/validate is rejected rather than silently swallowing recipients or a
 * note the sender intended. A body-READ failure (stream aborted mid-request) is
 * likewise an error, not an absent body.
 *
 * Returns the parsed options, or an `error` the caller returns verbatim.
 */
export async function parseComposerBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: Partial<z.infer<T>> } | { ok: false; error: string }> {
  if (!(c.req.header('content-type') ?? '').includes('application/json')) return { ok: true, data: {} };
  const raw = await c.req.text().catch(() => null);
  if (raw === null) return { ok: false, error: 'Could not read request body' };
  if (!raw.trim()) return { ok: true, data: {} };
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, error: 'Invalid JSON body' }; }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'Invalid send options' };
  return { ok: true, data: parsed.data };
}
