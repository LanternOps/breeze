import { describe, it, expect } from 'vitest';
import { getAcceptanceProvider } from './acceptanceProvider';

describe('TypedSignatureProvider', () => {
  it('captures a typed signature with method=typed-signature', async () => {
    const p = getAcceptanceProvider();
    expect(p.kind).toBe('builtin');
    const r = await p.capture({ quoteId: 'q1', signerName: '  Jane Buyer ', signerEmail: 'jane@x.com', ipAddress: '1.2.3.4', userAgent: 'UA', acceptanceTokenJti: 'jti1' });
    expect(r).toEqual({ signerName: 'Jane Buyer', signerEmail: 'jane@x.com', method: 'typed-signature' });
  });
  it('rejects an empty typed name', async () => {
    const p = getAcceptanceProvider();
    await expect(p.capture({ quoteId: 'q1', signerName: '   ' })).rejects.toThrow();
  });
  it('normalizes a missing email to null', async () => {
    const r = await getAcceptanceProvider().capture({ quoteId: 'q1', signerName: 'Bob' });
    expect(r.signerEmail).toBeNull();
  });
});
