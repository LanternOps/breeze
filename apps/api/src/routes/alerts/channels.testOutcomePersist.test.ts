import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// #3697 — POST /alerts/channels/:id/test must persist WHY a test failed, not
// just that it did. Before this, `last_test_status` recorded the verdict and
// the provider's message existed only in a five-second toast; reloading the
// page left the operator staring at "Failed" with no way to learn that their
// recipient domain was rejected.
//
// These assert against the values actually handed to the UPDATE, because the
// HTTP body already carried the message correctly — the defect was entirely in
// what survived the request.

const {
  authRef,
  channelRowRef,
  updateSetRef,
  senderResultRef,
  updateRowCountRef,
  capturedExceptionsRef,
} = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Org User', email: 'user@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: ['org-1'] as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  channelRowRef: { current: undefined as Record<string, unknown> | undefined },
  updateSetRef: { current: undefined as Record<string, unknown> | undefined },
  senderResultRef: { current: { success: false, error: 'unset' } as { success: boolean; error?: string } },
  // postgres-js resolves an UPDATE to a Result carrying `.count`; the route
  // reads it via extractRowCount to catch a silent zero-row write.
  updateRowCountRef: { current: 1 },
  capturedExceptionsRef: { current: [] as unknown[] },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  dbAccessContextFromAuth: (auth: any) => auth,
  withAuthDbAccessContext: (_auth: any, fn: () => Promise<unknown>) => fn(),
  siteAccessCheck: () => () => true,
}));

vi.mock('../../db', () => {
  const builder: any = {
    set: (vals: Record<string, unknown>) => {
      updateSetRef.current = vals;
      return builder;
    },
    values: () => builder,
    from: () => builder,
    where: () => Promise.resolve({ count: updateRowCountRef.current }),
    limit: () => Promise.resolve(channelRowRef.current ? [channelRowRef.current] : []),
    returning: () => Promise.resolve([]),
  };
  // `where` has to be thenable for the UPDATE (awaited directly) AND chainable
  // for the SELECT (…where().limit()). Give the select path its own object.
  const selectBuilder: any = {
    from: () => selectBuilder,
    where: () => selectBuilder,
    limit: () => Promise.resolve(channelRowRef.current ? [channelRowRef.current] : []),
  };
  return {
    db: {
      insert: () => builder,
      update: () => builder,
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      select: () => selectBuilder,
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  };
});

vi.mock('../../db/schema', () => ({
  notificationChannels: {
    id: { name: 'id' },
    orgId: { name: 'org_id' },
    partnerId: { name: 'partner_id' },
    type: { name: 'type' },
    name: { name: 'name' },
    enabled: { name: 'enabled' },
    config: { name: 'config' },
    lastTestedAt: { name: 'last_tested_at' },
    lastTestStatus: { name: 'last_test_status' },
    lastTestError: { name: 'last_test_error' },
    updatedAt: { name: 'updated_at' },
    createdAt: { name: 'created_at' },
  },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  partners: { id: { name: 'id' }, settings: { name: 'settings' } },
  alertRules: {},
  alertTemplates: {},
  alerts: {},
  devices: {},
  escalationPolicies: {},
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn((err: unknown) => { capturedExceptionsRef.current.push(err); }),
}));

// Crypto is bypassed, but scrubChannelTestError is deliberately left REAL: the
// point of the slack case below is that the route hands the scrubber the
// DECRYPTED config, which is the only thing that can remove a webhook URL.
vi.mock('../../services/notificationChannelSecrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/notificationChannelSecrets')>();
  return {
    ...actual,
    encryptNotificationChannelConfig: vi.fn((_t: string, config: unknown) => config),
    decryptNotificationChannelConfig: vi.fn((_t: string, config: unknown) => config),
    redactNotificationChannelConfig: vi.fn((_t: string, config: unknown) => config),
  };
});

vi.mock('../../services/notificationSenders', () => ({
  getEmailRecipients: (config: Record<string, unknown>) => (config.recipients as string[]) ?? [],
  sendEmailNotification: vi.fn(async () => senderResultRef.current),
  sendWebhookNotification: vi.fn(async () => senderResultRef.current),
  testWebhook: vi.fn(async () => senderResultRef.current),
  sendPagerDutyNotification: vi.fn(async () => senderResultRef.current),
  sendPushoverNotification: vi.fn(async () => senderResultRef.current),
  sendSmsNotification: vi.fn(async () => senderResultRef.current),
}));

import { channelsRoutes } from './channels';

