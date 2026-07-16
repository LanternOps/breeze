import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  encryptSecret: vi.fn((v: string) => `enc(${v})`),
  decryptForColumn: vi.fn((_t: string, _c: string, v: string | null | undefined) =>
    v?.startsWith('enc(') ? v.slice(4, -1) : (v ?? null)
  ),
  isPrivateIp: vi.fn((_ip: string) => false),
  lookup: vi.fn(async (_host: string, _opts?: unknown) => [{ address: '203.0.113.10' }]),
  sftpConnect: vi.fn(async () => undefined),
  sftpList: vi.fn(async () => [{ name: '123456.zip', size: 1024 }]),
  sftpFastGet: vi.fn(async () => undefined),
  sftpEnd: vi.fn(async () => undefined),
  zipEntries: vi.fn(),
  zipEntryData: vi.fn(),
  zipClose: vi.fn(async () => undefined),
}));

vi.mock('../db', () => ({
  db: mocks.db,
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./secretCrypto', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptForColumn: mocks.decryptForColumn,
}));
vi.mock('./urlSafety', () => ({ isPrivateIp: (ip: string) => mocks.isPrivateIp(ip) }));
vi.mock('node:dns', () => ({ promises: { lookup: mocks.lookup } }));
vi.mock('ssh2-sftp-client', () => ({
  default: class {
    connect = mocks.sftpConnect;
    list = mocks.sftpList;
    fastGet = mocks.sftpFastGet;
    end = mocks.sftpEnd;
  },
}));
vi.mock('node-stream-zip', () => ({
  default: {
    async: class {
      entries = mocks.zipEntries;
      entryData = mocks.zipEntryData;
      close = mocks.zipClose;
    },
  },
}));

import {
  sftpUsername,
  remoteFileName,
  REGION_HOSTS,
  SFTP_MASKED_SECRET,
  TdSynnexSftpError,
  syncSftpPriceFile,
  saveSftpConfig,
  testSftpConnection,
} from './tdSynnexSftpSync';
import { isSelfManagedDbContextRoute } from '../middleware/selfManagedDbContextRoutes';

const SAMPLE_HDR = 'SAMPLE846~HDR~190227~190227~C~~~~~';
const SAMPLE_DTL =
  'SAMPLE846~DTL~C8061ARPC~PCI-C8061ARPC~2558723~A~PCI TONER~PCI~34189~120~0~0~36.62~62.76~0~0~Y~0~Y~0~36.62~0~ ~0~009088334~0~2260~4.15~N~0~~US~35.02~845161022245~44103103~COMPHP~091029~NNY~~A~S~35.02~34.06~35.02~Y~~N~~~LONG1~LONG2~LONG3~15.30~6.60~9.50~0~~~~~0~0~0~0~~~~US         N~0~120';

function apFile(qualifier: 'C' | 'U'): Buffer {
  const hdr = SAMPLE_HDR.replace('~190227~C~', `~190227~${qualifier}~`);
  return Buffer.from(`${hdr}\n${SAMPLE_DTL}\n`, 'latin1');
}

/** Integration row as stored: account number plain, password encrypted. */
const INTEGRATION = {
  id: 'int-1',
  partnerId: 'partner-1',
  region: 'US',
  accountNumber: '123456',
  credentials: { password: 'enc(s3cret)' },
  enabled: true,
};

function stubSelect(row: unknown) {
  mocks.db.select.mockReturnValue({
    from: () => ({ where: () => Promise.resolve(row ? [row] : []) }),
  });
}

function stubWrites() {
  mocks.db.update.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
  const insertedBatches: unknown[][] = [];
  mocks.db.insert.mockReturnValue({
    values: (batch: unknown[]) => {
      insertedBatches.push(batch);
      return { onConflictDoUpdate: () => Promise.resolve([]) };
    },
  });
  const deleteCalls: unknown[] = [];
  mocks.db.delete.mockReturnValue({
    where: (w: unknown) => {
      deleteCalls.push(w);
      return { returning: () => Promise.resolve([{ id: 'stale-1' }]) };
    },
  });
  return { insertedBatches, deleteCalls };
}

beforeEach(() => {
  // clearAllMocks resets calls but NOT implementations, so every stub that any
  // test overrides with mockRejectedValue must be re-primed here — otherwise a
  // rejection leaks into the next test and it fails for the wrong reason.
  vi.clearAllMocks();
  mocks.isPrivateIp.mockReturnValue(false);
  mocks.lookup.mockResolvedValue([{ address: '203.0.113.10' }]);
  mocks.sftpConnect.mockResolvedValue(undefined);
  mocks.sftpFastGet.mockResolvedValue(undefined);
  mocks.sftpEnd.mockResolvedValue(undefined);
  mocks.sftpList.mockResolvedValue([{ name: '123456.zip', size: 1024 }]);
  mocks.zipEntries.mockResolvedValue({ '123456.AP': { name: '123456.AP', size: 2048, isDirectory: false } });
  mocks.zipEntryData.mockResolvedValue(apFile('C'));
  mocks.zipClose.mockResolvedValue(undefined);
});

