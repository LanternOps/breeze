import { beforeEach, describe, expect, it, vi } from 'vitest';

// Queued select-chain db mock (services/quoteOutcomeNotify.test.ts pattern).
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
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
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
  };
});

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
}));
vi.mock('../email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { MAIL_PURPOSES } from './mailPurposes';
import { buildSendingDomainStatusTemplate, sendSendingDomainStatusEmail } from './statusMail';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockResolvedValue(undefined);
});

describe('staff.sending_domain_status registry entry', () => {
  it('is a PLATFORM purpose — a broken-domain notice must not be sent from that domain', () => {
    expect(MAIL_PURPOSES['staff.sending_domain_status']).toEqual({ lane: 'platform' });
  });
});

describe('buildSendingDomainStatusTemplate', () => {
  it('names the domain and the event in the subject for each of the five events', () => {
    const cases: Array<[Parameters<typeof buildSendingDomainStatusTemplate>[0]['event'], string]> = [
      ['verified', 'verified'],
      ['at_risk', 'at risk'],
      ['failed', 'could not be verified'],
      ['suspended', 'suspended'],
      ['auto_removed', 'removed'],
    ];
    for (const [event, fragment] of cases) {
      const tpl = buildSendingDomainStatusTemplate({ partnerId: PARTNER_ID, domain: 'mail.acme.test', event });
      expect(tpl.subject).toContain('mail.acme.test');
      expect(tpl.subject.toLowerCase()).toContain(fragment);
      expect(tpl.html).toContain('mail.acme.test');
      expect(tpl.text).toContain('mail.acme.test');
    }
  });

  it('renders the machine status reason as human text and escapes the domain', () => {
    const tpl = buildSendingDomainStatusTemplate({
      partnerId: PARTNER_ID, domain: 'a<b>.test', event: 'failed', statusReason: 'dns_not_detected',
    });
    expect(tpl.html).toContain('a&lt;b&gt;.test');
    expect(tpl.html).not.toContain('<b>.test');
    expect(tpl.text).toContain('DNS records were not detected');
  });
});

describe('sendSendingDomainStatusEmail', () => {
  it('emails the adder plus every active Partner Admin, deduplicated, with the platform purpose', async () => {
    dbResults.push([{ email: 'adder@acme.test' }]);                       // createdBy lookup
    dbResults.push([{ email: 'admin@acme.test' }, { email: 'adder@acme.test' }]); // partner admins

    const sent = await sendSendingDomainStatusEmail({
      partnerId: PARTNER_ID, domain: 'mail.acme.test', event: 'verified', createdBy: CREATOR_ID,
    });

    expect(sent).toBe(2);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.purpose).toBe('staff.sending_domain_status');
    expect(envelope.to).toEqual(['adder@acme.test', 'admin@acme.test']);
  });

  it('still reaches the partner admins when the adder has been deleted', async () => {
    dbResults.push([{ email: 'admin@acme.test' }]);
    const sent = await sendSendingDomainStatusEmail({
      partnerId: PARTNER_ID, domain: 'mail.acme.test', event: 'failed', createdBy: null,
    });
    expect(sent).toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toEqual(['admin@acme.test']);
  });

  it('is a no-op that never throws when nobody can be resolved', async () => {
    dbResults.push([]);
    dbResults.push([]);
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'suspended', createdBy: CREATOR_ID }),
    ).resolves.toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('swallows a transport failure — a status transition must not be rolled back by a bounced notice', async () => {
    dbResults.push([{ email: 'adder@acme.test' }]);
    dbResults.push([]);
    sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'verified', createdBy: CREATOR_ID }),
    ).resolves.toBe(0);
  });

  it('is inert when email is not configured', async () => {
    getEmailServiceMock.mockReturnValue(null);
    await expect(
      sendSendingDomainStatusEmail({ partnerId: PARTNER_ID, domain: 'x.test', event: 'verified' }),
    ).resolves.toBe(0);
  });
});
