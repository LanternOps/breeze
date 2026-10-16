// apps/api/src/services/partnerTrustPartnerMail.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/emailDomains/statusMail.test.ts pattern).
// `inSystemContext` lets a test assert the transport call happens after the
// system-scope callback has resolved (#1105: no pooled connection held across
// the SMTP round trip).
const { dbResults, ctx } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  ctx: { inSystemContext: false, sendCalledInsideContext: null as boolean | null },
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => {
      ctx.inSystemContext = true;
      try { return await fn(); } finally { ctx.inSystemContext = false; }
    },
    getCurrentDbAccessContext: () => undefined,
  };
});

const { sendEmailMock, getEmailServiceMock, listActivePartnerAdmins, partnerTrustMode, captureException } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
  listActivePartnerAdmins: vi.fn(),
  partnerTrustMode: vi.fn(() => 'enforce' as 'off' | 'shadow' | 'enforce'),
  captureException: vi.fn(),
}));
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});
vi.mock('./partnerAdminRecipients', () => ({ listActivePartnerAdmins }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode }));
vi.mock('./sentry', () => ({ captureException }));

import { db } from '../db';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import {
  buildTrustApprovedTemplate,
  buildTrustReviewReceivedTemplate,
  GETTING_STARTED_DOCS_URL,
  sendTrustApprovedEmail,
  sendTrustReviewReceivedEmail,
} from './partnerTrustPartnerMail';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const ACTIVE_PARTNER = { name: 'Acme MSP', status: 'active' };

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  ctx.inSystemContext = false;
  ctx.sendCalledInsideContext = null;
  process.env = { ...originalEnv };
  delete process.env.PARTNER_MEETING_URL;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.DASHBOARD_URL;
  partnerTrustMode.mockReturnValue('enforce');
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockImplementation(async () => {
    ctx.sendCalledInsideContext = ctx.inSystemContext;
  });
  listActivePartnerAdmins.mockResolvedValue([
    { id: 'u-admin', email: 'admin@acme.test', name: 'Ada' },
  ]);
});

describe('registry entries', () => {
  it('both trust purposes are PLATFORM lane', () => {
    expect(MAIL_PURPOSES['account.trust_review_received']).toEqual({ lane: 'platform' });
    expect(MAIL_PURPOSES['account.trust_approved']).toEqual({ lane: 'platform' });
  });
});

describe('buildTrustReviewReceivedTemplate', () => {
  it('confirms receipt, promises only a follow-up email, and escapes the partner name', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme <b>MSP</b>', meetingUrl: null });
    expect(tpl.subject).toBe('We received your review request');
    expect(tpl.html).toContain('Review request received');
    expect(tpl.html).toContain('Acme &lt;b&gt;MSP&lt;/b&gt;');
    expect(tpl.html).not.toContain('<b>MSP</b>');
    expect(tpl.text).toContain('Acme <b>MSP</b>');
    expect(tpl.text).toContain("We'll follow up by email");
    expect(tpl.html).not.toContain('Book a call');
  });

  it('states no turnaround figure and describes nothing that is reviewed', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme MSP', meetingUrl: null });
    const prose = `${tpl.subject}\n${tpl.text}`;
    expect(prose).not.toMatch(/\d+\s*(hour|day|business day)/i);
    expect(prose).not.toMatch(/within/i);
    for (const banned of ['card', 'IP', 'device', 'signal', 'approve', 'approval']) {
      expect(prose).not.toMatch(new RegExp(`\\b${banned}`, 'i'));
    }
  });

  it('offers a Book a call button only when a meeting URL is supplied', () => {
    const tpl = buildTrustReviewReceivedTemplate({ partnerName: 'Acme MSP', meetingUrl: 'https://meet.example.test/trust' });
    expect(tpl.html).toContain('Book a call');
    expect(tpl.html).toContain('https://meet.example.test/trust');
    expect(tpl.text).toContain('Book a call: https://meet.example.test/trust');
  });
});

describe('buildTrustApprovedTemplate', () => {
  it('announces the approval, lists remote control and script execution, and links the docs', () => {
    const tpl = buildTrustApprovedTemplate({ partnerName: 'Acme <MSP>', appUrl: null });
    expect(tpl.subject).toBe('Your Breeze account is approved');
    expect(tpl.html).toContain('Account approved');
    expect(tpl.html).toContain('Acme &lt;MSP&gt;');
    expect(tpl.text).toContain('Remote control and script execution are now enabled');
    expect(tpl.text).toContain(GETTING_STARTED_DOCS_URL);
    expect(tpl.html).toContain(`href="${GETTING_STARTED_DOCS_URL}"`);
    expect(tpl.html).not.toContain('Open Breeze');
  });

  it('adds an Open Breeze button when an app URL is supplied', () => {
    const tpl = buildTrustApprovedTemplate({ partnerName: 'Acme MSP', appUrl: 'https://app.example.test' });
    expect(tpl.html).toContain('Open Breeze');
    expect(tpl.html).toContain('href="https://app.example.test"');
    expect(tpl.text).toContain('Open Breeze: https://app.example.test');
  });
});

