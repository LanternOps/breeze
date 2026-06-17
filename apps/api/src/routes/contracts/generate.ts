import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getContract, generateDueInvoice } from '../../services/contractService';
import { issueInvoice } from '../../services/invoiceService';
import { sendInvoiceEmail } from '../../services/invoicePdf';
import { captureException } from '../../services/sentry';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractActorFrom, handleContractError } from './contracts';

export const contractGenerateRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const managePerm = requirePermission(PERMISSIONS.CONTRACTS_MANAGE.resource, PERMISSIONS.CONTRACTS_MANAGE.action);
const idParam = z.object({ id: z.string().guid() });

contractGenerateRoutes.post('/:id/generate', scopes, managePerm, zValidator('param', idParam), async (c) => {
  try {
    const id = c.req.valid('param').id;
    // Authorize: verify the caller can see this contract (404/403 gate).
    await getContract(id, contractActorFrom(c));
    // Execute generation under system scope (generateDueInvoice runs its own
    // DB writes that must bypass per-request RLS context). This is one
    // all-or-nothing transaction containing only fast DB writes.
    const result = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() => generateDueInvoice(id))
    );

    // Post-commit, best-effort auto-issue + email — done OUTSIDE the billing
    // transaction (PDF render + SMTP must not hold a DB connection or roll back
    // the bill). A send failure leaves a correctly-claimed (issued-or-draft)
    // invoice; we still return success to the client and note the email status.
    // issueInvoice begins with a read (getOwnedInvoiceOr404) that requires an
    // ambient db context — without one it connects as breeze_app with no GUC and
    // the RLS policy returns false, making the invoice invisible. Wrap in a fresh
    // system context (outside the already-committed billing txn) so reads resolve.
    let emailSent: boolean | undefined;
    if (result.generated && result.autoIssue && result.invoiceId && result.actor) {
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
          await issueInvoice(result.invoiceId!, result.actor!);
          await sendInvoiceEmail(result.invoiceId!, result.actor!);
        }));
        emailSent = true;
      } catch (err) {
        emailSent = false;
        console.error('[contracts/generate] post-commit issue/send failed', `invoiceId=${result.invoiceId}`, err instanceof Error ? err.message : err);
        captureException(err instanceof Error ? err : new Error(String(err)));
      }
    }
    return c.json({ data: emailSent === undefined ? result : { ...result, emailSent } });
  } catch (err) { return handleContractError(c, err); }
});
