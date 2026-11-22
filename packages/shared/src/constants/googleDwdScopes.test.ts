import { describe, expect, it } from 'vitest';
import {
  CALENDAR_SCOPES,
  DIRECTORY_DOMAIN_SCOPES,
  DIRECTORY_SCOPES,
  GMAIL_INBOUND_SCOPES,
  GMAIL_USER_SCOPES,
  GOOGLE_DWD_SCOPES_CSV,
  LICENSING_SCOPES,
} from './googleDwdScopes';

describe('GOOGLE_DWD_SCOPES_CSV', () => {
  it('is exactly the union of every scope set the API requests', () => {
    expect(GOOGLE_DWD_SCOPES_CSV.split(',')).toEqual([
      ...DIRECTORY_SCOPES,
      ...GMAIL_USER_SCOPES,
      ...GMAIL_INBOUND_SCOPES,
      ...CALENDAR_SCOPES,
      ...LICENSING_SCOPES,
      ...DIRECTORY_DOMAIN_SCOPES,
    ]);
  });

  it('carries the Gmail inbound read and identity scopes, never a write scope', () => {
    const scopes = GOOGLE_DWD_SCOPES_CSV.split(',');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.email');
    expect(GOOGLE_DWD_SCOPES_CSV).not.toContain('gmail.modify');
  });

  it('has no duplicate scopes', () => {
    const scopes = GOOGLE_DWD_SCOPES_CSV.split(',');
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it('GOOGLE_DWD_SCOPES_CSV includes admin.directory.domain.readonly exactly once', () => {
    const scopes = GOOGLE_DWD_SCOPES_CSV.split(',');
    expect(scopes.filter((s) => s === 'https://www.googleapis.com/auth/admin.directory.domain.readonly')).toHaveLength(1);
  });
});

describe('DIRECTORY_SCOPES', () => {
  it('DIRECTORY_SCOPES is unchanged (six scopes, no domain scope)', () => {
    expect([...DIRECTORY_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/admin.directory.user',
      'https://www.googleapis.com/auth/admin.directory.user.security',
      'https://www.googleapis.com/auth/admin.directory.user.alias',
      'https://www.googleapis.com/auth/admin.directory.group',
      'https://www.googleapis.com/auth/admin.directory.group.member',
      'https://www.googleapis.com/auth/admin.directory.device.mobile.action',
    ]);
  });
});
