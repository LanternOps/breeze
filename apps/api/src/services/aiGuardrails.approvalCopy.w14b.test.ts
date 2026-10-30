import { describe, expect, it } from 'vitest';
import { buildApprovalDescription } from './aiGuardrails';

const CONTRACT = 'c0000000-0000-4000-8000-000000000001';
const INVOICE = 'a1b2c3d4-0000-4000-8000-000000000001';
const gen = (over: Record<string, unknown> = {}) => buildApprovalDescription('manage_contracts', 'generate_invoice', {
  contractId: CONTRACT, periodStart: '2026-02-01', expectedTotal: '123.45', autoIssue: true,
  expectedRecipients: ['a@example.test', 'b@example.test'], ...over,
});
const acct = (action: string, over: Record<string, unknown> = {}) =>
  buildApprovalDescription('manage_accounting_sync', action, { provider: 'quickbooks', ...over });

describe('W14 PR B approval copy: generate_invoice', () => {
  it('autoIssue true states the total, period, recipient count and irreversibility', () => {
    const d = gen();
    expect(d).toContain('123.45');
    expect(d).toContain('2026-02-01');
    expect(d).toContain('ISSUE it and email it to 2 recipient(s)');
    expect(d).toContain('cannot be undone');
  });

  it('autoIssue false says draft and does not mention email', () => {
    const d = gen({ autoIssue: false, expectedRecipients: [] });
    expect(d).toContain('leave it as a draft');
    expect(d.toLowerCase()).not.toContain('email');
  });

  it('a missing expectedTotal renders ? and never "undefined"', () => {
    const d = gen({ expectedTotal: undefined });
    expect(d).toContain('total ?');
    expect(d).not.toContain('undefined');
  });

  it('truncates the contract id to 8 chars plus ...', () => {
    const d = gen();
    expect(d).toContain(`${CONTRACT.slice(0, 8)}...`);
    expect(d).not.toContain(CONTRACT);
  });

  it('control: another manage_contracts action keeps the humanized label', () => {
    const d = buildApprovalDescription('manage_contracts', 'activate', { contractId: CONTRACT });
    expect(d).not.toContain('Generate the invoice');
    expect(d).not.toContain('ISSUE');
    expect(d.toLowerCase()).toContain('activate');
  });
});

describe('W14 PR B approval copy: manage_accounting_sync', () => {
  it('push names Xero and says the invoice stays in the books', () => {
    const d = acct('push', { provider: 'xero', invoiceId: INVOICE });
    expect(d).toContain('Xero');
    expect(d).not.toContain('QuickBooks');
    expect(d).toContain('stays in the books');
    expect(d).toContain(`${INVOICE.slice(0, 8)}...`);
  });

  it('push_bulk states the invoice count', () => {
    const d = acct('push_bulk', { invoiceIds: [INVOICE, 'b', 'c'] });
    expect(d).toContain('3 invoice(s)');
    expect(d).toContain('stay in the books');
  });

  it('link_mapping and sync_mapping warn that they OVERWRITE the provider record', () => {
    expect(acct('link_mapping', { entityType: 'org' })).toContain('OVERWRITES');
    expect(acct('sync_mapping', { entityType: 'catalog_item' })).toContain('OVERWRITES');
  });

  it('unlink_mapping says nothing is changed in the provider', () => {
    const d = acct('unlink_mapping', { entityType: 'org' });
    expect(d).toContain('nothing is changed');
    expect(d).not.toContain('OVERWRITES');
  });
});