const CHANNEL_ID = '5d4c3b2a-1111-4222-8333-444455556666';

function makeApp() {
  const app = new Hono();
  app.route('/alerts', channelsRoutes);
  return app;
}

function emailChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: CHANNEL_ID,
    orgId: 'org-1',
    partnerId: null,
    name: 'QA Sweep Email Channel',
    type: 'email',
    config: { recipients: ['qa-sweep@example.com'] },
    enabled: true,
    throttleMaxPerWindow: null,
    throttleWindowSeconds: 3600,
    lastTestedAt: null,
    lastTestStatus: null,
    lastTestError: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Verbatim from the issue report — already operator-ready, and previously lost.
const RESEND_ERROR =
  'Invalid `to` field. Please use our testing email address instead of domains like `example.com`.';

// Assembled at runtime, never written as a literal: GitHub push protection
// blocks a Slack-webhook-shaped string in source even when it is fabricated.
// The value the code under test receives is byte-identical to a real one.
function fakeSlackWebhookUrl(secret: string): string {
  return `https://${['hooks', 'slack', 'com'].join('.')}/services/T00000000/B00000000/${secret}`;
}

describe('POST /alerts/channels/:id/test — persisted test outcome (#3697)', () => {
  beforeEach(() => {
    updateSetRef.current = undefined;
    updateRowCountRef.current = 1;
    capturedExceptionsRef.current = [];
    channelRowRef.current = emailChannel();
  });

  it('persists the provider failure reason alongside the failed verdict', async () => {
    senderResultRef.current = { success: false, error: RESEND_ERROR };

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    const body = await res.json() as { testResult: { success: boolean; message: string } };

    // The response shape the issue documented: HTTP 200, success:false.
    expect(res.status).toBe(200);
    expect(body.testResult.success).toBe(false);

    expect(updateSetRef.current?.lastTestStatus).toBe('failed');
    expect(updateSetRef.current?.lastTestError).toBe(RESEND_ERROR);
  });

  // The half of the bug that a "write the reason" change can reintroduce: if
  // the column is only ever written on failure, a channel that is fixed and
  // retested shows a green "Success" with last week's error still under it.
  it('clears the stored reason when a later test passes', async () => {
    channelRowRef.current = emailChannel({ lastTestStatus: 'failed', lastTestError: RESEND_ERROR });
    senderResultRef.current = { success: true };

    await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

    expect(updateSetRef.current?.lastTestStatus).toBe('success');
    expect(updateSetRef.current?.lastTestError).toBeNull();
  });

  // A sender that THROWS rather than resolving {success:false} takes the
  // catch-all path, whose message is built from an Error rather than the
  // hand-crafted strings every other case produces. Network clients routinely
  // embed the URL they were called with in `error.message`, and for a slack
  // channel that URL is the credential — so the scrub has to hold here too.
  it('scrubs and persists a reason from a sender that throws', async () => {
    const webhookUrl = fakeSlackWebhookUrl('QQQQQQQQQQQQQQQQQQQQQQQQ');
    channelRowRef.current = emailChannel({ type: 'slack', config: { webhookUrl } });
    const { sendWebhookNotification } = await import('../../services/notificationSenders');
    vi.mocked(sendWebhookNotification).mockRejectedValueOnce(new Error(`socket hang up posting to ${webhookUrl}`));

    await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

    const stored = updateSetRef.current?.lastTestError as string;
    expect(updateSetRef.current?.lastTestStatus).toBe('failed');
    expect(stored).toContain('Failed to test channel');
    expect(stored).not.toContain(webhookUrl);
    expect(stored).not.toContain('QQQQQQQQQQQQQQQQQQQQQQQQ');
  });

  // The deploy-drift branch (DB enum has a type the code does not handle)
  // returns 501 BEFORE the persist. Writing a verdict there would record
  // "failed" for a channel nobody actually tested. The invariant is currently
  // only stated in a comment, and a refactor that hoists the persist would
  // break it silently.
  it('persists nothing for an unsupported channel type', async () => {
    channelRowRef.current = emailChannel({ type: 'carrier-pigeon' });

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

    expect(res.status).toBe(501);
    expect(updateSetRef.current).toBeUndefined();
  });

  // A zero-row UPDATE does not throw. Before this was checked, the card kept
  // its previous verdict — potentially a stale green "Success" under a toast
  // that just said the test failed — with nothing recorded anywhere.
  it('reports a persist that silently matched no rows', async () => {
    senderResultRef.current = { success: false, error: RESEND_ERROR };
    updateRowCountRef.current = 0;

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

    // The caller still gets its verdict — the persist stays best-effort.
    expect(res.status).toBe(200);
    expect(capturedExceptionsRef.current).toHaveLength(1);
    expect((capturedExceptionsRef.current[0] as Error).message).toContain('0 rows');
  });

  it('reports a persist that threw instead of failing the request', async () => {
    senderResultRef.current = { success: false, error: RESEND_ERROR };
    const { db } = await import('../../db');
    const updateSpy = vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    updateSpy.mockRestore();

    // The outbound send already happened; a DB hiccup must not retro-fail it.
    expect(res.status).toBe(200);
    expect(capturedExceptionsRef.current).toHaveLength(1);
    expect((capturedExceptionsRef.current[0] as Error).message).toContain('connection terminated');
  });

  // End-to-end proof that the route hands the scrubber the DECRYPTED config.
  // A Slack incoming-webhook URL is the credential; persisting one that the
  // provider echoed back would expose it to every alerts:read user and carry
  // it into the tenant export.
  it('does not persist a slack webhook URL the provider echoed back', async () => {
    const webhookUrl = fakeSlackWebhookUrl('ZZZZZZZZZZZZZZZZZZZZZZZZ');
    channelRowRef.current = emailChannel({ type: 'slack', config: { webhookUrl } });
    senderResultRef.current = { success: false, error: `HTTP 404: no_service for ${webhookUrl}` };

    await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });

    const stored = updateSetRef.current?.lastTestError as string;
    expect(updateSetRef.current?.lastTestStatus).toBe('failed');
    expect(stored).not.toContain(webhookUrl);
    expect(stored).not.toContain('ZZZZZZZZZZZZZZZZZZZZZZZZ');
    // Still says what happened.
    expect(stored).toContain('no_service');
  });
});