describe('sendTrustReviewReceivedEmail', () => {
  it('emails the requester plus every active Partner Admin, deduplicated, with the platform purpose', async () => {
    dbResults.push([ACTIVE_PARTNER]);                                  // partner lookup
    dbResults.push([{ email: 'admin@acme.test' }]);                    // requester lookup (same address as an admin)
    listActivePartnerAdmins.mockResolvedValue([
      { id: 'u-admin', email: 'admin@acme.test', name: 'Ada' },
      { id: 'u-ops', email: 'ops@acme.test', name: null },
    ]);

    const sent = await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });

    expect(sent).toBe(2);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('account.trust_review_received');
    expect(envelope.to).toEqual(['admin@acme.test', 'ops@acme.test']);
    expect(envelope.subject).toBe('We received your review request');
    expect(listActivePartnerAdmins).toHaveBeenCalledWith(PARTNER_ID);
  });

  it('looks the requester up by id AND active status', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);
    await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });

    // Second `where` on the shared chain is the requester lookup (the first is
    // the partner row). Compile it: the queued mock ignores arguments.
    const where = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[1]![0];
    const { sql, params } = new PgDialect().sqlToQuery(where as never);
    expect(sql).toContain('"users"."id"');
    expect(sql).toContain('"users"."status"');
    expect(params).toEqual([REQUESTER_ID, 'active']);
  });

  it('includes the requester even when no Partner Admin exists', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);
    listActivePartnerAdmins.mockResolvedValue([]);

    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toEqual(['owner@acme.test']);
  });

  it('passes PARTNER_MEETING_URL into the template', async () => {
    process.env.PARTNER_MEETING_URL = 'https://meet.example.test/trust';
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);

    await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });

    expect(sendEmailMock.mock.calls[0]![0].html).toContain('https://meet.example.test/trust');
  });

  it('returns 0 and sends nothing when the partner is not active', async () => {
    dbResults.push([{ name: 'Acme MSP', status: 'suspended' }]);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('calls the transport only after the system-scope callback has resolved', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    dbResults.push([{ email: 'owner@acme.test' }]);
    await sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID });
    expect(ctx.sendCalledInsideContext).toBe(false);
  });
});

describe('sendTrustApprovedEmail', () => {
  it('emails every active Partner Admin with the approval purpose and the app button', async () => {
    process.env.PUBLIC_APP_URL = 'https://app.example.test/';
    dbResults.push([ACTIVE_PARTNER]);

    const sent = await sendTrustApprovedEmail({ partnerId: PARTNER_ID });

    expect(sent).toBe(1);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('account.trust_approved');
    expect(envelope.to).toEqual(['admin@acme.test']);
    expect(envelope.html).toContain('href="https://app.example.test"');
  });

  it('falls back to DASHBOARD_URL for the button and omits it when neither is set', async () => {
    process.env.DASHBOARD_URL = 'https://dash.example.test';
    dbResults.push([ACTIVE_PARTNER]);
    await sendTrustApprovedEmail({ partnerId: PARTNER_ID });
    expect(sendEmailMock.mock.calls[0]![0].html).toContain('href="https://dash.example.test"');

    sendEmailMock.mockClear();
    delete process.env.DASHBOARD_URL;
    dbResults.push([ACTIVE_PARTNER]);
    await sendTrustApprovedEmail({ partnerId: PARTNER_ID });
    expect(sendEmailMock.mock.calls[0]![0].html).not.toContain('Open Breeze');
  });

  it('returns 0 when there are no recipients', async () => {
    dbResults.push([ACTIVE_PARTNER]);
    listActivePartnerAdmins.mockResolvedValue([]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 0 and sends nothing when the partner is not active', async () => {
    dbResults.push([{ name: 'Acme MSP', status: 'suspended' }]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns 0 when the partner row is missing', async () => {
    dbResults.push([]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('gates shared by both senders', () => {
  it.each(['off', 'shadow'] as const)('mode gate runs before any lookup when mode is %s', async (mode) => {
    partnerTrustMode.mockReturnValue(mode);
    dbResults.push([ACTIVE_PARTNER]); // would be consumed by the partner lookup if the gate ran late
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(dbResults).toHaveLength(1); // the queued row was never consumed: no DB lookup happened
  });

  it('is inert when email is not configured', async () => {
    getEmailServiceMock.mockReturnValue(null);
    dbResults.push([ACTIVE_PARTNER]);
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    await expect(sendTrustReviewReceivedEmail({ partnerId: PARTNER_ID, requestedByUserId: REQUESTER_ID })).resolves.toBe(0);
    expect(listActivePartnerAdmins).not.toHaveBeenCalled();
    expect(dbResults).toHaveLength(1);
  });

  it('swallows a transport failure, logs it, and reports it to Sentry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbResults.push([ACTIVE_PARTNER]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));

    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('[PartnerTrust]'), 'smtp down');
    error.mockRestore();
  });

  it('swallows a recipient lookup failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dbResults.push([ACTIVE_PARTNER]);
    listActivePartnerAdmins.mockRejectedValueOnce(new Error('db gone'));
    await expect(sendTrustApprovedEmail({ partnerId: PARTNER_ID })).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
