import { describe, it, expect } from 'vitest';
import { DOCUMENT_LABELS_EN, documentLabelsFor } from './labels';

const Q = DOCUMENT_LABELS_EN.quote;

describe('quote document labels (English = what the portal prints today)', () => {
  it('header, cover and dates', () => {
    expect(Q.eyebrow).toBe('Proposal');
    expect(Q.draftNumber).toBe('Proposal');
    expect(Q.issued).toBe('Issued');
    expect(Q.validUntil).toBe('Valid until');
    expect(Q.preparedFor).toBe('Prepared for');
    expect(Q.preparedBy).toBe('Prepared by');
  });

  it('pricing table', () => {
    expect(Q.columns).toEqual({ description: 'Description', qty: 'Qty', unitPrice: 'Unit price', tax: 'Tax', amount: 'Amount' });
    expect(Q.pricing).toBe('Pricing');
    expect(Q.cadence).toEqual({ one_time: 'One-time', monthly: 'Monthly', annual: 'Annual' });
    expect(Q.tableSubtotal).toBe('Subtotal');
    expect(Q.imageAlt).toBe('Proposal image');
    expect(Q.imageUnavailable).toBe('Image unavailable');
  });

  it('device-set sentences', () => {
    expect(Q.deviceSet.estimated('seats')).toBe('Estimated quantity — billed at the actual number of seats each billing period.');
    expect(Q.deviceSet.devices).toBe('devices');
    expect(Q.deviceSet.seats).toBe('seats');
    expect(Q.deviceSet.role('server')).toBe('servers');
    expect(Q.deviceSet.role('access_point')).toBe('access points');
    expect(Q.deviceSet.role('mystery')).toBe('mystery');
    expect(Q.deviceSet.inGroup('Servers')).toBe('devices in “Servers”');
    expect(Q.deviceSet.atSite('devices', 'HQ')).toBe('devices at HQ');
    expect(Q.deviceSet.includesBilled('5', '$10.00')).toBe('Includes 5; additional units billed at $10.00 each.');
    expect(Q.deviceSet.includesFlagged('5')).toBe('Includes 5; additional units are reported for review, not billed automatically.');
  });

  it('totals', () => {
    expect(Q.totals.firstPeriodSubtotal).toBe('First period subtotal');
    expect(Q.totals.subtotal).toBe('Subtotal');
    expect(Q.totals.tax('8.5')).toBe('Tax (8.5%)');
    expect(Q.totals.tax(null)).toBe('Tax');
    expect(Q.totals.monthlyRecurring).toBe('Monthly recurring');
    expect(Q.totals.annualRecurring).toBe('Annual recurring');
    expect(Q.totals.dueOnAcceptance).toBe('Due on acceptance');
    expect(Q.totals.depositDueNow).toBe('Deposit due now');
    expect(Q.totals.remainingBalance).toBe('Remaining balance (due per terms)');
    expect(Q.totals.total).toBe('Total');
    expect(Q.totals.firstPeriodTotal).toBe('First-period total');
    expect(Q.totals.recurringNote).toBe('Accepting this proposal bills only the one-time charges now. Recurring lines bill on their own schedule.');
    expect(Q.category('hardware')).toBe('Hardware');
    expect(Q.category('')).toBe('');
    expect(Q.terms).toBe('Terms');
  });

  it('agreements', () => {
    expect(Q.agreement.fallbackTitle).toBe('Agreement');
    expect(Q.agreement.termsTitle).toBe('Terms & Conditions');
    expect(Q.agreement.pdfMeta).toBe('PDF document');
    expect(Q.agreement.unavailableMeta).toBe('Unavailable');
    expect(Q.agreement.readMinutes(4)).toBe('~4 min read');
    expect(Q.agreement.termsMeta(2, 3)).toBe('2 sections · ~3 min read');
    expect(Q.agreement.termsMeta(1, 1)).toBe('1 section · ~1 min read');
    expect(Q.agreement.termsMeta(0, 1)).toBe('~1 min read');
    expect(Q.agreement.footer('MSA', 2)).toBe('MSA — v2');
    expect(Q.agreement.contentUnavailable).toBe('Agreement content unavailable');
    expect(Q.agreement.fileUnavailable).toBe('Agreement file unavailable');
    expect(Q.agreement.download).toBe('Download agreement');
  });

  it("status pill labels (the logged-in portal's map, keyed by displayStatus)", () => {
    expect(Q.status).toEqual({
      viewed: 'Viewed', accepted: 'Accepted', declined: 'Declined', expired: 'Expired',
      converted: 'Accepted', superseded: 'Replaced',
    });
  });

  it('every locale resolves to the English quote map until a locale ships its own', () => {
    expect(documentLabelsFor('fr-FR').quote).toBe(Q);
  });
});
