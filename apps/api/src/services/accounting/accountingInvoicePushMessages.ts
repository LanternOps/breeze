/**
 * Operator-visible text of the invoice push/void coordinator
 * (`accountingInvoicePush.ts`), labelled by the provider's display name
 * (`accountingProviderDisplayName`) — Xero W04, W01d deferral R3. With the
 * label 'QuickBooks' every string is byte-identical to the literal it
 * replaced; accountingInvoicePushMessages.test.ts pins each one.
 */
export const invoicePushMessages = {
  notPushable: (label: string) =>
    `Invoice must be issued and not void before it can be pushed to ${label}`,
  remoteDeleted: (label: string) =>
    `${label} reports this invoice as deleted — pushing again would create a duplicate. Resolve it in ${label}, or unlink and re-map the invoice, before pushing again.`,
  customerNotMapped: (label: string) =>
    `This organization is not mapped to a ${label} customer yet — confirm or create a mapping first`,
  customerCurrencyMismatch: (label: string, remoteCurrency: string, invoiceCurrency: string) =>
    `The ${label} customer for this organization is stamped in ${remoteCurrency}, which does not match this invoice's ${invoiceCurrency} currency`,
  customerSyncNoRemoteId: (label: string) =>
    `${label} customer sync did not return a remote id`,
  concurrentSync: (label: string) =>
    `A concurrent ${label} sync for this invoice is already in progress; retry shortly`,
  persistNoRow: (label: string, mappingId: string) =>
    `persistInvoiceRemoteRef matched no accounting_entity_mappings row (id=${mappingId}); refusing to lose the ${label} sync result`,
  recordFailed: (label: string, remoteId: string) =>
    `${label} accepted the invoice sync (remote id ${remoteId}) but Breeze failed to record it — do not retry; contact support to reconcile`,
  voidPushInFlight: (label: string) =>
    `A ${label} push for this invoice is still in flight; the void will be retried once it completes`,
  // --- Xero W04 refusals (terminal; see accountingInvoicePush.ts `invoicePushRefusal`) ---
  remoteMissing: (label: string) =>
    `The ${label} invoice for this invoice no longer exists or was voided there — pushing again cannot restore it. Check the invoice in ${label}; to send it again, void and re-issue it in Breeze.`,
  remoteAmbiguous: (label: string) =>
    `${label} holds more than one invoice for this Breeze invoice — void or delete the extra one in ${label}, then push again`,
  remoteLocked: (label: string) =>
    `${label} will not update this invoice because a payment or credit is applied to it there, and its amounts differ from Breeze — remove or unapply it in ${label}, then push again`,
} as const;
