import { describe, it, expect } from 'vitest';
import {
  parseServiceAccountKey,
  normalizeGoogleError,
  GoogleApiError,
  ALL_DWD_SCOPES_CSV,
  DIRECTORY_SCOPES,
  GMAIL_USER_SCOPES,
  CALENDAR_SCOPES,
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
  it('CSV is the union of directory + gmail + calendar scopes', () => {
    expect(ALL_DWD_SCOPES_CSV).toBe(
      [...DIRECTORY_SCOPES, ...GMAIL_USER_SCOPES, ...CALENDAR_SCOPES].join(','),
    );
    expect(ALL_DWD_SCOPES_CSV).toContain('admin.directory.user');
    expect(ALL_DWD_SCOPES_CSV).toContain('gmail.settings.sharing');
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
