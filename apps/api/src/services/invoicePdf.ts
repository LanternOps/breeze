// TODO(Phase 5): replace this stub with real HTML→PDF rendering + artifact store
// and transactional email delivery. Phase 4 only needs these symbols to exist so
// the lifecycle route (POST /:id/send) and the PDF render job compile and behave
// sensibly (sending currently just issues the invoice).
import type { InvoiceActor } from './invoiceTypes';

// TODO(Phase 5): real implementation renders the PDF, stores the artifact, and
// dispatches the email. For now /send simply issues the invoice so the lifecycle
// endpoint is functional end-to-end.
export async function sendInvoiceEmail(invoiceId: string, actor: InvoiceActor) {
  const { issueInvoice } = await import('./invoiceService');
  return issueInvoice(invoiceId, actor);
}

// TODO(Phase 5): real implementation renders + persists the invoice PDF artifact.
export async function renderInvoicePdf(_invoiceId: string): Promise<void> {
  // no-op stub
}
