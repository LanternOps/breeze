import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const order: string[] = [];
  return {
    rows, order,
    select: vi.fn(() => {
      const result = rows.length > 0 ? rows.shift()! : [];
      const proxy: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          return () => proxy;
        },
      });
      return proxy;
    }),
    getContract: vi.fn(),
    requireSite: vi.fn(),
    lock: vi.fn(),
    generate: vi.fn(),
    preview: vi.fn(),
    issue: vi.fn(),
    send: vi.fn(),
    capture: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./contractService', () => ({
  getContract: h.getContract, requireWholeContractSiteAccess: h.requireSite,
  lockContractRow: h.lock, generateDueInvoice: h.generate,
}));
vi.mock('./contractInvoicePreview', () => ({ previewDueInvoice: h.preview }));
vi.mock('./invoiceService', () => ({ issueInvoice: h.issue }));
vi.mock('./invoicePdf', () => ({ sendInvoiceEmail: h.send }));
vi.mock('./sentry', () => ({ captureException: h.capture }));
vi.mock('./aiToolsSoftwareShared', () => ({ auditToolWrite: h.audit }));

import type { AuthContext } from '../middleware/auth';
import type { ContractActor } from './contractTypes';
import type { InvoicePreview } from './contractInvoicePreview';
import { generateInvoiceAction, presentPreview, previewInvoiceAction } from './aiToolsContractInvoice';

const CONTRACT = 'c0000000-0000-4000-8000-000000000001';
const INVOICE = 'i0000000-0000-4000-8000-000000000001';
const auth = { user: { id: 'u1', email: 'a@example.test' }, scope: 'partner' } as unknown as AuthContext;
const actor = { userId: 'u1', partnerId: 'p1' } as unknown as ContractActor;
const genActor = { userId: 'u1', partnerId: 'p1', marker: 'generated' };

type DuePreview = Extract<InvoicePreview, { due: true }>;
const duePreview = (over: Partial<DuePreview> = {}): DuePreview => ({
  due: true, contractId: CONTRACT, orgId: 'org-1', partnerId: 'p1',
  period: { start: '2026-02-01', end: '2026-02-28' }, currencyCode: 'USD', autoIssue: true,
  lines: [], subtotal: '100.00', taxRate: null, taxTotal: '0.00', total: '100.00',
  recipients: ['ap@example.test'], blocked: null, ...over,
});
const good = {
  periodStart: '2026-02-01', expectedTotal: '100.00', autoIssue: true, expectedRecipients: ['AP@example.test '],
};
const gen = async (input: Record<string, unknown> = good) =>
  JSON.parse(await generateInvoiceAction(CONTRACT, input, auth, actor)) as Record<string, any>;
const generated = () => ({ generated: true, invoiceId: INVOICE, actor: genActor, priceBookGaps: [], overages: [] });

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0; h.order.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.getContract.mockResolvedValue({});
  h.requireSite.mockResolvedValue(undefined);
  h.lock.mockImplementation(async () => { h.order.push('lock'); });
  h.preview.mockImplementation(async () => { h.order.push('preview'); return duePreview(); });
  h.generate.mockResolvedValue(generated());
  h.issue.mockResolvedValue(undefined);
  h.send.mockResolvedValue({ emailed: true });
  // invoice total read after generate, the draft re-check before issue, then after issue
  h.rows.push([{ total: '100.00' }], [{ total: '100.00' }], [{ total: '100.00' }]);
});

const nothingRan = () => {
  for (const fn of [h.getContract, h.lock, h.preview, h.generate, h.issue, h.send]) expect(fn).not.toHaveBeenCalled();
};