// The reason reaches the operator on TWO surfaces: the persisted card (above)
// and the toast fired at test time, which renders `testResult.message` from
// this response. The response carried the RAW provider text, so the card was
// scrubbed while the toast next to it showed the credential (#3992).
describe('POST /alerts/channels/:id/test — the toast surface (#3992)', () => {
  beforeEach(() => {
    updateSetRef.current = undefined;
    updateRowCountRef.current = 1;
    capturedExceptionsRef.current = [];
    channelRowRef.current = emailChannel();
  });

  it('does not echo a slack webhook URL back in the response the toast renders', async () => {
    const webhookUrl = fakeSlackWebhookUrl('YYYYYYYYYYYYYYYYYYYYYYYY');
    channelRowRef.current = emailChannel({ type: 'slack', config: { webhookUrl } });
    senderResultRef.current = { success: false, error: `HTTP 404: no_service for ${webhookUrl}` };

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    const body = await res.json() as { testResult: { success: boolean; message: string } };

    expect(body.testResult.success).toBe(false);
    expect(body.testResult.message).not.toContain(webhookUrl);
    expect(body.testResult.message).not.toContain('YYYYYYYYYYYYYYYYYYYYYYYY');
    expect(body.testResult.message).toContain('no_service');
  });

  // Card and toast must not diverge: an operator who dismisses the toast and
  // reads the card should see the same sentence.
  it('renders the same reason on both surfaces', async () => {
    senderResultRef.current = { success: false, error: RESEND_ERROR };

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    const body = await res.json() as { testResult: { message: string } };

    expect(body.testResult.message).toBe(updateSetRef.current?.lastTestError);
    expect(body.testResult.message).toBe(RESEND_ERROR);
  });

  it('leaves a successful test message untouched', async () => {
    senderResultRef.current = { success: true };

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    const body = await res.json() as { testResult: { success: boolean; message: string } };

    expect(body.testResult.success).toBe(true);
    expect(body.testResult.message).toBe('Test email sent successfully');
  });

  // scrubChannelTestError returns null for an empty/whitespace-only message
  // (never as a result of scrubbing itself — redaction substitutes a non-empty
  // placeholder). The toast must not go blank when a sender hands us one.
  it('falls back to a generic reason when scrubbing leaves nothing', async () => {
    senderResultRef.current = { success: false, error: '   ' };

    const res = await makeApp().request(`/alerts/channels/${CHANNEL_ID}/test`, { method: 'POST' });
    const body = await res.json() as { testResult: { message: string } };

    expect(body.testResult.message.trim().length).toBeGreaterThan(0);
    expect(body.testResult.message).toContain('check the channel configuration');
  });
});
