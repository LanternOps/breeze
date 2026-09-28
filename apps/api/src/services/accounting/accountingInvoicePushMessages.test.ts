import { describe, expect, it } from 'vitest';
import { invoicePushMessages as m } from './accountingInvoicePushMessages';

describe('invoice push operator messages', () => {
  // Every string below is copied verbatim from accountingInvoicePush.ts on main
  // before Xero W04. QuickBooks operators must see byte-identical text.
  it.each<[string, string, string]>([
    ['notPushable', m.notPushable('QuickBooks'), 'Invoice must be issued and not void before it can be pushed to QuickBooks'],
    ['remoteDeleted', m.remoteDeleted('QuickBooks'), 'QuickBooks reports this invoice as deleted — pushing again would create a duplicate. Resolve it in QuickBooks, or unlink and re-map the invoice, before pushing again.'],
    ['customerNotMapped', m.customerNotMapped('QuickBooks'), 'This organization is not mapped to a QuickBooks customer yet — confirm or create a mapping first'],
    ['customerCurrencyMismatch', m.customerCurrencyMismatch('QuickBooks', 'CAD', 'USD'), "The QuickBooks customer for this organization is stamped in CAD, which does not match this invoice's USD currency"],
    ['customerSyncNoRemoteId', m.customerSyncNoRemoteId('QuickBooks'), 'QuickBooks customer sync did not return a remote id'],
    ['concurrentSync', m.concurrentSync('QuickBooks'), 'A concurrent QuickBooks sync for this invoice is already in progress; retry shortly'],
    ['persistNoRow', m.persistNoRow('QuickBooks', 'map-1'), 'persistInvoiceRemoteRef matched no accounting_entity_mappings row (id=map-1); refusing to lose the QuickBooks sync result'],
    ['recordFailed', m.recordFailed('QuickBooks', 'qb-9'), 'QuickBooks accepted the invoice sync (remote id qb-9) but Breeze failed to record it — do not retry; contact support to reconcile'],
    ['voidPushInFlight', m.voidPushInFlight('QuickBooks'), 'A QuickBooks push for this invoice is still in flight; the void will be retried once it completes'],
  ])('%s is byte-identical for QuickBooks', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it('labels every message by the provider it is given', () => {
    expect(m.customerNotMapped('Xero')).toBe('This organization is not mapped to a Xero customer yet — confirm or create a mapping first');
    expect(m.remoteDeleted('Xero')).not.toMatch(/QuickBooks/);
    expect(m.notPushable('Xero')).toBe('Invoice must be issued and not void before it can be pushed to Xero');
  });

  it('names the remedy for each Xero W04 refusal', () => {
    expect(m.remoteMissing('Xero')).toBe(
      'The Xero invoice for this invoice no longer exists or was voided there — pushing again cannot restore it. Check the invoice in Xero; to send it again, void and re-issue it in Breeze.',
    );
    expect(m.remoteAmbiguous('Xero')).toBe(
      'Xero holds more than one invoice for this Breeze invoice — void or delete the extra one in Xero, then push again',
    );
    expect(m.remoteLocked('Xero')).toBe(
      'Xero will not update this invoice because a payment or credit is applied to it there, and its amounts differ from Breeze — remove or unapply it in Xero, then push again',
    );
  });
});
