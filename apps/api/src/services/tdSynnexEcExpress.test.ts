import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  buildSoapEnvelope,
  parsePnaResponse,
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

it('builds a WS-Security envelope with semicolon-joined username and escaped values', () => {
  const xml = buildSoapEnvelope({ email: 'a@b.co', password: 'p<w&d', customerNo: '654906' },
    [{ kind: 'sku', value: '8938995' }], { defaultWarehouse: 'ANY', hideZeroInv: false });
  expect(xml).toContain('<wsse:Username>a@b.co;654906</wsse:Username>');
  expect(xml).toContain('<wsse:Password>p&lt;w&amp;d</wsse:Password>');
  expect(xml).toContain('<synnexSku>8938995</synnexSku>');
  expect(xml).toContain('<warehouse>ANY</warehouse>');
});

it('parses a real multi-SKU PA response into products', () => {
  const xml = readFileSync(join(__dirname, '__fixtures__/ec-express-pna-response.xml'), 'utf8');
  const products = parsePnaResponse(xml);
  expect(products).toHaveLength(2);
  expect(products[0]!).toMatchObject({ synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', cost: '381.35', msrp: '549.99', totalQty: 1437, parcelShippable: 'Y' });
  expect(products[0]!.warehouses).toHaveLength(2);
  expect(products[1]!.discount).toBeNull(); // missing <discount> tolerated
});

it('maps soap:Fault "user login failed" to EC_AUTH_FAILED', () => {
  const fault = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:000000</faultcode><faultstring>user login failed</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  expect(() => parsePnaResponse(fault)).toThrow(/login failed/i);
});

it('handles single (non-array) priceAvail in response', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>1234567</synnexSku><mfgPartNo>ABC-123</mfgPartNo><status>ACTIVE</status><price>99.99</price><msrp>129.99</msrp><totalQty>5</totalQty></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  const products = parsePnaResponse(xml);
  expect(products).toHaveLength(1);
  expect(products[0]!.synnexSku).toBe('1234567');
  expect(products[0]!.cost).toBe('99.99');
});

it('maps msrp === "0" to null', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>9999999</synnexSku><price>50.00</price><msrp>0</msrp><totalQty>10</totalQty></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  const products = parsePnaResponse(xml);
  expect(products[0]!.msrp).toBeNull();
});
