import { describe, it, expect, vi, beforeEach } from 'vitest';

// Partner billing master switch on attachAcceptanceEvidence: refused before the
// acceptance lookup, the blob write and the row update.
vi.mock('../db', () => ({ db: { select: vi.fn(), update: vi.fn(), insert: vi.fn(), delete: vi.fn(), transaction: vi.fn() } }));
const putBlob = vi.hoisted(() => vi.fn());
vi.mock('./blobStorage', () => ({ BlobStorageError: class extends Error {}, deleteBlob: vi.fn(), getBlobStream: vi.fn(), putBlob }));
vi.mock('./quoteBillingGate', () => ({ assertQuoteBillingEnabled: vi.fn() }));

import { attachAcceptanceEvidence } from './quoteAcceptanceEvidence';
import { db } from '../db';
import { assertQuoteBillingEnabled } from './quoteBillingGate';
import { QuoteServiceError } from './quoteTypes';

describe('attachAcceptanceEvidence billing master switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('billing off -> 404 BILLING_DISABLED, no lookup, no blob write, no row update', async () => {
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new QuoteServiceError('Not found', 404, 'BILLING_DISABLED'));
    await expect(attachAcceptanceEvidence({
      quoteId: 'q1', orgId: 'org1', actorUserId: 'u1', file: { buffer: Buffer.from('%PDF-1.4'), filename: 'e.pdf' },
    })).rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(db.select).not.toHaveBeenCalled();
    expect(putBlob).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
