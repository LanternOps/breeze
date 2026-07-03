import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    },
    encryptSecret: vi.fn((value: string) => `enc(${value})`),
    decryptForColumn: vi.fn((_table: string, _column: string, value: string | null | undefined) =>
      value?.startsWith('enc(') ? value.slice(4, -1) : (value ?? null)
    ),
    safeFetch: vi.fn(),
    // #2190 — pass-through wrapper; kept as a vi.fn (not an inline arrow) so
    // tests can assert call ORDER relative to enrichDistributorListing below.
    withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  };
});

const enrichMocks = vi.hoisted(() => ({ enrichDistributorListing: vi.fn() }));

vi.mock('../db', () => ({
  db: mocks.db,
  withDbAccessContext: mocks.withDbAccessContext,
}));
vi.mock('./secretCrypto', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptForColumn: mocks.decryptForColumn,
}));
vi.mock('./urlSafety', () => ({ safeFetch: (...args: unknown[]) => mocks.safeFetch(...args) }));
vi.mock('./catalogEnrichmentService', () => ({ enrichDistributorListing: enrichMocks.enrichDistributorListing }));

import {
  getEcExpressStatus,
  saveEcExpressConfig,
  EC_MASKED_SECRET,
  TdSynnexEcExpressError,
  endpointForRegion,
  decryptCredentials,
  buildSoapEnvelope,
  parsePnaResponse,
  importEcExpressCatalogItem,
  testEcExpressConnection,
  lookupEcExpressProducts,
  redactProviderError,
} from './tdSynnexEcExpress';
import { createCatalogItem } from './catalogService';

vi.mock('./catalogService', () => ({
  createCatalogItem: vi.fn(),
}));

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
// #2190 — the request-scoped DbAccessContext the route rebuilds from `auth` and
// passes into the import function alongside `actor`.
const dbCtx = { scope: 'partner' as const, orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['p1'], userId: 'u1', currentPartnerId: 'p1' };

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

function updateChain(returningRows: unknown[]) {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
}

function xmlResponse(xml: string): Response {
  return { text: vi.fn().mockResolvedValue(xml) } as unknown as Response;
}

const PA_NOTFOUND_XML =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return>'
  + '<priceAvail><synnexSku>1</synnexSku><status>NOTFOUND</status></priceAvail>'
  + '</return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>';

