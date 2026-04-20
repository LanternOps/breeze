import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks (order matters: module-factories run at import-time) ----------

vi.mock('../../../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
}));

vi.mock('../../../db/schema', () => ({
  deploymentInvites: {
    id: 'deployment_invites.id',
    partnerId: 'deployment_invites.partner_id',
    invitedEmail: 'deployment_invites.invited_email',
    sentAt: 'deployment_invites.sent_at',
  },
  partners: {
    id: 'partners.id',
    name: 'partners.name',
    paymentMethodAttachedAt: 'partners.payment_method_attached_at',
  },
}));

vi.mock('../paymentGate', async () => {
  // Pass-through decorator: in unit tests we want to exercise the handler
  // directly except for the explicit "payment required" case, where we can
  // swap the decorator out per-test.
  return {
    requirePaymentMethod: <I, O>(h: (i: I, c: any) => Promise<O>) => h,
    PaymentRequiredError: class PaymentRequiredError extends Error {
      code = 'PAYMENT_REQUIRED' as const;
    },
  };
});

vi.mock('../../../services/rate-limit', () => ({
  rateLimiter: vi.fn(),
}));

vi.mock('../../../services/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('../../../routes/enrollmentKeys', () => ({
  mintChildEnrollmentKey: vi.fn(),
}));

vi.mock('../../../services/email', () => ({
  getEmailService: vi.fn(),
}));

vi.mock('../../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { sendDeploymentInvitesTool } from './sendDeploymentInvites';
import { db } from '../../../db';
import { rateLimiter } from '../../../services/rate-limit';
import { mintChildEnrollmentKey } from '../../../routes/enrollmentKeys';
import { getEmailService } from '../../../services/email';
import { writeAuditEvent } from '../../../services/auditEvents';

// ---- Helpers --------------------------------------------------------------

function mockSelectQueue(results: unknown[][]): void {
  const queue = [...results];
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
    // The `where` terminal (no .limit) is used for the dedupe lookup —
    // it must also be awaitable. Return a proxy whose await resolves.
    chain.where = vi.fn().mockImplementation(function () {
      // Build a thenable that also has `.limit`.
      const next = Promise.resolve(queue.shift() ?? []);
      (next as any).limit = (_: number) => next; // harmless alias
      return Object.assign(next, {
        from: vi.fn().mockReturnValue(next),
        where: vi.fn().mockReturnValue(next),
        limit: vi.fn().mockReturnValue(next),
      });
    });
    return chain as any;
  });
}

function mockInsertReturning(rows: Array<{ id: string }>): void {
  const queue = [...rows];
  vi.mocked(db.insert).mockImplementation(() => {
    const chain: any = {
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockImplementation(() =>
        Promise.resolve([queue.shift() ?? { id: 'fallback' }]),
      ),
    };
    return chain as any;
  });
}

const sendEmailMock = vi.fn();

const ctx: any = {
  ip: '1.2.3.4',
  userAgent: 'mcp-test',
  region: 'us',
  apiKey: {
    id: '11111111-1111-1111-1111-111111111111',
    partnerId: '22222222-2222-2222-2222-222222222222',
    defaultOrgId: '33333333-3333-3333-3333-333333333333',
    partnerAdminEmail: 'admin@acme.com',
    scopeState: 'full',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_ACTIVATION_BASE_URL = 'https://us.2breeze.app';
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
  vi.mocked(getEmailService).mockReturnValue({ sendEmail: sendEmailMock } as any);
  vi.mocked(rateLimiter).mockResolvedValue({
    allowed: true,
    remaining: 49,
    resetAt: new Date(Date.now() + 3600_000),
  });
  vi.mocked(mintChildEnrollmentKey).mockImplementation(async (input) => ({
    id: `child-${input.nameSuffix ?? 'x'}`,
    orgId: '33333333-3333-3333-3333-333333333333',
    siteId: '44444444-4444-4444-4444-444444444444',
    shortCode: `SC${(input.nameSuffix ?? 'x').slice(0, 4).toUpperCase()}`,
    rawKey: 'raw-enrollment-key',
    expiresAt: new Date(Date.now() + 86400_000),
  }));
});

// ---- Tests ---------------------------------------------------------------

