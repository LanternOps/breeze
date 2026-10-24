import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/contractService', () => ({
  getContract: vi.fn(),
  generateDueInvoice: vi.fn(),
}));
vi.mock('../../services/invoiceService', () => ({ issueInvoice: vi.fn() }));
vi.mock('../../services/invoicePdf', () => ({ sendInvoiceEmail: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
}));
vi.mock('./contracts', () => ({
  contractActorFrom: vi.fn(() => ({ userId: 'u1', partnerId: 'p1', accessibleOrgIds: null })),
  handleContractError: vi.fn((c: any) => c.json({ error: 'boom' }, 500)),
}));

import { contractGenerateRoutes } from './generate';
import { generateDueInvoice, getContract } from '../../services/contractService';
import { issueInvoice } from '../../services/invoiceService';
import { sendInvoiceEmail } from '../../services/invoicePdf';

const ID = '11111111-1111-1111-1111-111111111111';
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['o1'] };

function generate() {
  return contractGenerateRoutes.request(`/${ID}/generate`, { method: 'POST' });
}

describe('POST /contracts/:id/generate response', () => {
  beforeEach(() => { vi.clearAllMocks(); (getContract as any).mockResolvedValue({ id: ID }); });

  it('does not leak the internal actor object', async () => {
    (generateDueInvoice as any).mockResolvedValue({ generated: true, invoiceId: 'inv-1', autoIssue: false, actor });
    const res = await generate();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ generated: true, invoiceId: 'inv-1' });
    expect(body.data).not.toHaveProperty('actor');
    expect(JSON.stringify(body)).not.toContain('accessibleOrgIds');
  });

  it('still uses the actor for auto-issue + email, but strips it from the response', async () => {
    (generateDueInvoice as any).mockResolvedValue({ generated: true, invoiceId: 'inv-1', autoIssue: true, actor });
    const res = await generate();
    const body = await res.json();
    expect(issueInvoice).toHaveBeenCalledWith('inv-1', actor);
    expect(sendInvoiceEmail).toHaveBeenCalledWith('inv-1', actor);
    expect(body.data).toMatchObject({ emailSent: true });
    expect(body.data).not.toHaveProperty('actor');
  });
});
