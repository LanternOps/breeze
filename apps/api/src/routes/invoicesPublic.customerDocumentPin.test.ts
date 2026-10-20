/**
 * #9402 W1b characterization pin for GET /invoices/public/:token. The DB is a
 * table-keyed stand-in (`__tests__/helpers/tableKeyedDb.ts`), so this pin survives
 * changes to which queries run and in what order; the serialization boundaries
 * (`toCustomerInvoiceHeader`, `toCustomerInvoiceLine`) are REAL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { state } = vi.hoisted(() => ({ state: { db: null as null | import('../__tests__/helpers/tableKeyedDb').TableKeyedDb } }));
vi.mock('../db', async () => {
  const { createTableKeyedDb } = await import('../__tests__/helpers/tableKeyedDb');
  const { pinRowsByTable } = await import('./__fixtures__/customerInvoicePin');
  state.db = createTableKeyedDb(pinRowsByTable);
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));
vi.mock('../services/invoiceLinkToken', () => ({
  resolveInvoiceByLinkToken: resolveMock,
  getOrMintInvoiceLink: vi.fn(),
  buildPublicInvoiceUrl: (t: string) => `https://portal.example.test/portal/invoice/${t}`,
}));
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return { ...actual, resolveOrgLinkGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN) };
});
const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../services/invoiceService', async (importActual) => ({
  ...(await importActual<typeof import('../services/invoiceService')>()),
  markViewed: markViewedMock,
}));
vi.mock('../services/partnerStripe', async (importActual) => ({
  ...(await importActual<typeof import('../services/partnerStripe')>()),
  isPartnerOnlinePaymentAvailable: vi.fn(async () => true),
}));
vi.mock('../services/autopay/customerInvoiceStatus', () => ({ getCustomerInvoiceAutopay: vi.fn(async () => ({ enrolled: false, status: null })) }));
vi.mock('../services/autopay/reservation', async (importActual) => ({
  ...(await importActual<typeof import('../services/autopay/reservation')>()),
  readInFlightCollection: vi.fn(async () => ({ inProgress: false, amount: '0.00' })),
}));
vi.mock('../services/autopay/payAndSave', async (importActual) => ({
  ...(await importActual<typeof import('../services/autopay/payAndSave')>()),
  getInvoiceAutopayOffer: vi.fn(async () => null),
}));
vi.mock('../services/autopay/bankPayment', async (importActual) => ({
  ...(await importActual<typeof import('../services/autopay/bankPayment')>()),
  getBankAutopayOffer: vi.fn(async () => null),
}));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
const { assembleSpy } = vi.hoisted(() => ({ assembleSpy: vi.fn() }));
vi.mock('../services/customerDocument', async (importActual) => {
  const actual = await importActual<typeof import('../services/customerDocument')>();
  return {
    ...actual,
    assembleCustomerInvoiceDocument: (...args: Parameters<typeof actual.assembleCustomerInvoiceDocument>) => {
      assembleSpy(...args);
      return actual.assembleCustomerInvoiceDocument(...args);
    },
  };
});

import { invoicesPublicRoutes } from './invoicesPublic';
import { PIN_INVOICE_ROW, PIN_PUBLIC_TOKEN, PIN_VISIBLE_LINE_IDS } from './__fixtures__/customerInvoicePin';
import { stripAdditive } from '../__tests__/helpers/stripAdditive';

// The ONLY keys the assembler refactor may add to this response (#9402 W1b).
const PUBLIC_ADDITIVE = ['data.invoice.displayStatus', 'data.lines[].id', 'data.documentLocale'] as const;

function app() {
  const a = new Hono();
  a.route('/invoices/public', invoicesPublicRoutes);
  return a;
}

beforeEach(() => {
  markViewedMock.mockReset();
  resolveMock.mockReset();
  assembleSpy.mockReset();
});

// Recorded at origin/main 5dfeddf233 before customerDocument.ts existed.
// Task 11 may only ADD the declared keys.
const PIN = {
  "data": {
    "invoice": {
      "id": "11111111-1111-4111-8111-111111111111",
      "invoiceNumber": "INV-0042",
      "status": "sent",
      "currencyCode": "USD",
      "issueDate": "2026-03-01",
      "dueDate": "2026-03-31",
      "subtotal": "300.00",
      "taxRate": "0.0825",
      "taxTotal": "12.38",
      "total": "312.38",
      "amountPaid": "0.00",
      "balance": "312.38",
      "depositDue": null,
      "billToName": "Acme Dental",
      "notes": "Thank you for your business.",
      "sellerSnapshot": {
        "name": "Example MSP",
        "address": {
          "line1": "100 Example Way",
          "line2": null,
          "city": "Springfield",
          "region": "IL",
          "postalCode": "62701",
          "country": "US"
        },
        "phone": "+1 555 0100",
        "email": "billing@example-msp.test",
        "website": "https://example-msp.test"
      },
      "termsAndConditions": "Payment due within 30 days.",
      "lineGrouping": "entry",
      "paidAt": null
    },
    "collectionInProgress": null,
    "autopayStatus": null,
    "autopayEnrolled": false,
    "lines": [
      {
        "ticketNumber": "42",
        "ticketCategory": "Support",
        "name": "Toner replacement",
        "description": "Replaced the toner cartridge",
        "quantity": "1",
        "unitPrice": "150.00",
        "taxable": true,
        "lineTotal": "150.00",
        "workedMinutes": null,
        "workDate": null
      },
      {
        "ticketNumber": "42",
        "ticketCategory": "Support",
        "name": null,
        "description": "Diagnosed the print spooler",
        "quantity": "1.50",
        "unitPrice": "100.00",
        "taxable": false,
        "lineTotal": "150.00",
        "workedMinutes": 75,
        "workDate": "2026-02-26"
      }
    ],
    "chargeNow": {
      "amount": "312.38",
      "isDeposit": false
    },
    "payable": true,
    "autopay": null,
    "bankAutopay": null,
    "branding": {
      "partnerName": "Example MSP",
      "contactEmail": "billing@example-msp.test",
      "logoUrl": "https://cdn.example-msp.test/logo.png",
      "primaryColor": "#1d4ed8",
      "theme": "condensed",
      "pageSize": "a4"
    }
  }
};
const VOID_PIN = {
  "data": {
    "invoice": {
      "id": "11111111-1111-4111-8111-111111111111",
      "invoiceNumber": "INV-0042",
      "status": "void",
      "replaced": false
    },
    "lines": [],
    "chargeNow": null,
    "payable": false,
    "branding": {
      "partnerName": "Example MSP",
      "contactEmail": "billing@example-msp.test",
      "logoUrl": "https://cdn.example-msp.test/logo.png",
      "primaryColor": "#1d4ed8",
      "theme": "condensed",
      "pageSize": "a4"
    }
  }
};

describe('GET /invoices/public/:token — characterization pin (#9402)', () => {
  it('an issued invoice', async () => {
    resolveMock.mockResolvedValue({ ...PIN_INVOICE_ROW });
    const res = await app().request(`/invoices/public/${PIN_PUBLIC_TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The public route wraps its body in { data }.
    expect(stripAdditive(body, PUBLIC_ADDITIVE)).toEqual(PIN);
    expect(body.data.documentLocale).toBe('en');
    expect(body.data.invoice.displayStatus).toBe(PIN.data.invoice.status);
    expect(body.data.lines.map((l: { id: string }) => l.id)).toEqual(PIN_VISIBLE_LINE_IDS);
    expect(assembleSpy).toHaveBeenCalledTimes(1);
    expect(assembleSpy.mock.calls[0]![1]).toBe('public');
    expect(markViewedMock).toHaveBeenCalledTimes(1);
  });

  it('a void invoice (the no-amounts state) never reaches the assembler', async () => {
    resolveMock.mockResolvedValue({ ...PIN_INVOICE_ROW, status: 'void' });
    const res = await app().request(`/invoices/public/${PIN_PUBLIC_TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VOID_PIN);
    expect(assembleSpy).not.toHaveBeenCalled();
  });
});
