import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestJson: vi.fn() }));

vi.mock('./http', () => ({ requestJson: mocks.requestJson }));

import { PiHoleProvider, PIHOLE_V5_MAX_RESPONSE_BYTES } from './pihole';

describe('PiHoleProvider reply cap', () => {
  beforeEach(() => {
    mocks.requestJson.mockReset();
    mocks.requestJson.mockResolvedValue({ data: [] });
  });

  it('allows the unpaged 24 h query log (128 MiB) on getAllQueries', async () => {
    const provider = new PiHoleProvider('key', { apiEndpoint: 'https://pihole.example.test' });
    await provider.syncEvents(new Date(0), new Date());
    expect(PIHOLE_V5_MAX_RESPONSE_BYTES).toBe(128 * 1024 * 1024);
    expect(mocks.requestJson.mock.calls[0]![1].maxBytes).toBe(128 * 1024 * 1024);
  });
});
