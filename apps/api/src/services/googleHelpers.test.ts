import { describe, it, expect, vi } from 'vitest';
import { authorizeGoogleConnection, errorString } from './googleHelpers';

describe('errorString', () => {
  it('produces a stable JSON envelope', () => {
    expect(errorString('x', 'y')).toBe(JSON.stringify({ error: 'x', message: 'y' }));
  });
});

describe('authorizeGoogleConnection', () => {
  it('rejects null', () => {
    expect(authorizeGoogleConnection(null, 'org-A').ok).toBe(false);
  });
  it('rejects a different org', () => {
    const conn = { orgId: 'org-A', status: 'active' } as any;
    expect(authorizeGoogleConnection(conn, 'org-B').ok).toBe(false);
  });
  it('rejects an inactive connection', () => {
    const conn = { orgId: 'org-A', status: 'disabled' } as any;
    expect(authorizeGoogleConnection(conn, 'org-A').ok).toBe(false);
  });
  it('accepts a same-org active connection', () => {
    const conn = { orgId: 'org-A', status: 'active' } as any;
    const out = authorizeGoogleConnection(conn, 'org-A');
    expect(out.ok).toBe(true);
  });
});

describe('decryptConnectionKey', () => {
  it('throws when decryption yields null', async () => {
    vi.resetModules();
    vi.doMock('./secretCrypto', () => ({ decryptForColumn: () => null }));
    const { decryptConnectionKey } = await import('./googleHelpers');
    expect(() => decryptConnectionKey({ serviceAccountKey: 'enc' } as any)).toThrow(/could not be decrypted/);
    vi.doUnmock('./secretCrypto');
  });
});
