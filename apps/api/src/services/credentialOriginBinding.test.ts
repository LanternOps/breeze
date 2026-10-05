import { describe, expect, it } from 'vitest';
import {
  destinationSetGainedMembers,
  launcherTemplateOriginChanged,
  settingsSecretWouldFollowNewOrigin,
  urlOriginChanged,
  webhookOriginChangeWouldRetainAuthorization,
} from './credentialOriginBinding';
import { isMaskedIntegrationSecret } from './notificationChannelSecrets';
import {
  LOG_FORWARDING_SECRET_DESTINATIONS,
  REMOTE_ACCESS_LAUNCHER_SECRET_DESTINATIONS,
} from './settingsSecretMasking';

describe('destinationSetGainedMembers', () => {
  it('is false when the set is unchanged', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('is false for pure narrowing (removal only)', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('is false when narrowing to empty', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], [])).toBe(false);
  });

  it('is true when a member is added alongside an unchanged member', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24', '10.0.1.0/24'])).toBe(true);
  });

  it('is true for a net change even when some entries are dropped (added and removed)', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.0.0/24', '10.0.5.0/24'])).toBe(true);
  });

  it('treats a CIDR prefix widening as a different string and so a gain, even though it is a superset', () => {
    // No CIDR-aware containment logic: '10.0.0.0/23' is not byte-identical to
    // '10.0.0.0/24', so it is treated as a new member. This is the
    // safe-by-construction direction (over-block, never under-block).
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/23'])).toBe(true);
  });

  it('treats a bare IP and its /32 form as different members (over-blocks, safe direction)', () => {
    expect(destinationSetGainedMembers(['10.0.0.5'], ['10.0.0.5/32'])).toBe(true);
  });

  it('is false for a shuffled but identical set', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.1.0/24'], ['10.0.1.0/24', '10.0.0.0/24'])).toBe(false);
  });

  it('trims whitespace before comparing', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], [' 10.0.0.0/24 '])).toBe(false);
    expect(destinationSetGainedMembers([' 10.0.0.0/24 '], ['10.0.0.0/24'])).toBe(false);
  });

  it('ignores duplicate entries in next that are already present', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24'], ['10.0.0.0/24', '10.0.0.0/24'])).toBe(false);
  });

  it('ignores duplicate entries in existing', () => {
    expect(destinationSetGainedMembers(['10.0.0.0/24', '10.0.0.0/24'], ['10.0.0.0/24'])).toBe(false);
  });

  it('handles IPv6 addresses and CIDRs the same way as IPv4', () => {
    expect(destinationSetGainedMembers(['2001:db8::/64'], ['2001:db8::/64'])).toBe(false);
    expect(destinationSetGainedMembers(['2001:db8::/64'], ['2001:db8::/32'])).toBe(true);
    expect(destinationSetGainedMembers(['2001:db8::/64', '2001:db8:1::/64'], ['2001:db8::/64'])).toBe(false);
  });

  it('is case-sensitive for hostnames (over-blocks on case difference, safe direction)', () => {
    expect(destinationSetGainedMembers(['Printer.Local'], ['printer.local'])).toBe(true);
  });

  it('is false for an empty existing and empty next set', () => {
    expect(destinationSetGainedMembers([], [])).toBe(false);
  });

  it('is true for any member when existing is empty', () => {
    expect(destinationSetGainedMembers([], ['10.0.0.0/24'])).toBe(true);
  });
});

describe('urlOriginChanged', () => {
  it.each([
    ['https://EXAMPLE.com/path', 'https://example.com/other', false],
    ['https://example.com:443/path', 'https://example.com/other', false],
    ['http://example.com/path', 'https://example.com/path', true],
    ['https://example.com/path', 'https://example.com:8443/path', true],
    ['https://example.com/path', 'https://other.example/path', true],
    ['not-a-url', 'https://example.com/path', true],
  ])('%s -> %s changed=%s', (current, next, changed) => {
    expect(urlOriginChanged(current, next)).toBe(changed);
  });
});

