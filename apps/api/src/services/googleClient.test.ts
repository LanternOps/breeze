import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  parseServiceAccountKey,
  normalizeGoogleError,
  GoogleApiError,
  ALL_DWD_SCOPES_CSV,
  DIRECTORY_SCOPES,
  GMAIL_USER_SCOPES,
  GMAIL_INBOUND_SCOPES,
  CALENDAR_SCOPES,
  LICENSING_SCOPES,
  getDirectoryClient,
  getGmailClient,
} from './googleClient';

const VALID_KEY = JSON.stringify({
  client_email: 'sa@proj.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n',
});

describe('parseServiceAccountKey', () => {
  it('parses a valid key', () => {
    const k = parseServiceAccountKey(VALID_KEY);
    expect(k.client_email).toBe('sa@proj.iam.gserviceaccount.com');
    expect(k.private_key).toContain('BEGIN PRIVATE KEY');
  });
  it('throws GoogleApiError on non-JSON', () => {
    expect(() => parseServiceAccountKey('not json')).toThrow(GoogleApiError);
  });
  it('throws when client_email/private_key missing', () => {
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'x' }))).toThrow(GoogleApiError);
  });
});

describe('normalizeGoogleError', () => {
  it('maps 403 to google_forbidden', () => {
    expect(normalizeGoogleError({ code: 403, message: 'no' }).code).toBe('google_forbidden');
  });
  it('maps 404 to google_not_found', () => {
    expect(normalizeGoogleError({ code: 404, message: 'gone' }).code).toBe('google_not_found');
  });
  it('maps 429 to google_rate_limited', () => {
    expect(normalizeGoogleError({ code: 429 }).code).toBe('google_rate_limited');
  });
  it('passes through a GoogleApiError', () => {
    const out = normalizeGoogleError(new GoogleApiError('invalid_service_account', 'bad key'));
    expect(out).toEqual({ code: 'invalid_service_account', message: 'bad key' });
  });
  it('falls back to google_error with the api message', () => {
    const out = normalizeGoogleError({ errors: [{ message: 'deep msg' }] });
    expect(out).toEqual({ code: 'google_error', message: 'deep msg' });
  });
});

describe('scopes', () => {
  it('CSV is the union of directory + gmail (user + inbound) + calendar + licensing scopes', () => {
    expect(ALL_DWD_SCOPES_CSV).toBe(
      [...DIRECTORY_SCOPES, ...GMAIL_USER_SCOPES, ...GMAIL_INBOUND_SCOPES, ...CALENDAR_SCOPES, ...LICENSING_SCOPES].join(','),
    );
    expect(ALL_DWD_SCOPES_CSV).toContain('admin.directory.user');
    expect(ALL_DWD_SCOPES_CSV).toContain('gmail.settings.sharing');
    expect(ALL_DWD_SCOPES_CSV).toContain('gmail.readonly'); // inbound connector read scope
    expect(ALL_DWD_SCOPES_CSV).not.toContain('gmail.modify'); // least privilege: the connector never writes
    expect(ALL_DWD_SCOPES_CSV).toContain('openid'); // inbound connector identity
    expect(ALL_DWD_SCOPES_CSV).toContain('userinfo.email');
    expect(ALL_DWD_SCOPES_CSV).toContain('apps.licensing');
    expect(ALL_DWD_SCOPES_CSV).toContain('calendar.acls');
  });
});

describe('client construction (smoke)', () => {
  it('builds a directory client without making a network call', () => {
    const client = getDirectoryClient(VALID_KEY, 'admin@example.com');
    expect(typeof client.users.get).toBe('function');
  });
  it('builds a gmail client without making a network call', () => {
    const client = getGmailClient(VALID_KEY, 'user@example.com');
    expect(typeof client.users.settings.updateVacation).toBe('function');
  });
});

describe('inbound mailbox scopes (mark-handled opt-in)', () => {
  it('the modify scope set is gmail.modify only and is NOT part of the default grant', async () => {
    const { GMAIL_INBOUND_MODIFY_SCOPES } = await import('./googleClient');
    expect([...GMAIL_INBOUND_MODIFY_SCOPES]).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    expect(ALL_DWD_SCOPES_CSV).not.toContain('gmail.modify');
  });

  it('the read session stays read-only (marking uses its own session)', async () => {
    const { getInboundMailboxSession } = await import('./googleClient');
    const session = getInboundMailboxSession(VALID_KEY, 'support@example.com');
    const scopes = (session.gmail as unknown as { context: { _options: { auth: { scopes: string[] } } } }).context._options.auth.scopes;
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).not.toContain('https://www.googleapis.com/auth/gmail.modify');
  });

  it('builds a modify session with gmail.modify plus identity scopes, never readonly', async () => {
    const { getInboundModifyGmailClient } = await import('./googleClient');
    const session = getInboundModifyGmailClient(VALID_KEY, 'support@example.com');
    const scopes = (session.gmail as unknown as { context: { _options: { auth: { scopes: string[] } } } }).context._options.auth.scopes;
    expect(scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
    expect(typeof session.gmail.users.messages.modify).toBe('function');
    expect(typeof session.identity).toBe('function');
  });

  it('applies a caller deadline signal to every request of the modify session', async () => {
    const { getInboundModifyGmailClient } = await import('./googleClient');
    const controller = new AbortController();
    const session = getInboundModifyGmailClient(VALID_KEY, 'support@example.com', controller.signal);
    const opts = (session.gmail as unknown as { context: { _options: { signal?: AbortSignal; timeout?: number } } }).context._options;
    expect(opts.signal).toBe(controller.signal);
    expect(opts.timeout).toBe(8_000);
  });

  it('aborts the identity (UserInfo) request at the caller deadline', async () => {
    const { getInboundModifyGmailClient } = await import('./googleClient');
    const { auth: gAuth } = await import('@googleapis/gmail');
    // Real auth.request path; only the token mint and the network hop are faked.
    // The fake transport never answers on its own: it settles only on abort.
    const probe = new gAuth.JWT({ email: 'x@y', key: 'k' }) as unknown as { transporter: object };
    const gaxiosProto = Object.getPrototypeOf(probe.transporter) as { _defaultAdapter: (c: { url?: unknown; signal?: AbortSignal }) => Promise<unknown> };
    const seenUrls: string[] = [];
    const adapter = vi.spyOn(gaxiosProto, '_defaultAdapter').mockImplementation((config) => new Promise((_resolve, reject) => {
      seenUrls.push(String(config.url));
      const signal = config.signal;
      if (!signal) return; // would hang until the test times out
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail);
    }));
    // getRequestMetadataAsync is protected, hence the structural cast.
    const jwtProto = gAuth.JWT.prototype as unknown as { getRequestMetadataAsync: () => Promise<unknown> };
    const metadata = vi.spyOn(jwtProto, 'getRequestMetadataAsync')
      .mockResolvedValue({ headers: new Headers({ authorization: 'Bearer t' }) });
    try {
      const session = getInboundModifyGmailClient(VALID_KEY, 'support@example.com', AbortSignal.timeout(200));
      const started = Date.now();
      await expect(session.identity()).rejects.toThrow();
      const elapsed = Date.now() - started;
      expect(seenUrls).toContain('https://openidconnect.googleapis.com/v1/userinfo');
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      adapter.mockRestore();
      metadata.mockRestore();
    }
  }, 5_000);
});
