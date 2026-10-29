/**
 * `manage_contracts` preview_invoice and generate_invoice (full-control W14 PR
 * B, #6784): the AI twin of POST /contracts/:id/generate
 * (routes/contracts/generate.ts), with the generator's money effects pinned.
 *
 * preview_invoice (t1, contracts:read) answers what the next run would bill:
 * period, lines, subtotal / tax / total, whether it auto-issues and who it
 * would be emailed to (contractInvoicePreview.ts).
 *
 * generate_invoice (tier 3 FOUR-EYES, contracts:manage, agent-human-only) takes
 * the preview's period, total, auto-issue flag and recipients as ASSERTIONS, so
 * the approval card states them, and its effect digest pins the whole preview
 * (mandatory, pinnedEffectPolicy.ts). At release the handler:
 *  1. gates on the caller's own context (partner scope, contract visible,
 *     whole-contract site access) — as the route's getContract;
 *  2. in ONE system transaction: locks the contract row, re-computes the
 *     preview under that lock and refuses unless it equals every assertion
 *     (nothing is written on a refusal), then runs generateDueInvoice, which
 *     takes the same lock first (PR B quorum QB1 / QB10);
 *  3. post-commit, exactly like the route but bounded by the approval: the
 *     draft is auto-issued only when its total is the approved total, and the
 *     issued invoice is emailed only when its total still is, and only to the
 *     approved recipients — never the live billing-contact fallback, and an
 *     approved empty list sends nothing (QB2 / QB3). A withheld issue or email
 *     leaves an editable draft or an issued, unsent invoice and says why.
 *
 * Contracts with a live hour_block line are refused (preview `blocked`): the
 * run closes block periods from logged time that no pin covers (QB10).
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { invoices } from '../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { generateDueInvoice, getContract, lockContractRow, requireWholeContractSiteAccess } from './contractService';
import type { ContractActor } from './contractTypes';
import { previewDueInvoice, type InvoicePreview } from './contractInvoicePreview';
import { issueInvoice } from './invoiceService';
import { sendInvoiceEmail } from './invoicePdf';
import { toCents } from './invoiceMath';
import { captureException } from './sentry';
import { auditToolWrite } from './aiToolsSoftwareShared';
import { canMutateOrgWideGovernance } from './siteCeilingAccess';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

function jsonError(error: string, code: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error, code, ...extra });
}

const normalizeRecipients = (list: readonly string[]): string[] =>
  [...new Set(list.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))].sort();

/** The preview a model or person reads: every figure an approver is asked to sign. */
export function presentPreview(p: InvoicePreview) {
  if (!p.due) return { contractId: p.contractId, due: false, reason: p.reason, nextBillingAt: p.nextBillingAt };
  return {
    contractId: p.contractId, orgId: p.orgId, due: true, period: p.period, currencyCode: p.currencyCode,
    lines: p.lines, subtotal: p.subtotal, taxTotal: p.taxTotal, total: p.total,
    autoIssue: p.autoIssue, recipients: p.recipients, blocked: p.blocked,
    // What generate_invoice must be called with (the approval card shows these).
    ...(p.blocked ? {} : {
      generateWith: { periodStart: p.period.start, expectedTotal: p.total, autoIssue: p.autoIssue, expectedRecipients: p.recipients },
    }),
  };
}

/** The caller's own gate, as the route's getContract (404 / 403) plus the whole-document site check. */
async function gate(contractId: string, actor: ContractActor): Promise<void> {
  await getContract(contractId, actor);
  await requireWholeContractSiteAccess(actor, contractId);
}

export async function previewInvoiceAction(contractId: string, actor: ContractActor): Promise<string> {
  await gate(contractId, actor);
  return JSON.stringify(presentPreview(await previewDueInvoice(contractId)));
}

interface Expectations {
  periodStart: string;
  expectedTotal: string;
  autoIssue: boolean;
  expectedRecipients: string[];
}

function parseExpectations(input: Record<string, unknown>): Expectations | string {
  const { periodStart, expectedTotal, autoIssue, expectedRecipients } = input;
  if (typeof periodStart !== 'string' || !DATE_RE.test(periodStart)
    || typeof expectedTotal !== 'string' || !AMOUNT_RE.test(expectedTotal)
    || typeof autoIssue !== 'boolean'
    || !Array.isArray(expectedRecipients) || !expectedRecipients.every((e) => typeof e === 'string')) {
    return jsonError(
      'generate_invoice needs periodStart, expectedTotal, autoIssue and expectedRecipients exactly as preview_invoice returned them (generateWith)',
      'VALIDATION_ERROR',
    );
  }
  return { periodStart, expectedTotal, autoIssue, expectedRecipients: normalizeRecipients(expectedRecipients as string[]) };
}

/** Null when the live preview is exactly what was approved; otherwise which assertions it breaks. */
function mismatch(p: Extract<InvoicePreview, { due: true }>, e: Expectations): string[] | null {
  const off: string[] = [];
  if (p.period.start !== e.periodStart) off.push('periodStart');
  if (toCents(p.total) !== toCents(e.expectedTotal)) off.push('expectedTotal');
  if (p.autoIssue !== e.autoIssue) off.push('autoIssue');
  if (normalizeRecipients(p.recipients).join(',') !== e.expectedRecipients.join(',')) off.push('expectedRecipients');
  return off.length > 0 ? off : null;
}