describe('generateInvoiceAction assertions', () => {
  it('refuses a device-bound or site-ceiling session before any gate or generate', async () => {
    for (const over of [{ scope: 'organization', allowedSiteIds: ['s1'] }, { allowedDeviceIds: ['d1'] }]) {
      const body = JSON.parse(await generateInvoiceAction(CONTRACT, good, { ...auth, ...over } as AuthContext, actor));
      expect(body.code).toBe('ACCESS_DENIED');
    }
    nothingRan();
  });

  it.each([
    ['missing periodStart', { ...good, periodStart: undefined }],
    ['bad date', { ...good, periodStart: '02/01/2026' }],
    ['bad amount', { ...good, expectedTotal: '100.001' }],
    ['non-boolean autoIssue', { ...good, autoIssue: 'true' }],
    ['non-array recipients', { ...good, expectedRecipients: 'a@b.test' }],
    ['non-string recipient', { ...good, expectedRecipients: [1] }],
  ])('%s is a VALIDATION_ERROR and nothing is gated or generated', async (_n, input) => {
    expect((await gen(input as Record<string, unknown>)).code).toBe('VALIDATION_ERROR');
    nothingRan();
  });

  it.each([
    ['periodStart', { periodStart: '2026-03-01' }],
    ['expectedTotal', { expectedTotal: '100.01' }],
    ['autoIssue', { autoIssue: false }],
    ['expectedRecipients', { expectedRecipients: ['other@example.test'] }],
  ])('a %s mismatch is PREVIEW_MISMATCH and nothing is generated', async (field, override) => {
    const out = await gen({ ...good, ...override });
    expect(out.code).toBe('PREVIEW_MISMATCH');
    expect(out.mismatched).toEqual([field]);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
  });

  it('locks the contract row before computing the preview, inside the system transaction', async () => {
    await gen();
    expect(h.order.slice(0, 2)).toEqual(['lock', 'preview']);
    expect(h.getContract).toHaveBeenCalled();
  });

  it('a blocked preview returns its code and does not generate', async () => {
    h.preview.mockResolvedValue(duePreview({ blocked: { code: 'HOUR_BLOCK_NOT_SUPPORTED', contractLineId: 'hb' } }));
    expect((await gen()).code).toBe('HOUR_BLOCK_NOT_SUPPORTED');
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('a not-due preview is generated:false', async () => {
    h.preview.mockResolvedValue({ due: false, contractId: CONTRACT, orgId: 'org-1', reason: 'not_due', nextBillingAt: null });
    expect(await gen()).toEqual({ generated: false, skipped: 'not_due' });
    expect(h.generate).not.toHaveBeenCalled();
  });
});

describe('generateInvoiceAction post-commit', () => {
  it('autoIssue false leaves a draft and never issues', async () => {
    h.preview.mockResolvedValue(duePreview({ autoIssue: false, recipients: [] }));
    const out = await gen({ ...good, autoIssue: false, expectedRecipients: [] });
    expect(out).toMatchObject({ generated: true, status: 'draft' });
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('issues then emails exactly the normalized approved recipients', async () => {
    h.preview.mockResolvedValue(duePreview({ recipients: ['b@example.test', 'A@Example.test'] }));
    const out = await gen({ ...good, expectedRecipients: ['b@example.test', ' A@Example.test', 'a@example.test'] });
    expect(h.issue).toHaveBeenCalledWith(INVOICE, genActor);
    expect(h.send).toHaveBeenCalledWith(INVOICE, genActor, { to: ['a@example.test', 'b@example.test'] });
    expect(h.issue.mock.invocationCallOrder[0]!).toBeLessThan(h.send.mock.invocationCallOrder[0]!);
    expect(out).toMatchObject({ status: 'issued', emailSent: true });
  });

  it('withholds auto-issue when the generated total differs from the approved one', async () => {
    h.rows.length = 0;
    h.rows.push([{ total: '120.00' }]);
    const out = await gen();
    expect(out).toMatchObject({ status: 'draft', autoIssueWithheld: 'total_changed' });
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('withholds the email when the issued total differs', async () => {
    h.rows.length = 0;
    h.rows.push([{ total: '100.00' }], [{ total: '100.00' }], [{ total: '130.00' }]);
    const out = await gen();
    expect(h.issue).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: 'issued', emailWithheld: 'total_changed', total: '130.00' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('sends nothing when the approved recipient list is empty', async () => {
    h.preview.mockResolvedValue(duePreview({ recipients: [] }));
    const out = await gen({ ...good, expectedRecipients: [] });
    expect(h.issue).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ status: 'issued', emailWithheld: 'no_approved_recipients' });
    expect(h.send).not.toHaveBeenCalled();
  });

  it('a draft whose total changed before issue is withheld and never issued', async () => {
    h.rows.length = 0;
    h.rows.push([{ total: '100.00' }], [{ total: '140.00' }]);
    const out = await gen();
    expect(out).toMatchObject({ status: 'draft', autoIssueWithheld: 'total_changed' });
    expect(h.issue).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('issueInvoice throwing INVALID_STATE leaves a draft, failedStep issue, emailSent false', async () => {
    h.issue.mockRejectedValue(Object.assign(new Error('not a draft'), { code: 'INVALID_STATE' }));
    const out = await gen();
    expect(out).toMatchObject({ generated: true, status: 'draft', failedStep: 'issue', errorCode: 'INVALID_STATE', emailSent: false });
    expect(out).not.toHaveProperty('issueOrSendFailed');
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('an uncoded issue failure reports INTERNAL_ERROR', async () => {
    h.issue.mockRejectedValue(new Error('pdf exploded'));
    const out = await gen();
    expect(out).toMatchObject({ status: 'draft', failedStep: 'issue', errorCode: 'INTERNAL_ERROR', emailSent: false });
  });

  it('sendInvoiceEmail throwing after the issue reports issued, failedStep email, emailSent null', async () => {
    h.send.mockRejectedValue(new Error('smtp down'));
    const out = await gen();
    expect(h.issue).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ generated: true, status: 'issued', failedStep: 'email', errorCode: 'INTERNAL_ERROR', emailSent: null });
    expect(out.emailSent).toBeNull();
    expect(h.capture).toHaveBeenCalledTimes(1);
  });

  it('a generator that skips after a due preview is generated:false with skipped, warned and captured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.generate.mockResolvedValue({ generated: false, skipped: 'not_due', priceBookGaps: [], overages: [] });
    const out = await gen();
    expect(out).toEqual({ generated: false, skipped: 'not_due' });
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(h.issue).not.toHaveBeenCalled();
  });
});

describe('previewInvoiceAction', () => {
  it('runs getContract and the site check before previewing, and offers generateWith only when not blocked', async () => {
    const calls: string[] = [];
    h.getContract.mockImplementation(async () => { calls.push('getContract'); });
    h.requireSite.mockImplementation(async () => { calls.push('site'); });
    h.preview.mockImplementation(async () => { calls.push('preview'); return duePreview(); });
    const out = JSON.parse(await previewInvoiceAction(CONTRACT, actor));
    expect(calls).toEqual(['getContract', 'site', 'preview']);
    expect(out.generateWith).toEqual({
      periodStart: '2026-02-01', expectedTotal: '100.00', autoIssue: true, expectedRecipients: ['ap@example.test'],
    });

    h.preview.mockResolvedValue(duePreview({ blocked: { code: 'LINE_UNRESOLVED', contractLineId: 'l', reason: 'x' } }));
    const blocked = JSON.parse(await previewInvoiceAction(CONTRACT, actor));
    expect(blocked.blocked.code).toBe('LINE_UNRESOLVED');
    expect(blocked).not.toHaveProperty('generateWith');
  });

  it('does not preview when the gate refuses', async () => {
    h.getContract.mockRejectedValue(new Error('forbidden'));
    await expect(previewInvoiceAction(CONTRACT, actor)).rejects.toThrow('forbidden');
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('presentPreview of a not-due preview carries no lines or generateWith', () => {
    const out = presentPreview({ due: false, contractId: CONTRACT, orgId: 'o', reason: 'expired', nextBillingAt: null });
    expect(out).toEqual({ contractId: CONTRACT, due: false, reason: 'expired', nextBillingAt: null });
  });
});