describe('send_deployment_invites', () => {
  it('rejects when emails array exceeds free-tier cap (>25) via zod', () => {
    const tooMany = Array.from({ length: 26 }, (_, i) => `user${i}@acme.com`);
    const parsed = sendDeploymentInvitesTool.definition.inputSchema.safeParse({ emails: tooMany });
    expect(parsed.success).toBe(false);
  });

  it('rejects when emails array is empty via zod', () => {
    const parsed = sendDeploymentInvitesTool.definition.inputSchema.safeParse({ emails: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-email strings via zod', () => {
    const parsed = sendDeploymentInvitesTool.definition.inputSchema.safeParse({
      emails: ['not-an-email'],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts valid input with os_targets omitted (defaults to "auto")', () => {
    const parsed = sendDeploymentInvitesTool.definition.inputSchema.safeParse({
      emails: ['alex@acme.com'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.os_targets).toBe('auto');
  });

  it('enforces per-tenant invite rate limit (50/hour) BEFORE any DB writes', async () => {
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 3600_000),
    });
    await expect(
      sendDeploymentInvitesTool.handler({ emails: ['x@y.com'], os_targets: 'auto' } as any, ctx),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(mintChildEnrollmentKey).not.toHaveBeenCalled();
  });

  it('dedupes recipients invited in the last 24h (case-insensitive)', async () => {
    // 1st select() call is the dedupe lookup — return one recent invite
    // (uppercase variant of what the caller sends). 2nd is partners.name.
    mockSelectQueue([
      [{ email: 'DUPE@acme.com' }], // recent invites
      [{ name: 'Acme' }],           // partner lookup
    ]);
    mockInsertReturning([{ id: 'inv-1' }]);

    const res = await sendDeploymentInvitesTool.handler(
      { emails: ['dupe@acme.com', 'fresh@acme.com'], os_targets: 'auto' } as any,
      ctx,
    );

    expect(res.skipped_duplicates).toBe(1);
    expect(res.invites_sent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0]?.[0]?.to).toBe('fresh@acme.com');
  });

  it('returns skipped_duplicates = emails.length and no error when all are deduped', async () => {
    mockSelectQueue([
      [{ email: 'a@acme.com' }, { email: 'b@acme.com' }],
    ]);

    const res = await sendDeploymentInvitesTool.handler(
      { emails: ['a@acme.com', 'B@acme.com'], os_targets: 'auto' } as any,
      ctx,
    );

    expect(res).toEqual({ invites_sent: 0, invite_ids: [], skipped_duplicates: 2 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(mintChildEnrollmentKey).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('mints a child key per recipient, sends email, inserts row, writes audit event', async () => {
    mockSelectQueue([
      [],                    // dedupe: no recent invites
      [{ name: 'Acme' }],    // partner lookup
    ]);
    mockInsertReturning([{ id: 'inv-a' }, { id: 'inv-b' }]);

    const res = await sendDeploymentInvitesTool.handler(
      {
        emails: ['alex@acme.com', 'sam@acme.com'],
        custom_message: 'Please install today.',
        os_targets: 'auto',
      } as any,
      ctx,
    );

    expect(res.invites_sent).toBe(2);
    expect(res.invite_ids).toEqual(['inv-a', 'inv-b']);
    expect(res.skipped_duplicates).toBe(0);

    expect(mintChildEnrollmentKey).toHaveBeenCalledTimes(2);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(2);

    // install URL should land in the email body
    const firstCall = sendEmailMock.mock.calls[0]?.[0];
    expect(firstCall?.html).toContain('/i/SCALEX'); // nameSuffix = 'alex@acme.com' → first 4 upper
    // audit event fired per recipient
    expect(writeAuditEvent).toHaveBeenCalledTimes(2);
    const lastAudit = vi.mocked(writeAuditEvent).mock.calls[0]?.[1];
    if (!lastAudit) throw new Error('expected audit call');
    expect(lastAudit.action).toBe('invite.sent');
    expect(lastAudit.actorType).toBe('api_key');
    expect(lastAudit.resourceType).toBe('deployment_invite');
    expect(lastAudit.result).toBe('success');
    expect(lastAudit.details).toMatchObject({ mcp_origin: true, recipient_domain: 'acme.com' });
  });

  it('continues on per-recipient email failure and records failures[] + failure audit', async () => {
    mockSelectQueue([
      [],
      [{ name: 'Acme' }],
    ]);
    mockInsertReturning([{ id: 'inv-ok' }]);
    sendEmailMock
      .mockRejectedValueOnce(new Error('smtp boom'))
      .mockResolvedValueOnce(undefined);

    const res = await sendDeploymentInvitesTool.handler(
      { emails: ['bad@acme.com', 'good@acme.com'], os_targets: 'auto' } as any,
      ctx,
    );

    expect(res.invites_sent).toBe(1);
    expect(res.invite_ids).toEqual(['inv-ok']);
    expect(res.failures).toEqual([{ email: 'bad@acme.com', error: 'smtp boom' }]);

    // one success + one failure audit
    const calls = vi.mocked(writeAuditEvent).mock.calls;
    const results = calls.map((c) => c[1].result);
    expect(results).toContain('failure');
    expect(results).toContain('success');
  });
});
