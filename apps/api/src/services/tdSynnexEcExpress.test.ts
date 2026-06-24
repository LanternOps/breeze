import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
    },
    encryptSecret: vi.fn((value: string) => `enc(${value})`),
    decryptForColumn: vi.fn((_table: string, _column: string, value: string | null | undefined) =>
      value?.startsWith('enc(') ? value.slice(4, -1) : (value ?? null)
    ),
  };
});

vi.mock('../db', () => ({ db: mocks.db }));
vi.mock('./secretCrypto', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptForColumn: mocks.decryptForColumn,
}));

import {
  getEcExpressStatus,
  saveEcExpressConfig,
  EC_MASKED_SECRET,
  TdSynnexEcExpressError,
  endpointForRegion,
  decryptCredentials,
} from './tdSynnexEcExpress';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function insertChain(returningRows: unknown[]) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
}

const fullRow = {
  id: 'integration-1',
  partnerId: actor.partnerId,
  region: 'US',
  enabled: true,
  credentials: { email: 'enc(a@b.co)', password: 'enc(pw)', customerNo: 'enc(123)' },
  settings: { defaultWarehouse: 'ANY', hideZeroInv: false },
  lastTestStatus: null,
  lastTestAt: null,
  lastTestError: null,
  createdBy: actor.userId,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('tdSynnexEcExpress service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getEcExpressStatus', () => {
    it('masks secrets in status output when all three credentials are set', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([fullRow]));

      const status = await getEcExpressStatus(actor);

      expect(status.configured).toBe(true);
      expect(status.credentials).toEqual({
        email: EC_MASKED_SECRET,
        password: EC_MASKED_SECRET,
        customerNo: EC_MASKED_SECRET,
      });
    });

    it('returns configured=false when no row exists', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([]));

      const status = await getEcExpressStatus(actor);

      expect(status.configured).toBe(false);
      expect(status.enabled).toBe(false);
    });

    it('returns configured=false when any credential is missing', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{
        ...fullRow,
        credentials: { email: 'enc(a@b.co)', password: 'enc(pw)' }, // missing customerNo
      }]));

      const status = await getEcExpressStatus(actor);

      expect(status.configured).toBe(false);
    });

    it('never emits stored ciphertext or plaintext in masked status', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{
        ...fullRow,
        credentials: { email: 'enc(secret@example.com)', password: 'enc(supersecret)', customerNo: 'enc(123456)' },
      }]));

      const status = await getEcExpressStatus(actor);
      const serialized = JSON.stringify(status);

      expect(serialized).not.toContain('supersecret');
      expect(serialized).not.toContain('secret@example.com');
      expect(serialized).not.toContain('enc(');
    });

    it('rejects partner-less actors before touching the database', async () => {
      await expect(getEcExpressStatus({ ...actor, partnerId: null }))
        .rejects.toMatchObject({ code: 'EC_PARTNER_REQUIRED', status: 400 });
      expect(mocks.db.select).not.toHaveBeenCalled();
    });
  });

  describe('saveEcExpressConfig', () => {
    it('ignores the masked sentinel on save (preserves existing encrypted secret)', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{
        credentials: { email: 'enc(orig@b.co)', password: 'enc(origpw)', customerNo: 'enc(orig123)' },
        settings: {},
      }]));
      mocks.db.insert.mockReturnValueOnce(insertChain([fullRow]));

      await saveEcExpressConfig({
        region: 'US',
        enabled: true,
        credentials: {
          email: EC_MASKED_SECRET,
          password: EC_MASKED_SECRET,
          customerNo: EC_MASKED_SECRET,
        },
      }, actor);

      const insert = mocks.db.insert.mock.results[0]!.value;
      const values = insert.values.mock.calls[0]![0];
      // Sentinel must not be re-encrypted — original encrypted values preserved
      expect(values.credentials).toEqual({
        email: 'enc(orig@b.co)',
        password: 'enc(origpw)',
        customerNo: 'enc(orig123)',
      });
      expect(mocks.encryptSecret).not.toHaveBeenCalledWith(EC_MASKED_SECRET);
    });

    it('encrypts freshly submitted credentials (trimmed)', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{ credentials: {}, settings: {} }]));
      mocks.db.insert.mockReturnValueOnce(insertChain([fullRow]));

      await saveEcExpressConfig({
        region: 'US',
        enabled: true,
        credentials: { email: '  user@example.com  ', password: '  secret  ', customerNo: '  CUST123  ' },
      }, actor);

      const insert = mocks.db.insert.mock.results[0]!.value;
      const values = insert.values.mock.calls[0]![0];
      expect(values.credentials.email).toBe('enc(user@example.com)');
      expect(values.credentials.password).toBe('enc(secret)');
      expect(values.credentials.customerNo).toBe('enc(CUST123)');
      expect(mocks.encryptSecret).toHaveBeenCalledWith('user@example.com');
      expect(mocks.encryptSecret).toHaveBeenCalledWith('secret');
      expect(mocks.encryptSecret).toHaveBeenCalledWith('CUST123');
    });

    it('clears existing encrypted credential when blank or null value is submitted', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{
        credentials: { email: 'enc(a@b.co)', password: 'enc(pw)', customerNo: 'enc(123)' },
        settings: {},
      }]));
      mocks.db.insert.mockReturnValueOnce(insertChain([{ ...fullRow, credentials: {} }]));

      await saveEcExpressConfig({
        region: 'US',
        enabled: true,
        credentials: { email: '', password: null, customerNo: null },
      }, actor);

      const insert = mocks.db.insert.mock.results[0]!.value;
      const values = insert.values.mock.calls[0]![0];
      expect(values.credentials).toEqual({});
    });

    it('returns masked status after save', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([{ credentials: {}, settings: {} }]));
      mocks.db.insert.mockReturnValueOnce(insertChain([fullRow]));

      const result = await saveEcExpressConfig({
        region: 'US',
        enabled: true,
        credentials: { email: 'a@b.co', password: 'pw', customerNo: '123' },
      }, actor);

      expect(result.credentials).toEqual({
        email: EC_MASKED_SECRET,
        password: EC_MASKED_SECRET,
        customerNo: EC_MASKED_SECRET,
      });
    });

    it('rejects unsupported regions', async () => {
      await expect(saveEcExpressConfig({ region: 'INVALID', enabled: true }, actor))
        .rejects.toMatchObject({ code: 'EC_UNSUPPORTED_REGION', status: 400 });
    });

    it('rejects partner-less actors before touching the database', async () => {
      await expect(saveEcExpressConfig({ region: 'US', enabled: true }, { ...actor, partnerId: null }))
        .rejects.toMatchObject({ code: 'EC_PARTNER_REQUIRED', status: 400 });
      expect(mocks.db.select).not.toHaveBeenCalled();
    });
  });

  describe('endpointForRegion', () => {
    it('returns the US endpoint URL for region US', () => {
      const url = endpointForRegion('US');
      expect(url).toMatch(/^https:\/\//);
      expect(url).toContain('synnex');
    });

    it('throws EC_UNSUPPORTED_REGION for unknown regions', () => {
      expect(() => endpointForRegion('XX'))
        .toThrow(expect.objectContaining({ code: 'EC_UNSUPPORTED_REGION', status: 400 }));
    });
  });

  describe('decryptCredentials', () => {
    it('decrypts all three credential fields from an encrypted row', () => {
      const row = {
        ...fullRow,
        credentials: { email: 'enc(a@b.co)', password: 'enc(pw)', customerNo: 'enc(123)' },
      };

      const result = decryptCredentials(row);

      expect(result).toEqual({ email: 'a@b.co', password: 'pw', customerNo: '123' });
    });

    it('throws EC_CREDENTIALS_INVALID when any credential is missing', () => {
      const row = { ...fullRow, credentials: { email: 'enc(a@b.co)', password: 'enc(pw)' } }; // missing customerNo

      expect(() => decryptCredentials(row))
        .toThrow(expect.objectContaining({ code: 'EC_CREDENTIALS_INVALID' }));
    });

    it('throws EC_CREDENTIALS_INVALID when a credential is a non-string (corrupt JSONB)', () => {
      const row = { ...fullRow, credentials: { email: 123, password: 'enc(pw)', customerNo: 'enc(123)' } };

      expect(() => decryptCredentials(row as Parameters<typeof decryptCredentials>[0]))
        .toThrow(expect.objectContaining({ code: 'EC_CREDENTIALS_INVALID' }));
    });
  });

  describe('TdSynnexEcExpressError', () => {
    it('carries the correct HTTP status for each error code', () => {
      expect(new TdSynnexEcExpressError('', 'EC_PARTNER_REQUIRED').status).toBe(400);
      expect(new TdSynnexEcExpressError('', 'EC_NOT_CONFIGURED').status).toBe(404);
      expect(new TdSynnexEcExpressError('', 'EC_AUTH_FAILED').status).toBe(401);
      expect(new TdSynnexEcExpressError('', 'EC_PROVIDER_ERROR').status).toBe(502);
      expect(new TdSynnexEcExpressError('', 'EC_DUPLICATE_SKU').status).toBe(409);
    });

    it('defaults to EC_PROVIDER_ERROR when no code is given', () => {
      const err = new TdSynnexEcExpressError('something failed');
      expect(err.code).toBe('EC_PROVIDER_ERROR');
      expect(err.status).toBe(502);
    });
  });
});