describe('webhookOriginChangeWouldRetainAuthorization', () => {
  const isMasked = (value: unknown) => typeof value === 'string' && /^\*+$/.test(value);

  it('fails closed when a destination is first assigned to stored authorization', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token' },
      { url: 'https://receiver.example/hook' },
      isMasked,
    )).toBe(true);
  });

  it('allows a first destination when stored authorization is explicitly cleared', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token', headers: { Authorization: 'stored-header' } },
      { url: 'https://receiver.example/hook', authToken: null, headers: {} },
      isMasked,
    )).toBe(false);
  });

  // #4983: the edit form sends the masked URL back when the operator did not
  // touch it. The merge keeps the stored URL, so the origin has not changed and
  // the stored (masked) authorization and headers may stay.
  it('treats a masked url as the stored destination, not an origin change', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { url: 'https://receiver.example/hook', authPassword: 'stored-pass', headers: { 'X-Api-Key': 'stored-key' } },
      { url: '********', authPassword: '********', headers: { 'X-Api-Key': '********' } },
      isMasked,
    )).toBe(false);
  });

  it('still fails closed on a masked url when no destination is stored', () => {
    expect(webhookOriginChangeWouldRetainAuthorization(
      { authToken: 'stored-token' },
      { url: '********', authToken: '********' },
      isMasked,
    )).toBe(true);
  });
});

describe('settingsSecretWouldFollowNewOrigin', () => {
  const stored = {
    eventLogs: { elasticsearchUrl: 'https://es.trusted.example', elasticsearchApiKey: 'enc:v1:stored-api-key-ciphertext' },
    logForwarding: { elasticsearchUrl: 'https://logs.trusted.example', elasticsearchPassword: 'enc:v1:stored-password-ciphertext' },
  };
  const check = (incoming: unknown) =>
    settingsSecretWouldFollowNewOrigin(incoming, stored, LOG_FORWARDING_SECRET_DESTINATIONS, isMaskedIntegrationSecret);

  it('is true when the URL origin changes and the secret is kept by the masked marker', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: '********' } })).toBe(true);
  });

  it('is true when the URL origin changes and the secret is kept by omission', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example' } })).toBe(true);
  });

  it('is true when the URL origin changes and the stored ciphertext is echoed', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: 'enc:v1:stored-api-key-ciphertext' } })).toBe(true);
  });

  it('covers the logForwarding destination the same way', () => {
    expect(check({ logForwarding: { elasticsearchUrl: 'https://logs.other.example', elasticsearchPassword: '********' } })).toBe(true);
  });

  it('is false when a fresh secret is typed alongside the new URL', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: 'typed-key' } })).toBe(false);
  });

  it('is false when the secret is cleared alongside the new URL', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.other.example', elasticsearchApiKey: '' } })).toBe(false);
  });

  it('is false when only the path changes within the same origin', () => {
    expect(check({ eventLogs: { elasticsearchUrl: 'https://es.trusted.example/new-path', elasticsearchApiKey: '********' } })).toBe(false);
  });

  it('is false when the category or the URL is absent from the request', () => {
    expect(check({ branding: {} })).toBe(false);
    expect(check({ eventLogs: { enabled: false, elasticsearchApiKey: '********' } })).toBe(false);
  });

  it('fails closed when a secret is stored but no destination URL was recorded for it', () => {
    expect(settingsSecretWouldFollowNewOrigin(
      { eventLogs: { elasticsearchUrl: 'https://es.new.example', elasticsearchApiKey: '********' } },
      { eventLogs: { elasticsearchApiKey: 'enc:v1:stored-api-key-ciphertext' } },
      LOG_FORWARDING_SECRET_DESTINATIONS,
      isMaskedIntegrationSecret,
    )).toBe(true);
  });

  it('is false when nothing is stored to carry', () => {
    expect(settingsSecretWouldFollowNewOrigin(
      { eventLogs: { elasticsearchUrl: 'https://es.new.example' } },
      {},
      LOG_FORWARDING_SECRET_DESTINATIONS,
      isMaskedIntegrationSecret,
    )).toBe(false);
  });
});

