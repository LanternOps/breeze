import { describe, expect, it, vi } from 'vitest';

const { createUnifiClient } = vi.hoisted(() => ({ createUnifiClient: vi.fn() }));
vi.mock('./unifiClient', async (importActual) => ({
  ...(await importActual<typeof import('./unifiClient')>()),
  createUnifiClient,
}));

import { UnifiApiError, type UnifiClient } from './unifiClient';
import type { UnifiSyncKey } from './unifiKeyService';
import { readHostsAcrossKeys } from './unifiHostsAcrossKeys';

const key = (id: string, label = id.toUpperCase()): UnifiSyncKey => ({ id, label, apiKey: `secret-${id}`, keyLast4: null, lastSeenHostIds: null });
function client(hosts: string[], sites: Array<[string, string]>, fail?: Error): Partial<UnifiClient> {
  return {
    listHosts: vi.fn(async () => { if (fail) throw fail; return hosts.map((id) => ({ id, name: `Host ${id}`, type: 'console', model: null })); }),
    listSites: vi.fn(async () => { if (fail) throw fail; return sites.map(([hostId, id]) => ({ id, hostId, name: `Site ${id}` })); }),
  };
}

describe('readHostsAcrossKeys', () => {
  it('merges every key and tags each host and site with the keys that see it', async () => {
    createUnifiClient
      .mockReturnValueOnce(client(['h1'], [['h1', 's1']]))
      .mockReturnValueOnce(client(['h1', 'h2'], [['h1', 's1'], ['h2', 's2']]));
    const out = await readHostsAcrossKeys([key('a'), key('b')], 'https://api.ui.com');
    expect(createUnifiClient).toHaveBeenNthCalledWith(1, { baseUrl: 'https://api.ui.com', apiKey: 'secret-a' });
    expect(out.complete).toBe(true);
    expect(out.keys).toEqual([
      { id: 'a', label: 'A', ok: true, authFailure: false, httpStatus: null },
      { id: 'b', label: 'B', ok: true, authFailure: false, httpStatus: null },
    ]);
    expect(out.hosts).toEqual([
      { id: 'h1', name: 'Host h1', model: null, type: 'console', keyIds: ['a', 'b'], sites: [{ id: 's1', name: 'Site s1', keyIds: ['a', 'b'] }] },
      { id: 'h2', name: 'Host h2', model: null, type: 'console', keyIds: ['b'], sites: [{ id: 's2', name: 'Site s2', keyIds: ['b'] }] },
    ]);
  });

  it('reports complete:false and the failed key when one key fails', async () => {
    createUnifiClient
      .mockReturnValueOnce(client(['h1'], [['h1', 's1']]))
      .mockReturnValueOnce(client([], [], new UnifiApiError('Unauthorized', 401)));
    const out = await readHostsAcrossKeys([key('a'), key('b')], 'https://api.ui.com');
    expect(out.complete).toBe(false);
    expect(out.keys[1]).toEqual({ id: 'b', label: 'B', ok: false, error: 'Unauthorized', authFailure: true, httpStatus: 401 });
    expect(out.hosts.map((h) => h.id)).toEqual(['h1']);
  });

  it("throws the first key's error when every key fails", async () => {
    const first = new UnifiApiError('first', 502);
    createUnifiClient
      .mockReturnValueOnce(client([], [], first))
      .mockReturnValueOnce(client([], [], new UnifiApiError('second', 401)));
    await expect(readHostsAcrossKeys([key('a'), key('b')], 'https://api.ui.com')).rejects.toBe(first);
  });

  it('a key that does not decrypt is a failed key and builds no client', async () => {
    createUnifiClient.mockReset();
    createUnifiClient.mockReturnValueOnce(client(['h1'], [['h1', 's1']]));
    const broken: UnifiSyncKey = { id: 'x', label: 'X', apiKey: null, decryptError: 'The stored API key could not be decrypted', lastSeenHostIds: null };
    const out = await readHostsAcrossKeys([key('a'), broken], 'https://api.ui.com');
    expect(createUnifiClient).toHaveBeenCalledTimes(1);
    expect(out.keys[1]).toMatchObject({ id: 'x', ok: false, error: 'The stored API key could not be decrypted' });
    await expect(readHostsAcrossKeys([broken], 'https://api.ui.com')).rejects.toThrow('The stored API key could not be decrypted');
  });

  it('never puts a key in its result', async () => {
    createUnifiClient.mockReturnValueOnce(client(['h1'], [['h1', 's1']]));
    const out = await readHostsAcrossKeys([key('a')], 'https://api.ui.com');
    expect(JSON.stringify(out)).not.toContain('secret-a');
  });
});