const PA_LOGIN_FAILED_XML =
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
  + '<soap:Fault><faultcode>soap:000000</faultcode><faultstring>user login failed</faultstring></soap:Fault>'
  + '</soap:Body></soap:Envelope>';

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

    it('rejects unsupported regions (defense-in-depth past the route enum)', async () => {
      // The route validates region against the enum, but the service keeps its own
      // guard. Cast past the typed input to exercise it.
      await expect(saveEcExpressConfig({ region: 'INVALID' as never, enabled: true }, actor))
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

  describe('testEcExpressConnection', () => {
    it('returns masked status with lastTestStatus "success" on a non-fault PA response', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([fullRow]));
      mocks.safeFetch.mockResolvedValueOnce(xmlResponse(PA_NOTFOUND_XML));
      const updateChainMock = updateChain([{ ...fullRow, lastTestStatus: 'success', lastTestError: null }]);
      mocks.db.update.mockReturnValueOnce(updateChainMock);

      const result = await testEcExpressConnection(actor);

      expect(result.lastTestStatus).toBe('success');
      expect(result.lastTestError).toBeNull();
      // masked-status contract: credentials are present-but-masked, not blanked
      expect(result.credentials).toEqual({
        email: EC_MASKED_SECRET,
        password: EC_MASKED_SECRET,
        customerNo: EC_MASKED_SECRET,
      });
      const setArg = updateChainMock.set.mock.calls[0]![0];
      expect(setArg.lastTestStatus).toBe('success');
    });

    it('persists lastTestStatus "failed" then re-throws on an EC_AUTH_FAILED fault', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([fullRow]));
      mocks.safeFetch.mockResolvedValueOnce(xmlResponse(PA_LOGIN_FAILED_XML));
      const updateChainMock = updateChain([]);
      mocks.db.update.mockReturnValueOnce(updateChainMock);

      await expect(testEcExpressConnection(actor))
        .rejects.toMatchObject({ code: 'EC_AUTH_FAILED', status: 422 });

      const setArg = updateChainMock.set.mock.calls[0]![0];
      expect(setArg.lastTestStatus).toBe('failed');
      // Generic auth message — never echoes provider auth text.
      expect(setArg.lastTestError).toBe('TD SYNNEX authentication failed');
    });

    it('throws EC_NOT_CONFIGURED when no integration row exists', async () => {
      mocks.db.select.mockReturnValueOnce(selectChain([]));

      await expect(testEcExpressConnection(actor))
        .rejects.toMatchObject({ code: 'EC_NOT_CONFIGURED', status: 404 });
      expect(mocks.safeFetch).not.toHaveBeenCalled();
    });
  });

  describe('TdSynnexEcExpressError', () => {
    it('carries the correct HTTP status for each error code', () => {
      expect(new TdSynnexEcExpressError('', 'EC_PARTNER_REQUIRED').status).toBe(400);
      expect(new TdSynnexEcExpressError('', 'EC_NOT_CONFIGURED').status).toBe(404);
      expect(new TdSynnexEcExpressError('', 'EC_AUTH_FAILED').status).toBe(422);
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
    [{ kind: 'sku', synnexSku: '8938995' }], { defaultWarehouse: 'ANY', hideZeroInv: false });
  expect(xml).toContain('<wsse:Username>a@b.co;654906</wsse:Username>');
  expect(xml).toContain('<wsse:Password>p&lt;w&amp;d</wsse:Password>');
  expect(xml).toContain('<synnexSku>8938995</synnexSku>');
  expect(xml).toContain('<warehouse>ANY</warehouse>');
});

it('parses a real multi-SKU PA response into products', () => {
  const xml = readFileSync(join(__dirname, '__fixtures__/ec-express-pna-response.xml'), 'utf8');
  const products = parsePnaResponse(xml);
  expect(products).toHaveLength(2);
  expect(products[0]!).toMatchObject({ synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', cost: 381.35, msrp: 549.99, totalQty: 1437, parcelShippable: 'Y' });
  expect(products[0]!.warehouses).toHaveLength(2);
  expect(products[1]!.discount).toBeNull(); // missing <discount> tolerated
  expect(products[1]!.warehouses).toHaveLength(1); // single <stock> coerced to a one-element array
});

it('maps soap:Fault "user login failed" to EC_AUTH_FAILED with a generic message', () => {
  const fault = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:000000</faultcode><faultstring>user login failed</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  // Provider auth text is never echoed — a generic message is surfaced instead.
  expect(() => parsePnaResponse(fault)).toThrow('TD SYNNEX authentication failed');
  expect(() => parsePnaResponse(fault)).toThrow(
    expect.objectContaining({ code: 'EC_AUTH_FAILED', status: 422 })
  );
});

it('handles single (non-array) priceAvail in response', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>1234567</synnexSku><mfgPartNo>ABC-123</mfgPartNo><status>ACTIVE</status><price>99.99</price><msrp>129.99</msrp><totalQty>5</totalQty></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  const products = parsePnaResponse(xml);
  expect(products).toHaveLength(1);
  expect(products[0]!.synnexSku).toBe('1234567');
  expect(products[0]!.cost).toBe(99.99);
});

it('maps msrp === "0" to null', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>9999999</synnexSku><price>50.00</price><msrp>0</msrp><totalQty>10</totalQty></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  const products = parsePnaResponse(xml);
  expect(products[0]!.msrp).toBeNull();
});

it('imports a product into the catalog with a distributor snapshot', async () => {
  const createSpy = vi.mocked(createCatalogItem).mockResolvedValue({ id: 'item1' } as any);
  const product = { source: 'td_synnex_ec_express' as const, synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', status: 'ACTIVE', name: 'Dell U2724D', description: 'Dell U2724D', currency: 'USD', cost: 381.35, msrp: 549.99, discount: null, totalQty: 1437, warehouses: [], weight: 20.50, parcelShippable: 'Y', raw: {} };
  await importEcExpressCatalogItem({ product, item: { name: 'Dell U2724D', sku: '8938995', unitPrice: 549.99, costBasis: 381.35, taxable: true } }, actor, dbCtx);
  const arg = createSpy.mock.calls[0]![0];
  expect(arg).toMatchObject({ itemType: 'hardware', name: 'Dell U2724D', sku: '8938995', unitPrice: 549.99, costBasis: 381.35 });
  expect((arg.attributes as any).distributor.source).toBe('td_synnex_ec_express');
  expect((arg.attributes as any).distributor.synnexSku).toBe('8938995');
  expect(enrichMocks.enrichDistributorListing).not.toHaveBeenCalled(); // aiCleanup unset → no AI
});

it('web-enriches the listing when aiCleanup is set (clean name + technical description + provenance)', async () => {
  const createSpy = vi.mocked(createCatalogItem).mockResolvedValue({ id: 'item2' } as any);
  enrichMocks.enrichDistributorListing.mockResolvedValueOnce({
    name: 'Dell UltraSharp U2724D 27" QHD Monitor',
    description: '27-inch QHD (2560x1440) IPS, 120Hz, USB-C hub.',
    itemType: 'hardware',
    priceGuidance: 'typically $380–550',
    provenance: { source: 'ai_enrich', model: 'm', query: 'q', suggestion: {}, enrichedAt: 't', enrichedBy: 'u1' },
  });
  const product = { source: 'td_synnex_ec_express' as const, synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', status: 'ACTIVE', name: 'SPL Dell U2724D DISTI', description: null, currency: 'USD', cost: 381.35, msrp: 549.99, discount: null, totalQty: 1, warehouses: [], weight: null, parcelShippable: 'Y', raw: {} };
  await importEcExpressCatalogItem({ product, item: { name: 'SPL Dell U2724D DISTI', sku: '8938995', unitPrice: 549.99, taxable: true }, aiCleanup: true }, actor, dbCtx);

  // Query is anchored on the manufacturer part number for an accurate web lookup.
  const [query, hint] = enrichMocks.enrichDistributorListing.mock.calls.at(-1)!;
  expect(query).toContain('DELL-U2724D');
  expect(hint).toBe('hardware');

  // These tests are top-level (outside the clearAllMocks describe) so calls
  // accumulate — assert on the most recent createCatalogItem call.
  const arg = createSpy.mock.calls.at(-1)![0];
  expect(arg.name).toBe('Dell UltraSharp U2724D 27" QHD Monitor');
  expect(arg.description).toMatch(/QHD/);
  expect((arg.attributes as any).distributor.aiEnriched).toBe(true);
  expect((arg.attributes as any).distributor.aiProvenance.source).toBe('ai_enrich');
  expect((arg.attributes as any).distributor.rawName).toBe('SPL Dell U2724D DISTI');

  // #2190 — enrichDistributorListing must run BEFORE the short DB context that
  // wraps createCatalogItem, so the (potentially 12s) call never runs inside a
  // held transaction.
  const enrichOrder = enrichMocks.enrichDistributorListing.mock.invocationCallOrder.at(-1)!;
  const ctxOrder = mocks.withDbAccessContext.mock.invocationCallOrder.at(-1)!;
  expect(enrichOrder).toBeLessThan(ctxOrder);
});

it('falls back to the raw values when aiCleanup is set but enrichment is unavailable', async () => {
  const createSpy = vi.mocked(createCatalogItem).mockResolvedValue({ id: 'item3' } as any);
  enrichMocks.enrichDistributorListing.mockResolvedValueOnce(null); // rate-limited / down
  const product = { source: 'td_synnex_ec_express' as const, synnexSku: '8938995', mfgPartNo: 'DELL-U2724D', status: 'ACTIVE', name: 'SPL Dell U2724D DISTI', description: 'raw desc', currency: 'USD', cost: 381.35, msrp: 549.99, discount: null, totalQty: 1, warehouses: [], weight: null, parcelShippable: 'Y', raw: {} };
  await importEcExpressCatalogItem({ product, item: { name: 'SPL Dell U2724D DISTI', sku: '8938995', unitPrice: 549.99, taxable: true }, aiCleanup: true }, actor, dbCtx);
  const arg = createSpy.mock.calls.at(-1)![0];
  expect(arg.name).toBe('SPL Dell U2724D DISTI'); // unchanged raw name
  expect((arg.attributes as any).distributor.aiEnriched).toBe(false);
  expect((arg.attributes as any).distributor.aiProvenance).toBeUndefined();
});

it('maps a one-p <parcelShipable> tag to parcelShippable', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><priceAvail><synnexSku>5550000</synnexSku><price>10.00</price><parcelShipable>N</parcelShipable></priceAvail></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  const products = parsePnaResponse(xml);
  expect(products[0]!.parcelShippable).toBe('N');
});

it('maps a generic non-auth soap:Fault to EC_PROVIDER_ERROR', () => {
  const fault = '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>internal server error</faultstring></soap:Fault></soap:Body></soap:Envelope>';
  expect(() => parsePnaResponse(fault)).toThrow(
    expect.objectContaining({ code: 'EC_PROVIDER_ERROR', status: 502 })
  );
});

it('maps a <return><errorMessage> to EC_PROVIDER_ERROR', () => {
  const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return><errorMessage>invalid request</errorMessage></return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>`;
  expect(() => parsePnaResponse(xml)).toThrow(
    expect.objectContaining({ code: 'EC_PROVIDER_ERROR', status: 502 })
  );
});

it('redacts credentials from provider error text', () => {
  const creds = { email: 'buyer@msp.test', password: 'sup3rsecret', customerNo: '654906' };
  const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>request from buyer@msp.test;654906 with sup3rsecret rejected</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
  try {
    parsePnaResponse(fault, creds);
    throw new Error('expected parsePnaResponse to throw');
  } catch (err) {
    const msg = (err as Error).message;
    expect(msg).not.toContain('buyer@msp.test');
    expect(msg).not.toContain('sup3rsecret');
    expect(msg).not.toContain('654906');
    expect(msg).toContain('[redacted]');
  }
});

it('redactProviderError strips the combined username, email, customerNo, and password', () => {
  const out = redactProviderError(
    'auth for a@b.co;123 with pw failed (a@b.co / 123)',
    { email: 'a@b.co', password: 'pw', customerNo: '123' }
  );
  expect(out).not.toContain('a@b.co');
  expect(out).not.toContain('pw');
  expect(out).not.toContain('123');
});

describe('lookupEcExpressProducts', () => {
  beforeEach(() => vi.clearAllMocks());

  function activeRow() {
    return { ...fullRow };
  }

  it('builds a sku-kind lookup for an all-digit query (synnexSku in envelope)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([activeRow()]));
    let sentBody = '';
    mocks.safeFetch.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return xmlResponse(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
        + '<ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return>'
        + '<priceAvail><synnexSku>8938995</synnexSku><status>ACTIVE</status><price>1.00</price></priceAvail>'
        + '</return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>'
      );
    });

    const products = await lookupEcExpressProducts('8938995', actor);
    expect(products).toHaveLength(1);
    expect(sentBody).toContain('<synnexSku>8938995</synnexSku>');
    expect(sentBody).not.toContain('<mfgPartNo>');
  });

  it('builds an mpn-kind lookup for an alphanumeric query (mfgPartNo in envelope)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([activeRow()]));
    let sentBody = '';
    mocks.safeFetch.mockImplementationOnce(async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return xmlResponse(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
        + '<ns2:getPriceAvailabilityResponse xmlns:ns2="http://pnaV05.model.ws.synnex.com/"><return>'
        + '<priceAvail><synnexSku>1</synnexSku><mfgPartNo>DELL-U2724D</mfgPartNo><status>ACTIVE</status><price>1.00</price></priceAvail>'
        + '</return></ns2:getPriceAvailabilityResponse></soap:Body></soap:Envelope>'
      );
    });

    const products = await lookupEcExpressProducts('DELL-U2724D', actor);
    expect(products).toHaveLength(1);
    expect(sentBody).toContain('<mfgPartNo>DELL-U2724D</mfgPartNo>');
    expect(sentBody).not.toContain('<synnexSku>DELL-U2724D</synnexSku>');
  });

  it('throws EC_DISABLED when the integration is configured but disabled', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{ ...fullRow, enabled: false }]));
    await expect(lookupEcExpressProducts('8938995', actor))
      .rejects.toMatchObject({ code: 'EC_DISABLED', status: 400 });
    expect(mocks.safeFetch).not.toHaveBeenCalled();
  });

  it('throws EC_NO_RESULTS when every result is NOTFOUND', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([activeRow()]));
    mocks.safeFetch.mockResolvedValueOnce(xmlResponse(PA_NOTFOUND_XML));
    await expect(lookupEcExpressProducts('8938995', actor))
      .rejects.toMatchObject({ code: 'EC_NO_RESULTS', status: 404 });
  });
});