describe('derived identifiers', () => {
  it("derives the US username as 'u' + account number", () => {
    expect(sftpUsername('US', '123456')).toBe('u123456');
  });

  it("derives the Canada username as 'c' + account number", () => {
    expect(sftpUsername('CA', '123456')).toBe('c123456');
  });

  it('derives the remote filename from the account number', () => {
    expect(remoteFileName('123456')).toBe('123456.zip');
  });

  it('pins the host per region — it is never partner-supplied', () => {
    expect(REGION_HOSTS.US.host).toBe('sftp.us.tdsynnex.com');
    expect(REGION_HOSTS.CA.host).toBe('sftp.ca.tdsynnex.com');
  });
});

describe('syncSftpPriceFile — full vs delta', () => {
  it('upserts rows and PRUNES stale ones after a full file (HDR "C")', async () => {
    stubSelect(INTEGRATION);
    const { insertedBatches, deleteCalls } = stubWrites();
    mocks.zipEntryData.mockResolvedValue(apFile('C'));

    const res = await syncSftpPriceFile('int-1');

    expect(res.isFullFile).toBe(true);
    expect(res.rowsWritten).toBe(1);
    expect(insertedBatches).toHaveLength(1);
    // A full file is an authoritative snapshot: rows absent from it are gone.
    expect(deleteCalls).toHaveLength(1);
    expect(res.rowsPruned).toBe(1);
  });

  it('does NOT prune after a delta file (HDR "U") — pruning would wipe the catalog', async () => {
    stubSelect(INTEGRATION);
    const { insertedBatches, deleteCalls } = stubWrites();
    mocks.zipEntryData.mockResolvedValue(apFile('U'));

    const res = await syncSftpPriceFile('int-1');

    expect(res.isFullFile).toBe(false);
    expect(res.rowsWritten).toBe(1);
    expect(insertedBatches).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0); // the whole point
    expect(res.rowsPruned).toBe(0);
  });

  it('persists every parsed field — manufacturer/UPC/ABC-code were silently dropped before', async () => {
    stubSelect(INTEGRATION);
    const { insertedBatches } = stubWrites();

    await syncSftpPriceFile('int-1');

    const row = (insertedBatches[0] as Array<Record<string, unknown>>)[0]!;
    // These are the searchable/quote-critical fields. manufacturer + upc are what
    // a tech actually searches by; abcCode is what says "this SKU is EOL".
    expect(row.manufacturer).toBe('PCI');            // field 08
    expect(row.upc).toBe('845161022245');            // field 34
    expect(row.unspsc).toBe('44103103');             // field 35
    expect(row.abcCode).toBe('A');                   // field 40
    expect(row.tdPartNo).toBe('PCI-C8061ARPC');      // field 04
    expect(row.costWithoutPromo).toBe('36.62');      // field 21
    expect(row.cost).toBe('36.62');                  // field 13 — the quotable one
  });

  it('downloads the file named after the account number', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    await syncSftpPriceFile('int-1');
    expect(mocks.sftpFastGet).toHaveBeenCalledWith('123456.zip', expect.stringContaining('123456.zip'));
  });

  it('authenticates with the derived username and decrypted password', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    await syncSftpPriceFile('int-1');
    expect(mocks.sftpConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'sftp.us.tdsynnex.com',
        username: 'u123456',
        password: 's3cret',
      })
    );
  });
});

describe('syncSftpPriceFile — failure handling', () => {
  it('refuses to sync a disabled integration', async () => {
    stubSelect({ ...INTEGRATION, enabled: false });
    stubWrites();
    await expect(syncSftpPriceFile('int-1')).rejects.toThrow(/disabled/i);
  });

  it('fails when the file is not on the server yet', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    mocks.sftpList.mockResolvedValue([]); // account provisioned, file not generated yet
    await expect(syncSftpPriceFile('int-1')).rejects.toThrow(TdSynnexSftpError);
    await expect(syncSftpPriceFile('int-1')).rejects.toMatchObject({ code: 'SFTP_FILE_NOT_FOUND' });
  });

  it('maps an auth rejection to SFTP_AUTH_FAILED without echoing provider text', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    mocks.sftpConnect.mockRejectedValue(new Error('All configured authentication methods failed'));
    await expect(syncSftpPriceFile('int-1')).rejects.toMatchObject({ code: 'SFTP_AUTH_FAILED' });
  });

  it('refuses to connect when the host resolves only to private IPs', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    mocks.lookup.mockResolvedValue([{ address: '10.0.0.5' }]);
    mocks.isPrivateIp.mockReturnValue(true);
    await expect(syncSftpPriceFile('int-1')).rejects.toMatchObject({ code: 'SFTP_HOST_BLOCKED' });
    expect(mocks.sftpConnect).not.toHaveBeenCalled();
  });

  it('never writes the password into last_sync_error', async () => {
    stubSelect(INTEGRATION);
    mocks.db.insert.mockReturnValue({ values: () => ({ onConflictDoUpdate: () => Promise.resolve([]) }) });
    mocks.db.delete.mockReturnValue({ where: () => ({ returning: () => Promise.resolve([]) }) });

    const setCalls: Array<Record<string, unknown>> = [];
    mocks.db.update.mockReturnValue({
      set: (v: Record<string, unknown>) => {
        setCalls.push(v);
        return { where: () => Promise.resolve([]) };
      },
    });
    // A transport error that leaks the password in its message.
    mocks.sftpConnect.mockRejectedValue(new Error('connect failed for password s3cret'));

    await expect(syncSftpPriceFile('int-1')).rejects.toThrow();

    const errorWrite = setCalls.find((s) => s.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    const persisted = String(errorWrite!.lastSyncError);
    expect(persisted).not.toContain('s3cret');
    expect(persisted).toContain(SFTP_MASKED_SECRET);
  });
});

