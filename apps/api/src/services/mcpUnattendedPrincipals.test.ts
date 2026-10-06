import { describe, expect, it } from 'vitest';
import { canonicalPrincipalRef, parseUnattendedPrincipals } from './mcpUnattendedPrincipals';

const KEY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

describe('parseUnattendedPrincipals (shared by the boot warning and the runtime gate)', () => {
  it('canonicalises UUIDs to lowercase so an uppercase entry matches the stored id', () => {
    const { principals, malformed } = parseUnattendedPrincipals(`api_key:${KEY.toUpperCase()}`);
    expect(malformed).toEqual([]);
    expect(principals.has(canonicalPrincipalRef('api_key', KEY)!)).toBe(true);
  });

  it('accepts an OAuth client_id containing "/" by splitting the user id at the last "/"', () => {
    const { principals, malformed } = parseUnattendedPrincipals(`oauth_client_user:agent/client/${USER}`);
    expect(malformed).toEqual([]);
    expect(principals.has(canonicalPrincipalRef('oauth_client_user', 'agent/client', USER)!)).toBe(true);
    // The client_id itself is compared exactly.
    expect(principals.has(canonicalPrincipalRef('oauth_client_user', 'AGENT/client', USER)!)).toBe(false);
  });

  it('reports entries that can never match as malformed, and matches none of them', () => {
    const raw = 'api_key:ok-1, apikey:typo, oauth_client_user:client-only, oauth_client_user:c/not-a-uuid, oauth_client_user:/'+USER+', client-b/user';
    const { principals, malformed } = parseUnattendedPrincipals(raw);
    expect(principals.size).toBe(0);
    expect(malformed).toEqual(['api_key:ok-1', 'apikey:typo', 'oauth_client_user:client-only', 'oauth_client_user:c/not-a-uuid', `oauth_client_user:/${USER}`, 'client-b/user']);
  });

  it('accepts partner_sp:<principal id> and keeps it distinct from an api_key entry with the same id', () => {
    const { principals, malformed } = parseUnattendedPrincipals(`partner_sp:${KEY.toUpperCase()}`);
    expect(malformed).toEqual([]);
    expect(principals.has(canonicalPrincipalRef('partner_sp', KEY)!)).toBe(true);
    // A key id listed as api_key:<id> must never match a partner principal, and the reverse.
    expect(principals.has(canonicalPrincipalRef('api_key', KEY)!)).toBe(false);
    expect(parseUnattendedPrincipals(`api_key:${KEY}`).principals.has(canonicalPrincipalRef('partner_sp', KEY)!)).toBe(false);
  });

  it('reports a malformed partner_sp entry and matches nothing', () => {
    const { principals, malformed } = parseUnattendedPrincipals('partner_sp:not-a-uuid, partner_sp:, partnersp:' + KEY);
    expect(principals.size).toBe(0);
    expect(malformed).toEqual(['partner_sp:not-a-uuid', 'partner_sp:', `partnersp:${KEY}`]);
  });

  it('is empty for unset or blank input', () => {
    expect(parseUnattendedPrincipals(undefined)).toEqual({ principals: new Set(), malformed: [] });
    expect(parseUnattendedPrincipals(' , ')).toEqual({ principals: new Set(), malformed: [] });
  });

  it('canonicalPrincipalRef returns null for non-UUID ids (they can never be configured)', () => {
    expect(canonicalPrincipalRef('api_key', 'key-1')).toBeNull();
    expect(canonicalPrincipalRef('partner_sp', 'principal-1')).toBeNull();
    expect(canonicalPrincipalRef('oauth_client_user', 'client', 'user-1')).toBeNull();
  });
});
