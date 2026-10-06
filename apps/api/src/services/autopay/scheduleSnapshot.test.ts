import { expect, it } from 'vitest';
import { autopayTermsSnapshotSchema, parseAutopayTerms } from '@breeze/shared';
import { collectionFenced, pendingInvoiceControl } from './collectionControl';
it('parses legacy placeholders without granting collection terms', () => {
  expect(autopayTermsSnapshotSchema.parse({ issuedAt: '2026-10-01T00:00:00Z', noticeSeq: 0 })).toMatchObject({ kind: 'placeholder' });
  expect(() => parseAutopayTerms({ issuedAt: '2026-10-01T00:00:00Z', noticeSeq: 0 })).toThrow();
  expect(() => parseAutopayTerms({ noticeSeq: 1, principal: '100.00' })).toThrow();
});
it('recognizes re-notice controls', () => {
  expect(pendingInvoiceControl('control_pending:renotice')).toBe('renotice');
});
it('uses actual enrollment rows for the shared fence', () => {
  expect(collectionFenced({ schedule: undefined, invoice: { autopayExcluded: false }, enrollment: { status: 'active' } })).toBe(false);
  expect(collectionFenced({ schedule: undefined, invoice: { autopayExcluded: false }, enrollment: { status: 'requested' } })).toBe(true);
});
