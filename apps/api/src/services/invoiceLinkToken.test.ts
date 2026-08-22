import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// DB mock: select chains resolve queued row sets; update().set().where().returning()
// resolves the queued returning set. Mirrors invoiceResend.test.ts.
const { dbResults, updateReturning, updateSetMock } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  updateReturning: [] as unknown[][],
  updateSetMock: vi.fn(),
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    (chain as { update: unknown }).update = vi.fn(() => ({
      set: (v: unknown) => {
        updateSetMock(v);
        return { where: () => ({ returning: () => Promise.resolve(updateReturning.shift() ?? []) }) };
      },
    }));
    return chain;
  };
  return { db: makeChain() };
});

// Reversible fake crypto so tests can build a "stored" row for the reproduce path.
vi.mock('./secretCrypto', () => ({
  encryptSecret: (value: string | null, opts: { aad?: string } = {}) =>
    value ? `enc[${opts.aad ?? ''}]${value}` : null,
  decryptSecret: (ct: string | null, opts: { aad?: string } = {}) => {
    if (!ct) return null;
    const prefix = `enc[${opts.aad ?? ''}]`;
    if (!ct.startsWith(prefix)) throw new Error('AAD mismatch');
    return ct.slice(prefix.length);
  },
}));
vi.mock('./portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));
const { captureMock } = vi.hoisted(() => ({ captureMock: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: captureMock }));

import {
  getOrMintInvoiceLink, resetInvoiceLink, resolveInvoiceByLinkToken,
  hashInvoiceLinkToken, buildPublicInvoiceUrl,
} from './invoiceLinkToken';
import { columnAad, encryptedColumnRegistry } from './encryptedColumnRegistry';

const INV_ID = '11111111-1111-1111-1111-111111111111';
const CT_SPEC = encryptedColumnRegistry.find((s) => s.table === 'invoices' && s.column === 'public_link_token_ct')!;
const aad = columnAad(CT_SPEC, INV_ID);

const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

function bareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID, dueDate: null,
    publicLinkTokenHash: null, publicLinkTokenCt: null, publicLinkExpiresAt: null,
    ...overrides,
  } as Parameters<typeof getOrMintInvoiceLink>[0];
}

/** A row storing `token` the way the real write path would. */
function storedRow(token: string, overrides: Record<string, unknown> = {}) {
  return bareRow({
    publicLinkTokenHash: sha(token),
    publicLinkTokenCt: `enc[${aad}]${token}`,
    publicLinkExpiresAt: new Date(Date.now() + 100 * 24 * 3600 * 1000),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  updateReturning.length = 0;
});

describe('getOrMintInvoiceLink', () => {
  it('mints a fresh link for a bare row and persists hash + ct + expiry', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const link = await getOrMintInvoiceLink(bareRow());
    expect(link.origin).toBe('minted');
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
    const written = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.publicLinkTokenHash).toBe(sha(link.token));
    expect(written.publicLinkTokenCt).toBe(`enc[${aad}]${link.token}`);
    // ~12 months out (no due date).
    const days = ((written.publicLinkExpiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  it('expiry floors at due date + 180 days when that is later than +12 months', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const farDue = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const link = await getOrMintInvoiceLink(bareRow({ dueDate: farDue }));
    const days = (link.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(570); // 400 + 180, minus rounding
  });

  it('reproduces the stored token byte-for-byte without writing', async () => {
    const token = 'A'.repeat(43);
    const link = await getOrMintInvoiceLink(storedRow(token));
    expect(link).toMatchObject({ token, origin: 'reproduced' });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('mints a replacement when the stored ciphertext is unreadable, and reports it', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const link = await getOrMintInvoiceLink(storedRow('A'.repeat(43), { publicLinkTokenCt: 'enc[wrong-aad]garbage' }));
    expect(link.origin).toBe('minted_unreadable');
    expect(link.token).not.toBe('A'.repeat(43));
    expect(captureMock).toHaveBeenCalled();
  });

  it('mints a replacement when the decrypted token fails the hash cross-check', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const link = await getOrMintInvoiceLink(storedRow('A'.repeat(43), { publicLinkTokenHash: sha('different-token-entirely') }));
    expect(link.origin).toBe('minted_unreadable');
  });

  it('mints a replacement for an expired stored link', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const link = await getOrMintInvoiceLink(
      storedRow('A'.repeat(43), { publicLinkExpiresAt: new Date(Date.now() - 1000) }),
    );
    expect(link.origin).toBe('minted_expired');
    expect(link.token).not.toBe('A'.repeat(43));
  });

  it('loses the mint race gracefully: reproduces the winner token', async () => {
    updateReturning.push([]); // conditional claim matched 0 rows
    const winner = 'B'.repeat(43);
    dbResults.push([storedRow(winner)]); // re-read returns the winner row
    const link = await getOrMintInvoiceLink(bareRow());
    expect(link.token).toBe(winner);
  });

  it('throws loudly when neither mint nor winner-reproduce works', async () => {
    updateReturning.push([]);
    dbResults.push([]); // row vanished
    await expect(getOrMintInvoiceLink(bareRow())).rejects.toThrow(/could not mint or reproduce/);
  });
});

describe('resetInvoiceLink', () => {
  it('unconditionally replaces the link', async () => {
    updateReturning.push([{ id: INV_ID }]);
    const link = await resetInvoiceLink({ id: INV_ID, dueDate: null });
    expect(link.origin).toBe('reset');
    const written = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.publicLinkTokenHash).toBe(sha(link.token));
  });
});

describe('resolveInvoiceByLinkToken', () => {
  const token = 'C'.repeat(43);
  const validRow = () => ({
    id: INV_ID, status: 'sent',
    publicLinkTokenHash: sha(token),
    publicLinkExpiresAt: new Date(Date.now() + 1000 * 3600),
  });

  it('returns the row for a live token', async () => {
    dbResults.push([validRow()]);
    expect(await resolveInvoiceByLinkToken(token)).toMatchObject({ id: INV_ID });
  });

  it('rejects malformed tokens before touching the db', async () => {
    expect(await resolveInvoiceByLinkToken('short')).toBeNull();
    expect(await resolveInvoiceByLinkToken('has spaces and $ymbols'.padEnd(30, 'x'))).toBeNull();
    expect(dbResults.length).toBe(0); // nothing consumed
  });

  it('returns null for an unknown hash', async () => {
    dbResults.push([]);
    expect(await resolveInvoiceByLinkToken(token)).toBeNull();
  });

  it('never resolves a draft', async () => {
    dbResults.push([{ ...validRow(), status: 'draft' }]);
    expect(await resolveInvoiceByLinkToken(token)).toBeNull();
  });

  it('returns null once the persisted expiry passes', async () => {
    dbResults.push([{ ...validRow(), publicLinkExpiresAt: new Date(Date.now() - 1) }]);
    expect(await resolveInvoiceByLinkToken(token)).toBeNull();
  });

  it('returns null when expiry was never stamped', async () => {
    dbResults.push([{ ...validRow(), publicLinkExpiresAt: null }]);
    expect(await resolveInvoiceByLinkToken(token)).toBeNull();
  });
});

describe('url + hash helpers', () => {
  it('buildPublicInvoiceUrl uses the portal base and singular /invoice path', () => {
    expect(buildPublicInvoiceUrl('tok')).toBe('https://portal.example.test/portal/invoice/tok');
  });
  it('hashInvoiceLinkToken is plain sha256 hex', () => {
    expect(hashInvoiceLinkToken('x')).toBe(sha('x'));
  });
});
