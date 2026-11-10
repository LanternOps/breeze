import { describe, expect, it } from 'vitest';
import { countUnmappedSites } from './unifiMappingHosts';

describe('countUnmappedSites', () => {
  it('keys by host, so the same site id under two hosts counts twice', () => {
    const sites = [{ hostId: 'h1', id: 'default' }, { hostId: 'h2', id: 'default' }];
    expect(countUnmappedSites(sites, [])).toBe(2);
    expect(countUnmappedSites(sites, [{ unifiHostId: 'h1', unifiSiteId: 'default' }])).toBe(1);
  });

  it('a mapping on another host does not cover the site', () => {
    expect(countUnmappedSites([{ hostId: 'h1', id: 's1' }], [{ unifiHostId: 'h2', unifiSiteId: 's1' }])).toBe(1);
  });

  it('every site mapped is zero, and a mapping for a site no longer listed changes nothing', () => {
    const sites = [{ hostId: 'h1', id: 's1' }, { hostId: 'h1', id: 's2' }];
    const mappings = [
      { unifiHostId: 'h1', unifiSiteId: 's1' },
      { unifiHostId: 'h1', unifiSiteId: 's2' },
      { unifiHostId: 'h1', unifiSiteId: 'gone' },
    ];
    expect(countUnmappedSites(sites, mappings)).toBe(0);
  });

  it('counts a site listed twice once', () => {
    expect(countUnmappedSites([{ hostId: 'h1', id: 's1' }, { hostId: 'h1', id: 's1' }], [])).toBe(1);
  });

  it('leaves out sites with no host id: the mapping list cannot offer them', () => {
    expect(countUnmappedSites([{ hostId: '', id: 's1' }, { hostId: 'h1', id: 's2' }], [])).toBe(1);
  });
});
