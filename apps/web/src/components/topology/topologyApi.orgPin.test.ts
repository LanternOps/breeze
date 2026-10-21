import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import { setTopologyOrgPin, topologyRead } from './topologyApi';

const schema = z.object({ ok: z.number() });
const PATH = '/topology/sites/s/nodes?deviceId=d';
const lastInit = () => (fetchWithAuth.mock.calls.at(-1) as unknown as [string, Record<string, unknown>])[1];

afterEach(() => { setTopologyOrgPin(null); fetchWithAuth.mockReset(); });

describe('topologyRead org pin (#9258)', () => {
  it('sends the pinned (device) org instead of the ambient working org', async () => {
    fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    setTopologyOrgPin('device-org');
    await topologyRead(PATH, schema);
    expect(fetchWithAuth).toHaveBeenLastCalledWith(PATH, expect.objectContaining({ orgIdOverride: 'device-org' }));
  });

  it('leaves the ambient org in charge when nothing is pinned', async () => {
    fetchWithAuth.mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    await topologyRead(PATH, schema);
    expect(lastInit()).not.toHaveProperty('orgIdOverride');
  });
});
