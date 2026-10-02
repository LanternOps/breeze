import { expectTypeOf, it } from 'vitest';
import type { AutopayCancelSource, AutopayNeedsAttentionReason, AutopayPaymentMethodType, CardFundingType, AccountHolderType, ConsentSource, AutopayIneligibleReason, CollectionFailureClass, CollectionAttemptInitiator } from '@breeze/shared';
import { orgAutopayEnrollments, orgPaymentMethods, orgAutopayConsents, invoiceAutopaySchedules, invoiceCollectionAttempts } from './autopay';
it('uses shared tuple types for every enumerated CHECK-constrained text column', () => {
  type E = typeof orgAutopayEnrollments.$inferSelect;
  type M = typeof orgPaymentMethods.$inferSelect;
  type A = typeof invoiceCollectionAttempts.$inferSelect;
  expectTypeOf<E['cancelSource']>().toEqualTypeOf<AutopayCancelSource | null>();
  expectTypeOf<E['needsAttentionReason']>().toEqualTypeOf<AutopayNeedsAttentionReason | null>();
  expectTypeOf<M['type']>().toEqualTypeOf<AutopayPaymentMethodType>();
  expectTypeOf<M['cardFunding']>().toEqualTypeOf<CardFundingType | null>();
  expectTypeOf<M['accountHolderType']>().toEqualTypeOf<AccountHolderType | null>();
  expectTypeOf<(typeof orgAutopayConsents.$inferSelect)['source']>().toEqualTypeOf<ConsentSource>();
  expectTypeOf<(typeof invoiceAutopaySchedules.$inferSelect)['ineligibleReason']>().toEqualTypeOf<AutopayIneligibleReason | null>();
  expectTypeOf<A['failureClass']>().toEqualTypeOf<CollectionFailureClass | null>();
  expectTypeOf<A['initiatedBy']>().toEqualTypeOf<CollectionAttemptInitiator>();
});
