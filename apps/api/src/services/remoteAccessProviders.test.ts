import { describe, expect, it } from 'vitest';
import { toProviderSummaries } from './remoteAccessProviders';

// The projection is the security property of this whole feature: the endpoint
// exists so a technician's provider chooser stops reading the partner settings
// blob, which carries urlTemplate / customFieldKey / password (#3404).

const FULL_PROVIDER = {
  id: 'p1',
  name: 'ScreenConnect',
  urlTemplate: 'sc://connect/{{customField}}?pw={{password}}',
  customFieldKey: 'sc_id',
  password: 'super-secret',
  enabled: true,
};

describe('toProviderSummaries', () => {
  it('emits id/name/enabled and NOTHING else', () => {
    const { providers } = toProviderSummaries({ providers: [FULL_PROVIDER] });

    expect(providers).toHaveLength(1);
    // exact key set — a spread that started leaking a new credential field
    // would add a key here and fail
    expect(Object.keys(providers[0]!).sort()).toEqual(['enabled', 'id', 'name']);
  });

  it('never leaks the credential-bearing fields, checked by value', () => {
    const serialized = JSON.stringify(toProviderSummaries({ providers: [FULL_PROVIDER] }));

    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('sc://connect');
    expect(serialized).not.toContain('sc_id');
  });

  it('keeps disabled providers but reports them as disabled', () => {
    // The chooser needs to render them greyed rather than silently omit them,
    // so a tech can see why their tool is unavailable.
    const { providers } = toProviderSummaries({
      providers: [FULL_PROVIDER, { ...FULL_PROVIDER, id: 'p2', name: 'RustDesk', enabled: false }],
    });

    expect(providers.map((p) => [p.id, p.enabled])).toEqual([
      ['p1', true],
      ['p2', false],
    ]);
  });

  it('reports the tenant default when it names a visible provider', () => {
    const { defaultProviderId } = toProviderSummaries({
      providers: [FULL_PROVIDER],
      defaultProviderId: 'p1',
    });
    expect(defaultProviderId).toBe('p1');
  });

  it('drops a dangling default rather than naming a provider that is not there', () => {
    // #3401: dangling defaultProviderId is creatable today. Reporting it would
    // render a selected option the chooser has no entry for.
    const { defaultProviderId } = toProviderSummaries({
      providers: [FULL_PROVIDER],
      defaultProviderId: 'does-not-exist',
    });
    expect(defaultProviderId).toBeNull();
  });

  it('is empty and non-throwing for a tenant with no remote access configured', () => {
    expect(toProviderSummaries(undefined)).toEqual({ providers: [], defaultProviderId: null });
    expect(toProviderSummaries({})).toEqual({ providers: [], defaultProviderId: null });
  });

  it('tolerates a malformed providers payload without throwing', () => {
    // partners.settings is jsonb: nothing guarantees the shape at read time.
    expect(toProviderSummaries({ providers: 'nonsense' as never })).toEqual({
      providers: [],
      defaultProviderId: null,
    });
    const { providers } = toProviderSummaries({
      providers: [null as never, { id: '', name: 'x', enabled: true } as never, FULL_PROVIDER],
    });
    expect(providers.map((p) => p.id)).toEqual(['p1']);
  });
});
