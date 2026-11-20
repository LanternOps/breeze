/**
 * #4248 W03 (Task 7) — the per-recipient export-authority gate and the
 * transaction-free narrative email send.
 *
 * The state machine (`reportRunDelivery.ts`) is replaced by an in-memory
 * double so every assertion here is about the GATE and the ORDERING
 * (resolve -> claim -> send outside any context -> settle), not about SQL —
 * that is `reportRunDelivery.test.ts`'s job, and the live proof is
 * `narrativeEmailDelivery.integration.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN = '00000000-0000-4000-8000-0000000000b1';
const REPORT = '00000000-0000-4000-8000-0000000000b2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000c1';
const U1 = '00000000-0000-4000-8000-0000000000e1';
const U2 = '00000000-0000-4000-8000-0000000000e2';

type Row = {
  id: string; reportRunId: string; recipientUserId: string; channel: 'email';
  state: 'pending' | 'claimed' | 'sent' | 'failed' | 'unknown'; attempts: number; lastError: string | null; createdAt: Date;
};

const fake = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  users: new Map<string, { id: string; email: string | null; status: string }>(),
  authority: new Map<string, unknown>(),
  ambientContext: undefined as { scope: string } | undefined,
  contextAtSend: [] as Array<{ scope: string } | undefined>,
  emailConfigured: true,
  lastAuthorityUser: null as string | null,
}));

vi.mock('../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const b: Record<string, unknown> = {
        innerJoin: vi.fn(() => b),
        leftJoin: vi.fn(() => b),
        where: vi.fn(() => b),
        limit: vi.fn(() => b),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => {
            if (name === 'report_runs') {
              return [{
                reportRunId: RUN, reportId: REPORT, orgId: ORG, reportName: 'Weekly AI operations narrative',
                reportType: 'ai_org_narrative', format: 'pdf',
                result: { rows: [], rowCount: 0, summary: { narrative: { headline: 'A quiet week.' } } },
              }];
            }
            // The mock cannot read the WHERE; the gate always resolves the
            // authority for a user right before looking up that user's email.
            if (name === 'users') {
              const user = fake.lastAuthorityUser ? fake.users.get(fake.lastAuthorityUser) : undefined;
              return user ? [user] : [];
            }
            // Serves BOTH reads of this table in the pass: resolveOrgTimezone's
            // org/partner join and W04's org -> partner lookup for the
            // `general` stream's sender (spec §8.2). Selecting a superset is
            // harmless — each caller projects the columns it asked for.
            if (name === 'organizations') return [{ orgSettings: null, partnerTimezone: 'UTC', partnerSettings: null, partnerName: null, partnerId: PARTNER }];
            throw new Error(`unexpected select from ${name}`);
          }).then(resolve, reject),
      };
      return b;
    }),
  });
  return {
    db: { select: vi.fn(() => makeSelect()) },
    getCurrentDbAccessContext: vi.fn(() => fake.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => {
      fake.ambientContext = undefined;
      return fn();
    }),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = fake.ambientContext;
      fake.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        fake.ambientContext = previous;
      }
    }),
  };
});

vi.mock('./reportRunDelivery', async (importOriginal) => ({
  // The real marker helpers (pure); every DB-touching export is replaced below.
  heldMarker: (await importOriginal<typeof import('./reportRunDelivery')>()).heldMarker,
  heldNotBefore: (await importOriginal<typeof import('./reportRunDelivery')>()).heldNotBefore,
  STALE_CLAIM_MS: 15 * 60 * 1000,
  listPendingDeliveriesForRun: vi.fn(async (runId: string) =>
    [...fake.rows.values()].filter((r) => r.reportRunId === runId && r.state === 'pending')),
  claimDelivery: vi.fn(async (id: string) => {
    const row = fake.rows.get(id);
    if (!row || row.state !== 'pending') return false;
    row.state = 'claimed';
    row.attempts += 1;
    return true;
  }),
  settleDelivery: vi.fn(async (id: string, outcome: { state: Row['state']; error?: string }) => {
    const row = fake.rows.get(id);
    if (!row || row.state !== 'claimed') return;
    row.state = outcome.state;
    row.lastError = outcome.error ?? null;
  }),
  recordTransientGateFailure: vi.fn(async (id: string, error: string) => {
    const row = fake.rows.get(id);
    if (row && row.state === 'pending') row.lastError = error;
  }),
  releaseHeldDelivery: vi.fn(async (id: string, error: string) => {
    const row = fake.rows.get(id);
    if (row && row.state === 'claimed') { row.state = 'pending'; row.lastError = error; }
  }),
  summarizeDeliveries: vi.fn(async (runId: string) => {
    const rows = [...fake.rows.values()].filter((r) => r.reportRunId === runId);
    const count = (s: Row['state'][]) => rows.filter((r) => s.includes(r.state)).length;
    return { total: rows.length, sent: count(['sent']), failed: count(['failed']), unknown: count(['unknown']), pending: count(['pending', 'claimed']) };
  }),
}));

const resolveLiveReportAuthorityMock = vi.fn(async (userId: string, _orgId: string, _action: string) => {
  fake.lastAuthorityUser = userId;
  return fake.authority.get(userId) ?? { ok: false, reason: 'membership_removed' };
});
vi.mock('./siteScope', () => ({
  resolveLiveReportAuthority: (...args: [string, string, string]) => resolveLiveReportAuthorityMock(...args),
}));

const emailReportRunMock = vi.fn(async (_opts: unknown) => {
  fake.contextAtSend.push(fake.ambientContext);
});
vi.mock('./reportDelivery', () => ({
  emailReportRun: (opts: unknown) => emailReportRunMock(opts),
}));

vi.mock('./email', () => ({
  getEmailService: () => (fake.emailConfigured ? { sendEmail: vi.fn() } : null),
}));
vi.mock('./reportBranding', () => ({
  loadReportBrandingForOrg: vi.fn(async () => ({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null })),
}));
vi.mock('./portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'UTC'),
}));

import { deliverNarrativeEmails } from './reportNarrativeDelivery';

function seed(userId: string, state: Row['state'] = 'pending', email: string | null = `${userId.slice(-2)}@example.com`) {
  const id = `d-${userId}`;
  fake.rows.set(id, { id, reportRunId: RUN, recipientUserId: userId, channel: 'email', state, attempts: 0, lastError: null, createdAt: new Date() });
  fake.users.set(userId, { id: userId, email, status: 'active' });
  return id;
}
function row(userId: string): Row {
  return fake.rows.get(`d-${userId}`)!;
}
function unrestricted() {
  return { ok: true, authority: { scope: { kind: 'unrestricted', version: 1, orgId: ORG } } };
}
function restricted(siteIds: string[]) {
  return { ok: true, authority: { scope: { kind: 'restricted', version: 1, orgId: ORG, siteIds } } };
}
const ctx = { orgId: ORG };

beforeEach(() => {
  vi.clearAllMocks();
  fake.rows.clear();
  fake.users.clear();
  fake.authority.clear();
  fake.ambientContext = undefined;
  fake.contextAtSend = [];
  fake.emailConfigured = true;
  fake.lastAuthorityUser = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('narrative email authority gate (#4248 W03)', () => {
  it('delivers to an unrestricted recipient', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(resolveLiveReportAuthorityMock).toHaveBeenCalledWith(U1, ORG, 'export');
    expect(emailReportRunMock).toHaveBeenCalledTimes(1);
    expect(emailReportRunMock.mock.calls[0]![0]).toMatchObject({
      reportName: 'Weekly AI operations narrative',
      reportType: 'ai_org_narrative',
      format: 'pdf',
      recipients: ['e1@example.com'],
      rows: [],
      summary: { narrative: { headline: 'A quiet week.' } },
      timezone: 'UTC',
      // Spec §8.2: the report's org resolves the partner whose `general`
      // stream sends it. A regression to null silently switches the lane off
      // for every narrative email.
      partnerId: PARTNER,
    });
    expect(row(U1).state).toBe('sent');
    expect(s).toMatchObject({ sent: 1, failed: 0, refused: 0, transient: 0 });
  });

  it('withholds the email from a site-restricted recipient', async () => {
    seed(U1);
    fake.authority.set(U1, restricted(['s1']));

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(row(U1)).toMatchObject({ state: 'failed', lastError: 'authority:scope_not_unrestricted', attempts: 1 });
    expect(s).toMatchObject({ sent: 0, failed: 1, refused: 1 });
  });

  it('withholds from legacy_unscoped — an unprovable scope is not an unrestricted one', async () => {
    seed(U1);
    fake.authority.set(U1, { ok: true, authority: { scope: { kind: 'legacy_unscoped', version: 1, orgId: ORG } } });

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(row(U1).state).toBe('failed');
    expect(s).toMatchObject({ failed: 1 });
  });

  it('leaves a row RETRYABLE when the scope is only temporarily unverifiable', async () => {
    seed(U1);
    fake.authority.set(U1, { ok: false, reason: 'unverifiable_scope' });

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1)).toMatchObject({ state: 'pending', lastError: 'authority:unverifiable_scope', attempts: 0 });
    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(s).toMatchObject({ transient: 1, pending: 1 });
  });

  it('permanently refuses a removed membership', async () => {
    seed(U1);
    fake.authority.set(U1, { ok: false, reason: 'membership_removed' });

    await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1)).toMatchObject({ state: 'failed', lastError: 'authority:membership_removed' });
  });

  it('refuses a recipient with no usable email as authority:no_email, without sending', async () => {
    seed(U1, 'pending', null);
    fake.authority.set(U1, unrestricted());

    await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(row(U1)).toMatchObject({ state: 'failed', lastError: 'authority:no_email' });
  });

  it('a second finalizer pass sends ZERO additional emails', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());

    await deliverNarrativeEmails(RUN, ctx);
    emailReportRunMock.mockClear();
    await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(row(U1).attempts).toBe(1);
  });

  it('sends OUTSIDE any db transaction, after the claim', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());
    const { claimDelivery } = await import('./reportRunDelivery');

    await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).toHaveBeenCalledTimes(1);
    expect(fake.contextAtSend, 'a send inside a transaction can be rolled back after the mail leaves').toEqual([undefined]);
    expect(vi.mocked(claimDelivery).mock.invocationCallOrder[0]!)
      .toBeLessThan(emailReportRunMock.mock.invocationCallOrder[0]!);
  });

  it('refuses to run inside an ambient db context', async () => {
    fake.ambientContext = { scope: 'system' };
    await expect(deliverNarrativeEmails(RUN, ctx)).rejects.toThrow(/outside any db context/i);
  });

  it('records an ambiguous provider outcome as unknown, not as sent or failed', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());
    emailReportRunMock.mockRejectedValueOnce(new Error('connect ETIMEDOUT 1.2.3.4:443'));

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1)).toMatchObject({ state: 'unknown', lastError: expect.stringContaining('ETIMEDOUT') });
    expect(s).toMatchObject({ unknown: 1, sent: 0 });
  });

  // A rate limit is the provider asking us to slow down, not refusing the
  // message — and `failed` is terminal (the reconciler sweeps only
  // pending/claimed), so misclassifying it silently drops the week's email.
  it.each([
    ['Mailgun API error (429): too many requests'],
    ['Mailgun API error (408): request timeout'],
    ['Resend error: rate limit exceeded'],
  ])('treats a throttling/timeout provider answer as unknown, not failed: %s', async (message) => {
    seed(U1);
    fake.authority.set(U1, unrestricted());
    emailReportRunMock.mockRejectedValueOnce(new Error(message));

    await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1).state).toBe('unknown');
  });

  // #12249: a held send went out on neither lane. Inside the maximum age the
  // row goes back to `pending` with a not-before marker (the table has no
  // next-attempt column) and later passes skip it until then; past the maximum
  // age it settles `failed` — never the ambiguous `unknown`.
  describe('a held send', () => {
    const heldError = (retryAt: Date) => Object.assign(new Error('Email not sent: partner p1 reached its daily partner-lane send cap'), {
      name: 'EmailSendHeldError', reason: 'over_cap', partnerId: 'p1', purpose: 'report.delivery', retryAt,
    });

    it('is released back to pending with a not-before marker inside the maximum age', async () => {
      seed(U1);
      fake.authority.set(U1, unrestricted());
      const retryAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
      emailReportRunMock.mockRejectedValueOnce(heldError(retryAt));

      const s = await deliverNarrativeEmails(RUN, ctx);

      expect(row(U1).state).toBe('pending');
      expect(row(U1).lastError).toMatch(/^held:over_cap:until=/);
      const until = new Date(row(U1).lastError!.split('until=')[1]!);
      expect(until.getTime()).toBeGreaterThanOrEqual(retryAt.getTime());
      expect(s).toMatchObject({ transient: 1, failed: 0, unknown: 0 });
    });

    it('a later pass skips the row, without claiming it, until the marker time', async () => {
      seed(U1);
      fake.authority.set(U1, unrestricted());
      row(U1).lastError = `held:over_cap:until=${new Date(Date.now() + 60 * 60 * 1000).toISOString()}`;

      const s = await deliverNarrativeEmails(RUN, ctx);

      expect(emailReportRunMock).not.toHaveBeenCalled();
      expect(row(U1)).toMatchObject({ state: 'pending', attempts: 0 });
      expect(s).toMatchObject({ transient: 1 });

      // Once the marker time has passed the row is attempted again.
      row(U1).lastError = `held:over_cap:until=${new Date(Date.now() - 1000).toISOString()}`;
      await deliverNarrativeEmails(RUN, ctx);
      expect(emailReportRunMock).toHaveBeenCalledTimes(1);
      expect(row(U1).state).toBe('sent');
    });

    it('settles failed, with a logged reason, once retryAt is past the maximum age', async () => {
      seed(U1);
      fake.authority.set(U1, unrestricted());
      row(U1).createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      emailReportRunMock.mockRejectedValueOnce(heldError(new Date(Date.now() + 6 * 60 * 60 * 1000)));

      await deliverNarrativeEmails(RUN, ctx);

      expect(row(U1)).toMatchObject({ state: 'failed', lastError: 'held:over_cap:past_max_age' });
      expect(warn).toHaveBeenCalledWith('[email] held send dropped', expect.objectContaining({ site: 'reportNarrativeDelivery' }));
      warn.mockRestore();
    });
  });

  it('still treats a definite Mailgun 4xx refusal as failed', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());
    emailReportRunMock.mockRejectedValueOnce(new Error('Mailgun API error (400): invalid recipient'));

    await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1).state).toBe('failed');
  });

  it('records a definite provider refusal as failed', async () => {
    seed(U1);
    fake.authority.set(U1, unrestricted());
    emailReportRunMock.mockRejectedValueOnce(new Error('Resend error: Invalid `to` field'));

    await deliverNarrativeEmails(RUN, ctx);

    expect(row(U1)).toMatchObject({ state: 'failed', lastError: expect.stringContaining('Resend error') });
  });

  it('leaves every row pending (no claim burnt) when no email service is configured', async () => {
    fake.emailConfigured = false;
    seed(U1);
    fake.authority.set(U1, unrestricted());

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).not.toHaveBeenCalled();
    expect(row(U1)).toMatchObject({ state: 'pending', attempts: 0 });
    expect(s).toMatchObject({ pending: 1, transient: 1 });
  });

  it('logs a counted outcome when every recipient is skipped', async () => {
    seed(U1);
    seed(U2);
    fake.authority.set(U1, restricted([]));
    fake.authority.set(U2, { ok: false, reason: 'unverifiable_scope' });

    await deliverNarrativeEmails(RUN, ctx);

    const warned = vi.mocked(console.warn).mock.calls.find((c) => String(c[0]).includes('all recipients skipped'));
    expect(warned).toBeDefined();
    expect(warned![1]).toMatchObject({ reportRunId: RUN, orgId: ORG, refused: 1, transient: 1 });
  });

  it('a refusal for one recipient never blocks delivery to another', async () => {
    seed(U1);
    seed(U2);
    fake.authority.set(U1, restricted(['s1']));
    fake.authority.set(U2, unrestricted());

    const s = await deliverNarrativeEmails(RUN, ctx);

    expect(emailReportRunMock).toHaveBeenCalledTimes(1);
    expect(emailReportRunMock.mock.calls[0]![0]).toMatchObject({ recipients: ['e2@example.com'] });
    expect(s).toMatchObject({ sent: 1, failed: 1 });
  });
});