describe('testSftpConnection', () => {
  const actor = { partnerId: 'partner-1', userId: 'user-1', scope: 'partner' } as never;
  const ctx = { partnerId: 'partner-1', scope: 'partner' } as never;

  it('must NOT hold a pooled DB connection across the SSH handshake (#1448)', () => {
    // runOutsideDbContext alone does not close the transaction the auth
    // middleware opens, so the route has to opt out of the ambient txn entirely.
    // If this entry is ever dropped, a 30s SFTP timeout pins a PG connection.
    expect(
      isSelfManagedDbContextRoute('POST', '/api/v1/catalog/distributors/td-synnex-sftp/test')
    ).toBe(true);
  });

  it('reports success-but-no-file for a freshly provisioned account', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    mocks.sftpList.mockResolvedValue([]); // authenticates, file not generated yet

    const res = await testSftpConnection(actor, ctx);

    expect(res.success).toBe(true);
    expect(res.fileFound).toBe(false);
    expect(res.message).toMatch(/24 hours/);
  });

  it('reports the file as found once TD SYNNEX has generated it', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    const res = await testSftpConnection(actor, ctx);
    expect(res.success).toBe(true);
    expect(res.fileFound).toBe(true);
  });

  it('reports a failure without leaking the password', async () => {
    stubSelect(INTEGRATION);
    stubWrites();
    mocks.sftpConnect.mockRejectedValue(new Error('boom s3cret'));

    const res = await testSftpConnection(actor, ctx);

    expect(res.success).toBe(false);
    expect(String(res.error)).not.toContain('s3cret');
  });
});

describe('saveSftpConfig', () => {
  const actor = { partnerId: 'partner-1', userId: 'user-1', scope: 'partner' } as never;

  function stubUpsert() {
    const saved: Array<Record<string, unknown>> = [];
    mocks.db.insert.mockReturnValue({
      values: (v: Record<string, unknown>) => {
        saved.push(v);
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ ...INTEGRATION, ...v }]),
          }),
        };
      },
    });
    return saved;
  }

  it('encrypts the password and never returns it in plaintext', async () => {
    stubSelect(undefined);
    const saved = stubUpsert();

    const res = await saveSftpConfig(actor, { region: 'US', accountNumber: '123456', password: 'hunter2' });

    expect((saved[0]!.credentials as Record<string, unknown>).password).toBe('enc(hunter2)');
    expect(res.credentials.password).toBe(SFTP_MASKED_SECRET);
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });

  it('does not overwrite the stored password when the UI echoes the mask back', async () => {
    stubSelect(INTEGRATION);
    const saved = stubUpsert();

    await saveSftpConfig(actor, { accountNumber: '123456', password: SFTP_MASKED_SECRET });

    // Still the ORIGINAL ciphertext, not enc('********').
    expect((saved[0]!.credentials as Record<string, unknown>).password).toBe('enc(s3cret)');
  });

  it('rejects a non-numeric account number (it derives the username and filename)', async () => {
    stubSelect(undefined);
    stubUpsert();
    await expect(saveSftpConfig(actor, { accountNumber: 'u123456' }))
      .rejects.toMatchObject({ code: 'SFTP_CREDENTIALS_INVALID' });
  });

  it('surfaces the derived username and filename so a typo is visible', async () => {
    stubSelect(undefined);
    stubUpsert();
    const res = await saveSftpConfig(actor, { region: 'US', accountNumber: '123456', password: 'x' });
    expect(res.username).toBe('u123456');
    expect(res.remoteFileName).toBe('123456.zip');
    expect(res.host).toBe('sftp.us.tdsynnex.com');
  });
});
