/**
 * #9402 W1b characterization pin for GET /portal/invoices/:id. The DB is a
 * table-keyed stand-in (`../__fixtures__/tableKeyedDb.ts`), so this pin survives
 * changes to which queries run and in what order; the invoice service and its
 * serialization boundaries are REAL (only markViewed is stubbed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { state } = vi.hoisted(() => ({
  state: { db: null as null | import('../__fixtures__/tableKeyedDb').TableKeyedDb, invoiceStatus: 'sent' as string },
}));
vi.mock('../../db', async () => {
  const { createTableKeyedDb } = await import('../__fixtures__/tableKeyedDb');
  const { pinRowsByTable } = await import('../__fixtures__/customerInvoicePin');
  state.db = createTableKeyedDb(() => {
    const rows = pinRowsByTable();
    return { ...rows, invoices: rows.invoices!.map((r) => ({ ...r, status: state.invoiceStatus })) };
  });
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../../services/invoiceService', async (importActual) => ({
  ...(await importActual<typeof import('../../services/invoiceService')>()),
  markViewed: markViewedMock,
}));
vi.mock('../../services/partnerStripe', async (importActual) => ({
  ...(await importActual<typeof import('../../services/partnerStripe')>()),
  isPartnerOnlinePaymentAvailable: vi.fn(async () => true),
}));
vi.mock('../../services/autopay/customerInvoiceStatus', () => ({ getCustomerInvoiceAutopay: vi.fn(async () => ({ enrolled: false, status: null })) }));
vi.mock('../../services/autopay/reservation', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/reservation')>()),
  readInFlightCollection: vi.fn(async () => ({ inProgress: false, amount: '0.00' })),
}));
vi.mock('../../services/autopay/payAndSave', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/payAndSave')>()),
  getInvoiceAutopayOffer: vi.fn(async () => null),
}));
vi.mock('../../services/autopay/bankPayment', async (importActual) => ({
  ...(await importActual<typeof import('../../services/autopay/bankPayment')>()),
  getBankAutopayOffer: vi.fn(async () => null),
}));

import { invoiceRoutes as portalInvoiceRoutes } from './invoices';
import { PIN_INVOICE_ID, PIN_ORG_ID } from '../__fixtures__/customerInvoicePin';

function app(orgId = PIN_ORG_ID) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  a.route('/', portalInvoiceRoutes);
  return a;
}

beforeEach(() => {
  markViewedMock.mockReset();
  state.invoiceStatus = 'sent';
});

// Recorded at origin/main 5dfeddf233 before customerDocument.ts existed.
// Task 11 may only ADD the declared keys.
const PIN = {
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
    "lineGrouping": "entry"
  },
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
  "onlinePaymentAvailable": true,
  "collectionInProgress": null,
  "autopayStatus": null,
  "autopayEnrolled": false,
  "autopay": null,
  "bankAutopay": null,
  "branding": {
    "partnerName": "Example MSP",
    "logoUrl": "https://cdn.example-msp.test/logo.png",
    "primaryColor": "#1d4ed8"
  }
};

describe('GET /portal/invoices/:id — characterization pin (#9402)', () => {
  it('an issued invoice', async () => {
    const res = await app().request(`/invoices/${PIN_INVOICE_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PIN);
  });

  it('a draft is a 404 with the shared not-found body', async () => {
    state.invoiceStatus = 'draft';
    const res = await app().request(`/invoices/${PIN_INVOICE_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Invoice not found', code: 'NOT_FOUND' });
  });
});
