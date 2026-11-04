import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UmbrellaProvider } from './umbrella';
import { requestJson } from './http';

vi.mock('./http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./http')>();
  return { ...actual, requestJson: vi.fn() };
});

const requestJsonMock = vi.mocked(requestJson);
const ACTIVITY_URL = 'https://api.umbrella.com/reports/v2/activity';

function queueTokenThenEmpty() {
  const queue: unknown[] = [{ access_token: 'tok-1', token_type: 'bearer', expires_in: 3600 }, { data: [] }];
  requestJsonMock.mockImplementation(async () => {
    if (!queue.length) throw new Error('requestJson mock exhausted');
    return queue.shift() as never;
  });
}

function verdictParams(): Array<string | null> {
  return requestJsonMock.mock.calls
    .filter((call) => String(call[0]).startsWith(ACTIVITY_URL))
    .map((call) => new URL(String(call[0])).searchParams.get('verdict'));
}

/**
 * #10054 — an integration that does not store allowed traffic asks Cisco for
 * blocked + proxied records only (the `verdict` filter on /reports/v2/activity),
 * so the ~99% of records that are allowed queries are never fetched and cost
 * no request budget (#10018). The sync job still filters by action before
 * insert, so this is an optimisation, not the guarantee.
 */
describe('UmbrellaProvider activity verdict filter (#10054)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests the blocked and proxied verdicts only by default', async () => {
    queueTokenThenEmpty();

    await new UmbrellaProvider('key-abc', 'secret-xyz', {})
      .syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const verdicts = verdictParams();
    expect(verdicts.length).toBeGreaterThan(0);
    expect(new Set(verdicts)).toEqual(new Set(['blocked,proxied']));
  });

  it('requests every verdict when the integration stores allowed traffic', async () => {
    queueTokenThenEmpty();

    await new UmbrellaProvider('key-abc', 'secret-xyz', { storeAllowedTraffic: true })
      .syncEvents(new Date('2026-08-01'), new Date('2026-08-02'));

    const verdicts = verdictParams();
    expect(verdicts.length).toBeGreaterThan(0);
    expect(new Set(verdicts)).toEqual(new Set([null]));
  });
});