describe('launcherTemplateOriginChanged', () => {
  it('is false for an identical template, including custom schemes', () => {
    expect(launcherTemplateOriginChanged('rustdesk://{id}?password={password}', 'rustdesk://{id}?password={password}')).toBe(false);
  });

  it('is false when only the path, query or fragment changes', () => {
    expect(launcherTemplateOriginChanged(
      'https://acme.screenconnect.com/Host#Access///{id}/Join',
      'https://acme.screenconnect.com/Other?x=1#Access///{id}/Join',
    )).toBe(false);
    expect(launcherTemplateOriginChanged('rustdesk://{id}?password={password}', 'rustdesk://{id}')).toBe(false);
  });

  it('is true when the host changes', () => {
    expect(launcherTemplateOriginChanged(
      'https://acme.screenconnect.com/Host#Access///{id}/Join',
      'https://other.example.com/Host#Access///{id}/Join',
    )).toBe(true);
  });

  it('is true when the scheme changes', () => {
    expect(launcherTemplateOriginChanged('https://acme.example/{id}', 'http://acme.example/{id}')).toBe(true);
    expect(launcherTemplateOriginChanged('rustdesk://{id}?password={password}', 'anydesk://{id}?password={password}')).toBe(true);
  });

  it('is true when the port changes', () => {
    expect(launcherTemplateOriginChanged('https://acme.example/{id}', 'https://acme.example:8443/{id}')).toBe(true);
  });

  it('is true when the host placeholder moves (custom scheme)', () => {
    expect(launcherTemplateOriginChanged('rustdesk://{id}?password={password}', 'rustdesk://relay.example/{id}?password={password}')).toBe(true);
  });

  it('fails closed (changed) when either template cannot be parsed', () => {
    expect(launcherTemplateOriginChanged('https://acme.example/{id}', 'not a url {id}')).toBe(true);
    expect(launcherTemplateOriginChanged('not a url {id}', 'https://acme.example/{id}')).toBe(true);
  });
});

describe('settingsSecretWouldFollowNewOrigin — remote-access launcher passwords', () => {
  const provider = (overrides: Record<string, unknown> = {}) => ({
    id: 'sc',
    name: 'ScreenConnect',
    urlTemplate: 'https://acme.screenconnect.com/Host#Access///{id}/Join?p={password}',
    customFieldKey: 'sc_id',
    enabled: true,
    ...overrides,
  });
  const stored = { remoteAccessProviders: { providers: [provider({ password: 'enc:v1:stored-launcher-password' })] } };
  const check = (providers: unknown[]) => settingsSecretWouldFollowNewOrigin(
    { remoteAccessProviders: { providers } },
    stored,
    REMOTE_ACCESS_LAUNCHER_SECRET_DESTINATIONS,
    isMaskedIntegrationSecret,
  );
  const otherHost = 'https://other.example.com/Host#Access///{id}/Join?p={password}';

  it('is true when the template host changes and the password is kept by the masked marker', () => {
    expect(check([provider({ urlTemplate: otherHost, password: '********' })])).toBe(true);
  });

  it('is true when the template host changes and the password is kept by omission', () => {
    expect(check([provider({ urlTemplate: otherHost })])).toBe(true);
  });

  it('is true when the template host changes and the stored ciphertext is echoed', () => {
    expect(check([provider({ urlTemplate: otherHost, password: 'enc:v1:stored-launcher-password' })])).toBe(true);
  });

  it('matches entries by id, not position', () => {
    expect(check([
      provider({ id: 'rd', urlTemplate: 'rustdesk://{id}', password: 'typed' }),
      provider({ urlTemplate: otherHost, password: '********' }),
    ])).toBe(true);
  });

  it('is false when a fresh password is typed alongside the new template', () => {
    expect(check([provider({ urlTemplate: otherHost, password: 'typed-password' })])).toBe(false);
  });

  it('is false when the template keeps its host', () => {
    expect(check([provider({ urlTemplate: 'https://acme.screenconnect.com/Other#Access///{id}/Join', password: '********' })])).toBe(false);
  });

  it('is false for an unchanged custom-scheme template with a masked password', () => {
    const rustdesk = provider({ id: 'rd', urlTemplate: 'rustdesk://{id}?password={password}' });
    expect(settingsSecretWouldFollowNewOrigin(
      { remoteAccessProviders: { providers: [{ ...rustdesk, password: '********' }] } },
      { remoteAccessProviders: { providers: [{ ...rustdesk, password: 'enc:v1:stored' }] } },
      REMOTE_ACCESS_LAUNCHER_SECRET_DESTINATIONS,
      isMaskedIntegrationSecret,
    )).toBe(false);
  });

  it('is false for a new provider id (no stored password to carry)', () => {
    expect(check([provider({ id: 'new', urlTemplate: otherHost, password: '********' })])).toBe(false);
  });
});