type Generated =
  | { kind: 'refused'; body: string }
  | { kind: 'skipped'; skipped: string }
  | { kind: 'generated'; invoiceId: string; total: string; preview: Extract<InvoicePreview, { due: true }>; actor: NonNullable<Awaited<ReturnType<typeof generateDueInvoice>>['actor']>; priceBookGaps: unknown[]; overages: unknown[] };

export async function generateInvoiceAction(
  contractId: string,
  input: Record<string, unknown>,
  auth: AuthContext,
  actor: ContractActor,
): Promise<string> {
  const expected = parseExpectations(input);
  if (typeof expected === 'string') return expected;
  // An invoice bills the whole contract and the org's billing contact: a site- or device-restricted session never
  // generates one (stricter than the route's whole-contract site check, which the gate below still makes).
  if (!canMutateOrgWideGovernance(auth)) {
    return jsonError('Generating an invoice bills the whole organization; a site- or device-restricted session cannot', 'ACCESS_DENIED');
  }

  // 1. The caller's own context (self-managed: no per-call transaction is held).
  await withAuthDbAccessContext(auth, () => gate(contractId, actor));

  // 2. One system transaction, as the route's generate. Checked under the contract lock before any write.
  const outcome = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<Generated> => {
    await lockContractRow(db, contractId);
    const preview = await previewDueInvoice(contractId);
    if (!preview.due) return { kind: 'skipped', skipped: preview.reason };
    if (preview.blocked) {
      return {
        kind: 'refused',
        body: jsonError(
          preview.blocked.code === 'HOUR_BLOCK_NOT_SUPPORTED'
            ? 'This contract bills a block of hours; generate it in the web app'
            : 'A contract line cannot be billed as it stands; fix it in the web app',
          preview.blocked.code, { blocked: preview.blocked },
        ),
      };
    }
    const off = mismatch(preview, expected);
    if (off) {
      return {
        kind: 'refused',
        body: jsonError('The invoice this would generate is not the one that was approved; nothing was generated', 'PREVIEW_MISMATCH', {
          mismatched: off, current: presentPreview(preview),
        }),
      };
    }
    const result = await generateDueInvoice(contractId);
    if (!result.generated || !result.invoiceId || !result.actor) {
      return { kind: 'skipped', skipped: result.skipped ?? 'not_due' };
    }
    const [inv] = await db.select({ total: invoices.total }).from(invoices).where(eq(invoices.id, result.invoiceId)).limit(1);
    return {
      kind: 'generated', invoiceId: result.invoiceId, total: inv?.total ?? '', preview, actor: result.actor,
      priceBookGaps: result.priceBookGaps, overages: result.overages,
    };
  }));

  if (outcome.kind === 'refused') return outcome.body;
  if (outcome.kind === 'skipped') return JSON.stringify({ generated: false, skipped: outcome.skipped });

  const { invoiceId, preview } = outcome;
  auditToolWrite(auth, {
    orgId: preview.orgId, action: 'contract.invoice.generate', resourceType: 'invoice', resourceId: invoiceId,
    details: {
      contractId, periodStart: preview.period.start, total: outcome.total, currencyCode: preview.currencyCode,
      autoIssue: preview.autoIssue, recipientCount: expected.expectedRecipients.length, tool_name: 'manage_contracts',
    },
  });

  // 3. Post-commit, best-effort (the route's rule): PDF + SMTP never hold the billing transaction.
  const base = {
    generated: true, invoiceId, periodStart: preview.period.start, total: outcome.total, currencyCode: preview.currencyCode,
    priceBookGaps: outcome.priceBookGaps, overages: outcome.overages,
  };
  if (!preview.autoIssue) return JSON.stringify({ ...base, status: 'draft' });
  if (toCents(outcome.total) !== toCents(expected.expectedTotal)) {
    return JSON.stringify({ ...base, status: 'draft', autoIssueWithheld: 'total_changed' });
  }
  try {
    const issuedTotal = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      await issueInvoice(invoiceId, outcome.actor);
      const [row] = await db.select({ total: invoices.total }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
      return row?.total ?? '';
    }));
    if (toCents(issuedTotal) !== toCents(expected.expectedTotal)) {
      return JSON.stringify({ ...base, total: issuedTotal, status: 'issued', emailWithheld: 'total_changed' });
    }
    if (expected.expectedRecipients.length === 0) {
      return JSON.stringify({ ...base, status: 'issued', emailWithheld: 'no_approved_recipients' });
    }
    const sent = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      sendInvoiceEmail(invoiceId, outcome.actor, { to: expected.expectedRecipients })));
    return JSON.stringify({
      ...base, status: 'issued', emailSent: sent.emailed, ...(sent.reason ? { emailReason: sent.reason } : {}),
    });
  } catch (err) {
    console.error('[manage_contracts:generate_invoice] post-commit issue/send failed', `invoiceId=${invoiceId}`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return JSON.stringify({ ...base, emailSent: false, issueOrSendFailed: true });
  }
}
