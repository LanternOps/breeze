/**
 * Opt-in Gmail mark-handled runs AFTER the inbound pipeline, against real
 * Postgres: only messages the pipeline logged as created/matched are labelled;
 * quarantined/ignored/failed mail stays untouched in the inbox. Gmail HTTP is
 * replaced by injected fakes.
 */
import './setup';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const gm = vi.hoisted(() => ({ markGmailHandled: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock('../../services/ticketMailbox/googleMailboxClient', async (importActual) => {
  const actual = await importActual<typeof import('../../services/ticketMailbox/googleMailboxClient')>();
  return { ...actual, markGmailHandled: gm.markGmailHandled };
});

import { withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections, googleWorkspaceConnections, ticketEmailInbound } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';
import { encryptSecret } from '../../services/secretCrypto';
import { eq } from 'drizzle-orm';
import { markIngestedGmailHandled, parseGmailProviderMessageId } from '../../services/ticketMailbox/markIngestedGmailHandled';
import type { NormalizedInboundEmail } from '../../services/inboundEmail/types';

let db: any;
const MAILBOX = 'help@client.example';
const SUB = 'goog-sub-1';

async function seed(parseStatus: string | null, credentialStatus = 'active') {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const saKey = JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: 'k' });
    await db.insert(googleWorkspaceConnections).values({
      orgId: org.id, customerDomain: 'client.example', adminEmail: 'admin@client.example',
      serviceAccountEmail: 'sa@x.iam.gserviceaccount.com',
      serviceAccountKey: encryptSecret(saKey, { aad: 'google_workspace_connections.service_account_key' }),
      status: credentialStatus,
    });
    const [conn] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id, provider: 'gmail', orgId: org.id, googleAccountSub: SUB,
      mailboxAddress: MAILBOX, status: 'connected', historyId: 'H1', eligibleAfter: new Date(Date.now() - 3_600_000),
    }).returning({ id: ticketMailboxConnections.id, consentAttemptId: ticketMailboxConnections.consentAttemptId });
    const providerMessageId = `gmail:${SUB}:msg-123`;
    if (parseStatus) {
      await db.insert(ticketEmailInbound).values({ partnerId: partner.id, provider: 'gmail', providerMessageId, parseStatus });
    }
    const email = { provider: 'gmail', providerMessageId } as unknown as NormalizedInboundEmail;
    const generation = { provider: 'gmail' as const, connectionId: conn!.id, partnerId: partner.id, tenantId: null, consentAttemptId: conn!.consentAttemptId };
    return { email, generation, connId: conn!.id };
  });
}

const deps = { sleep: async () => {}, modifyClient: () => ({ fake: true }) as never };

describe('markIngestedGmailHandled (post-ticket, real DB)', () => {
  beforeEach(() => {
    db = getTestDb();
    vi.clearAllMocks();
    process.env.GMAIL_HANDLED_LABEL = 'Handled';
  });
  afterEach(() => {
    delete process.env.GMAIL_HANDLED_LABEL;
    delete process.env.GMAIL_ARCHIVE_ON_HANDLE;
  });

  it('parses the account sub and Gmail id from the provider message id', () => {
    expect(parseGmailProviderMessageId('gmail:sub:abc')).toEqual({ sub: 'sub', gmailId: 'abc' });
    expect(parseGmailProviderMessageId('<x@y>')).toBeNull();
  });

  it('labels (and archives by default) a message that became a ticket', async () => {
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledWith({ fake: true }, MAILBOX, 'msg-123', expect.objectContaining({ labelName: 'Handled', archive: true }));
  });

  it('labels a reply threaded onto an existing ticket (matched)', async () => {
    const { email, generation } = await seed('matched');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
  });

  it.each(['quarantined', 'ignored', 'failed', 'skipped'])('leaves %s mail untouched in the inbox', async (status) => {
    const { email, generation } = await seed(status);
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it.each([
    ['reconnected to a different Google account', { googleAccountSub: 'goog-sub-OTHER' }],
    ['consent generation rotated', { consentAttemptId: '99999999-9999-4999-8999-999999999999' }],
    ['connection disabled', { status: 'disabled' }],
  ])('never modifies mail when the mailbox was %s after ingestion', async (_label, patch) => {
    const { email, generation, connId } = await seed('created');
    await withSystemDbAccessContext(() => db.update(ticketMailboxConnections).set(patch as never).where(eq(ticketMailboxConnections.id, connId)));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('does nothing when the feature is off', async () => {
    delete process.env.GMAIL_HANDLED_LABEL;
    const { email, generation } = await seed('created');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('skipped');
    expect(gm.markGmailHandled).not.toHaveBeenCalled();
  });

  it('does nothing when the Google credential is inactive', async () => {
    const { email, generation } = await seed('created', 'inactive');
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('not_ticketed');
  });

  it('retries a transient failure, and gives up (never throws) on a missing grant', async () => {
    const { email, generation } = await seed('created');
    gm.markGmailHandled.mockRejectedValueOnce(Object.assign(new Error('backend'), { status: 503 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('marked');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(2);

    gm.markGmailHandled.mockReset();
    gm.markGmailHandled.mockRejectedValue(Object.assign(new Error('insufficient scope'), { status: 403 }));
    expect(await markIngestedGmailHandled(email, generation, deps)).toBe('failed');
    expect(gm.markGmailHandled).toHaveBeenCalledTimes(1);
  });
});
