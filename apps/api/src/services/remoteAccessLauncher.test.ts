import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildRemoteAccessLaunchUrl,
  resolveRemoteAccessLaunch,
  checkRemoteAccessLaunchAvailability,
} from './remoteAccessLauncher';
import { encryptSecret } from './secretCrypto';
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

  // -----------------------------------------------------------------------
  // Encryption-at-rest for the provider password (#716).
  //
  // `partners.settings` is registered in encryptedColumnRegistry.ts so the
  // password lives on disk as an `enc:v2:...` blob. The launcher must
  // decrypt before URL substitution, and must remain backwards-compatible
  // with pre-migration plaintext (decryptSecret is a no-op for non-`enc:`
  // values).
  // -----------------------------------------------------------------------
  describe('encryption-at-rest (#716)', () => {
    beforeAll(() => {
      // Force a deterministic 32-byte encryption key for the test process so
      // encryptSecret/decryptSecret round-trip without depending on the
      // global env config.
      if (!process.env.APP_ENCRYPTION_KEY) {
        process.env.APP_ENCRYPTION_KEY = 'test-only-app-encryption-key-32chars!';
      }
    });

    it('decrypts an enc:v2 password before substituting into the URL template', () => {
      const encrypted = encryptSecret('s3cret#1')!;
      expect(encrypted).toMatch(/^enc:/);

      const settings: InheritableRemoteAccessSettings = {
        defaultProviderId: 'rustdesk',
        providers: [{ ...baseProvider, password: encrypted }],
      };
      const url = buildRemoteAccessLaunchUrl(
        { customFields: { rustdesk_id: '42' } },
        settings,
      );
      // The encrypted blob must never reach the URL; the plaintext password
      // (with reserved characters percent-encoded) must be present.
      expect(url).toBe('rustdesk://42?password=s3cret%231');
      expect(url).not.toContain('enc:');
    });

    it('passes plaintext password through unchanged (backwards-compat for unmigrated rows)', () => {
      const settings: InheritableRemoteAccessSettings = {
        defaultProviderId: 'rustdesk',
        providers: [{ ...baseProvider, password: 'still-plaintext' }],
      };
      const url = buildRemoteAccessLaunchUrl(
        { customFields: { rustdesk_id: '42' } },
        settings,
      );
      expect(url).toBe('rustdesk://42?password=still-plaintext');
    });
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

describe('resolveRemoteAccessLaunch — per-technician provider preference', () => {
  const mesh = {
    id: 'mesh',
    name: 'Mesh',
    urlTemplate: 'https://mesh.example.test/#device={id}',
    customFieldKey: 'mesh_node_id',
    enabled: true,
  } as const;

  // Two providers enabled at once; the tenant default is rustdesk.
  const twoProviders: InheritableRemoteAccessSettings = {
    defaultProviderId: 'rustdesk',
    providers: [baseProvider, { ...mesh }],
  };
  const device = { customFields: { rustdesk_id: '294064193', mesh_node_id: 'abc123' } };

  it('uses the tenant default when the technician has no preference', () => {
    const r = resolveRemoteAccessLaunch(device, twoProviders);
    expect(r.providerId).toBe('rustdesk');
    expect(r.launchUrl).toBe('rustdesk://294064193?password=plain');
  });

  it('honours a preference for the OTHER enabled provider', () => {
    const r = resolveRemoteAccessLaunch(device, twoProviders, 'mesh');
    expect(r.providerId).toBe('mesh');
    expect(r.launchUrl).toBe('https://mesh.example.test/#device=abc123');
  });

  it('falls back to the default when the preference names an unknown provider', () => {
    // The security property: a preference SELECTS from the tenant's list, so an
    // id the tenant does not have cannot introduce a destination.
    const r = resolveRemoteAccessLaunch(device, twoProviders, 'not-a-real-provider');
    expect(r.providerId).toBe('rustdesk');
    expect(r.skipReason).toBeNull();
  });

  it('falls back to the default when the preferred provider is disabled', () => {
    const settings: InheritableRemoteAccessSettings = {
      defaultProviderId: 'rustdesk',
      providers: [baseProvider, { ...mesh, enabled: false }],
    };
    const r = resolveRemoteAccessLaunch(device, settings, 'mesh');
    // Degrades quietly rather than returning provider_disabled and stranding the tech.
    expect(r.providerId).toBe('rustdesk');
    expect(r.skipReason).toBeNull();
  });

  it('lets a valid preference stand in when the tenant has set no default', () => {
    const noDefault: InheritableRemoteAccessSettings = { providers: [baseProvider, { ...mesh }] };
    expect(resolveRemoteAccessLaunch(device, noDefault).skipReason).toBe('no_provider_configured');
    const r = resolveRemoteAccessLaunch(device, noDefault, 'mesh');
    expect(r.providerId).toBe('mesh');
    expect(r.launchUrl).toBe('https://mesh.example.test/#device=abc123');
  });

  it('still refuses a scheme that only resolves after substitution, even when preferred', () => {
    const sneaky: InheritableRemoteAccessSettings = {
      defaultProviderId: 'rustdesk',
      providers: [
        baseProvider,
        { id: 'sneaky', name: 'Sneaky', urlTemplate: 'j{id}cript:alert(1)', customFieldKey: 'k', enabled: true },
      ],
    };
    const r = resolveRemoteAccessLaunch({ customFields: { k: 'avas' } }, sneaky, 'sneaky');
    expect(r.launchUrl).toBeNull();
    expect(r.skipReason).toBe('scheme_not_allowed');
  });
});

// -----------------------------------------------------------------------
// checkRemoteAccessLaunchAvailability (#3402)
//
// The availability check is the ONLY launcher entry point GET
// /devices/:id may call. It must never decrypt or substitute (covered by
// a spy in core.remoteAccessLaunch.test.ts), and it must agree with
// resolveRemoteAccessLaunch (issuance) on every skip reason EXCEPT
// 'scheme_not_allowed', which by construction only exists once the
// template has actually been substituted with the real password -- work
// availability deliberately never does.
// -----------------------------------------------------------------------
describe('checkRemoteAccessLaunchAvailability — parity with issuance', () => {
  const scenarios: Array<{
    name: string;
    device: { customFields?: Record<string, unknown> | null };
    settings: InheritableRemoteAccessSettings | undefined;
    preferredProviderId?: string | null;
  }> = [
    {
      name: 'no settings at all',
      device: { customFields: { rustdesk_id: '1' } },
      settings: undefined,
    },
    {
      name: 'empty settings object',
      device: { customFields: { rustdesk_id: '1' } },
      settings: {},
    },
    {
      name: 'unknown defaultProviderId',
      device: { customFields: { rustdesk_id: '1' } },
      settings: { ...rustdeskSettings, defaultProviderId: 'nonexistent' },
    },
    {
      name: 'default provider disabled',
      device: { customFields: { rustdesk_id: '1' } },
      settings: { ...rustdeskSettings, providers: [{ ...baseProvider, enabled: false }] },
    },
    {
      name: 'device missing the custom field the provider needs',
      device: { customFields: {} },
      settings: rustdeskSettings,
    },
    {
      name: 'device custom field is an empty string',
      device: { customFields: { rustdesk_id: '' } },
      settings: rustdeskSettings,
    },
    {
      name: 'empty url template',
      device: { customFields: { rustdesk_id: '1' } },
      settings: { ...rustdeskSettings, providers: [{ ...baseProvider, urlTemplate: '' }] },
    },
    {
      name: 'happy path — resolves',
      device: { customFields: { rustdesk_id: '294064193' } },
      settings: rustdeskSettings,
    },
    {
      name: 'preference falls back to default (unknown preferred id)',
      device: { customFields: { rustdesk_id: '294064193' } },
      settings: rustdeskSettings,
      preferredProviderId: 'not-a-real-provider',
    },
    {
      name: 'preference selects the other enabled provider',
      device: { customFields: { rustdesk_id: '294064193', mesh_node_id: 'abc123' } },
      settings: {
        defaultProviderId: 'rustdesk',
        providers: [
          baseProvider,
          {
            id: 'mesh',
            name: 'Mesh',
            urlTemplate: 'https://mesh.example.test/#device={id}',
            customFieldKey: 'mesh_node_id',
            enabled: true,
          },
        ],
      },
      preferredProviderId: 'mesh',
    },
  ];

  it.each(scenarios)('$name: availability and issuance agree', ({ device, settings, preferredProviderId }) => {
    const availability = checkRemoteAccessLaunchAvailability(device, settings, preferredProviderId);
    const issuance = resolveRemoteAccessLaunch(device, settings, preferredProviderId);

    expect(availability.skipReason).toBe(issuance.skipReason);
    expect(availability.providerId).toBe(issuance.providerId);
    expect(availability.available).toBe(issuance.launchUrl !== null);
  });

  it('never returns scheme_not_allowed — that is issuance-only, since it requires substitution', () => {
    const sneaky: InheritableRemoteAccessSettings = {
      defaultProviderId: 'sneaky',
      providers: [
        { id: 'sneaky', name: 'Sneaky', urlTemplate: 'j{id}cript:alert(1)', customFieldKey: 'k', enabled: true },
      ],
    };
    const device = { customFields: { k: 'avas' } };

    const availability = checkRemoteAccessLaunchAvailability(device, sneaky);
    expect(availability.available).toBe(true);
    expect(availability.skipReason).toBeNull();

    // Issuance, which DOES substitute, catches the tampered template.
    const issuance = resolveRemoteAccessLaunch(device, sneaky);
    expect(issuance.skipReason).toBe('scheme_not_allowed');
    expect(issuance.launchUrl).toBeNull();
  });

  it('reports available:true with the resolved providerId on the happy path', () => {
    const availability = checkRemoteAccessLaunchAvailability(
      { customFields: { rustdesk_id: '294064193' } },
      rustdeskSettings,
    );
    expect(availability).toEqual({ available: true, providerId: 'rustdesk', skipReason: null });
  });
});
