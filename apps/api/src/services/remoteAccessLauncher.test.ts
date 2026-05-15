import { describe, it, expect } from 'vitest';
import { buildRemoteAccessLaunchUrl, resolveRemoteAccessLaunch } from './remoteAccessLauncher';
import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';

const baseProvider: RemoteAccessProvider = {
  id: 'rustdesk',
  name: 'RustDesk',
  urlTemplate: 'rustdesk://{id}?password={password}',
  customFieldKey: 'rustdesk_id',
  password: 'plain',
  enabled: true,
};

const rustdeskSettings: InheritableRemoteAccessSettings = {
  defaultProviderId: 'rustdesk',
  providers: [baseProvider],
};

describe('buildRemoteAccessLaunchUrl', () => {
  it('substitutes {id} and {password} into a custom-scheme template', () => {
    const url = buildRemoteAccessLaunchUrl(
      { customFields: { rustdesk_id: '294064193' } },
      rustdeskSettings,
    );
    expect(url).toBe('rustdesk://294064193?password=plain');
  });

  it('passes through templates with no {password} placeholder (e.g. ScreenConnect HTTPS launcher)', () => {
    const sc: InheritableRemoteAccessSettings = {
      defaultProviderId: 'sc',
      providers: [
        {
          id: 'sc',
          name: 'ScreenConnect',
          urlTemplate: 'https://acme.screenconnect.com/Host#Access///{id}/Join',
          customFieldKey: 'sc_session_id',
          enabled: true,
        },
      ],
    };
    const url = buildRemoteAccessLaunchUrl(
      { customFields: { sc_session_id: '0b58bbd8-0102-479b-a42c-84245fb164db' } },
      sc,
    );
    expect(url).toBe('https://acme.screenconnect.com/Host#Access///0b58bbd8-0102-479b-a42c-84245fb164db/Join');
  });

  it('substitutes empty string when password is unset and template references {password}', () => {
    const noPw: InheritableRemoteAccessSettings = {
      ...rustdeskSettings,
      providers: [{ ...baseProvider, password: undefined }],
    };
    const url = buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '42' } }, noPw);
    expect(url).toBe('rustdesk://42?password=');
  });

  it('percent-encodes URL-reserved characters in the password (#, &, =, +, etc.)', () => {
    const tricky: InheritableRemoteAccessSettings = {
      ...rustdeskSettings,
      providers: [
        {
          ...baseProvider,
          password: 'a#b&c=d+e<f>g{h}i(j)k',
        },
      ],
    };
    const url = buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: 'X' } }, tricky);
    expect(url).toBe(
      'rustdesk://X?password=a%23b%26c%3Dd%2Be%3Cf%3Eg%7Bh%7Di(j)k',
    );
  });

  it('percent-encodes the device id (defends against ids with reserved characters)', () => {
    const url = buildRemoteAccessLaunchUrl(
      { customFields: { rustdesk_id: 'has space&amp' } },
      rustdeskSettings,
    );
    expect(url).toBe('rustdesk://has%20space%26amp?password=plain');
  });

  it('substitutes every occurrence of {id} (replaceAll, not just the first)', () => {
    const dup: InheritableRemoteAccessSettings = {
      defaultProviderId: 'dup',
      providers: [
        {
          id: 'dup',
          name: 'Echo',
          urlTemplate: 'https://example.com/{id}/redirect-to/{id}',
          customFieldKey: 'k',
          enabled: true,
        },
      ],
    };
    const url = buildRemoteAccessLaunchUrl({ customFields: { k: 'X' } }, dup);
    expect(url).toBe('https://example.com/X/redirect-to/X');
  });

  it('returns null when no provider is configured', () => {
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '1' } }, undefined),
    ).toBeNull();
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '1' } }, {}),
    ).toBeNull();
  });

  it('returns null when default provider is unknown or disabled', () => {
    expect(
      buildRemoteAccessLaunchUrl(
        { customFields: { rustdesk_id: '1' } },
        { ...rustdeskSettings, defaultProviderId: 'nonexistent' },
      ),
    ).toBeNull();

    const disabled: InheritableRemoteAccessSettings = {
      ...rustdeskSettings,
      providers: [{ ...baseProvider, enabled: false }],
    };
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '1' } }, disabled),
    ).toBeNull();
  });

  it('returns null when device is missing the configured custom field', () => {
    expect(buildRemoteAccessLaunchUrl({ customFields: null }, rustdeskSettings)).toBeNull();
    expect(buildRemoteAccessLaunchUrl({ customFields: {} }, rustdeskSettings)).toBeNull();
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '' } }, rustdeskSettings),
    ).toBeNull();
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: 42 as unknown as string } }, rustdeskSettings),
    ).toBeNull();
  });

  it('returns null when urlTemplate is empty', () => {
    const empty: InheritableRemoteAccessSettings = {
      ...rustdeskSettings,
      providers: [{ ...baseProvider, urlTemplate: '' }],
    };
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { rustdesk_id: '1' } }, empty),
    ).toBeNull();
  });

  it('resolveRemoteAccessLaunch reports skipReason=no_provider_configured when settings empty', () => {
    expect(resolveRemoteAccessLaunch({ customFields: {} }, undefined).skipReason).toBe('no_provider_configured');
    expect(resolveRemoteAccessLaunch({ customFields: {} }, {}).skipReason).toBe('no_provider_configured');
  });

  it('resolveRemoteAccessLaunch reports skipReason=provider_disabled when default provider is disabled', () => {
    const disabled: InheritableRemoteAccessSettings = {
      ...rustdeskSettings,
      providers: [{ ...baseProvider, enabled: false }],
    };
    const r = resolveRemoteAccessLaunch({ customFields: { rustdesk_id: '1' } }, disabled);
    expect(r.skipReason).toBe('provider_disabled');
    expect(r.providerId).toBe('rustdesk');
  });

  it('resolveRemoteAccessLaunch reports skipReason=missing_device_identifier when custom field absent', () => {
    const r = resolveRemoteAccessLaunch({ customFields: {} }, rustdeskSettings);
    expect(r.skipReason).toBe('missing_device_identifier');
    expect(r.providerId).toBe('rustdesk');
  });

  it('resolveRemoteAccessLaunch reports skipReason=scheme_not_allowed when substituted URL has disallowed scheme', () => {
    const sneaky: InheritableRemoteAccessSettings = {
      defaultProviderId: 'sneaky',
      providers: [
        {
          id: 'sneaky',
          name: 'Sneaky',
          urlTemplate: 'j{id}cript:alert(1)',
          customFieldKey: 'k',
          enabled: true,
        },
      ],
    };
    const r = resolveRemoteAccessLaunch({ customFields: { k: 'avas' } }, sneaky);
    expect(r.skipReason).toBe('scheme_not_allowed');
    expect(r.launchUrl).toBeNull();
    expect(r.providerId).toBe('sneaky');
  });

  it('resolveRemoteAccessLaunch returns scheme alongside launchUrl on success', () => {
    const r = resolveRemoteAccessLaunch(
      { customFields: { rustdesk_id: '294064193' } },
      rustdeskSettings,
    );
    expect(r.launchUrl).toBe('rustdesk://294064193?password=plain');
    expect(r.scheme).toBe('rustdesk');
    expect(r.providerId).toBe('rustdesk');
    expect(r.skipReason).toBeNull();
  });

  it('refuses templates whose substituted URL resolves to a disallowed scheme', () => {
    // `j{id}cript:foo` passes the template-time scheme check (scheme is `j`,
    // not in the denylist) but resolves to `javascript:foo` once the device
    // id is substituted. The substituted-URL guard inside
    // buildRemoteAccessLaunchUrl must catch this and return null.
    const sneaky: InheritableRemoteAccessSettings = {
      defaultProviderId: 'sneaky',
      providers: [
        {
          id: 'sneaky',
          name: 'Sneaky',
          urlTemplate: 'j{id}cript:alert(1)',
          customFieldKey: 'k',
          enabled: true,
        },
      ],
    };
    expect(
      buildRemoteAccessLaunchUrl({ customFields: { k: 'avas' } }, sneaky),
    ).toBeNull();
  });
});
