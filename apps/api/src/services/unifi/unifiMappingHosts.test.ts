import { describe, expect, it } from 'vitest';
import { buildMappingHostList, countUnmappedSites } from './unifiMappingHosts';

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

describe('buildMappingHostList key attribution (#11808)', () => {
  const hosts = [{ id: 'h1', name: 'Console', model: null, type: 'console' }];
  const sites = [{ id: 's1', hostId: 'h1', name: 'Main' }, { id: 's9', hostId: 'ghost', name: 'Orphan' }];

  it('attaches keyIds to each host and each site', () => {
    const list = buildMappingHostList(hosts, sites, {
      hostKeyIds: new Map([['h1', ['a', 'b']]]),
      siteKeyIds: new Map([['h1::s1', ['b']], ['ghost::s9', ['a']]]),
    });
    expect(list.hosts).toEqual([
      { id: 'h1', name: 'Console', model: null, type: 'console', keyIds: ['a', 'b'], sites: [{ id: 's1', name: 'Main', keyIds: ['b'] }] },
      { id: 'ghost', name: 'Unknown console', model: null, type: null, unknownConsole: true, keyIds: ['a'], sites: [{ id: 's9', name: 'Orphan', keyIds: ['a'] }] },
    ]);
  });

  it('without attribution the rows are unchanged', () => {
    expect(buildMappingHostList(hosts, sites).hosts[0]).toEqual({ id: 'h1', name: 'Console', model: null, type: 'console', sites: [{ id: 's1', name: 'Main' }] });
  });
});
