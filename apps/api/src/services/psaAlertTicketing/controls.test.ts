import { describe, expect, it, vi } from 'vitest';
import { withTicketingControls, redisTicketingControls } from './controls';
import { harness } from './testHarness';
function redisFake() {
  const slots = new Map<string, string>();
  const counts = new Map<string, number>();
  const redis = {
    set: vi.fn(async (key: string, token: string) => {
      if (slots.has(key)) return null;
      slots.set(key, token);
      return 'OK';
    }),
    eval: vi.fn(async (script: string, _keys: number, key: string, value: string) => {
      if (script.includes('INCR')) {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n;
      }
      if (slots.get(key) !== value) return 0;
      if (script.includes('DEL')) slots.delete(key);
      return 1;
    }),
  };
  return { redis, counts };
}
describe('shared connection controls', () => {
  it('allows only one in-flight call per connection', async () => {
    const r = redisFake(),
      controls = redisTicketingControls(() => r.redis as never);
    const f = harness();
    let finish!: (value: never) => void;
    f.adapter.createAlertTicket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        })
    );
    const first = withTicketingControls('mapping', f.deps, controls, f.now());
    await vi.waitFor(() => expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1));
    const g = harness();
    await withTicketingControls('mapping2', g.deps, controls, g.now());
    expect(g.adapter.createAlertTicket).not.toHaveBeenCalled();
    finish({ ticketId: '10', ticketNumber: '10', externalUrl: null, createdAt: null } as never);
    await first;
  });
  it('two workers obey cap 3; above-cap creates wait while closes continue', async () => {
    const r = redisFake(),
      controls = redisTicketingControls(() => r.redis as never);
    const fixtures = Array.from({ length: 5 }, () => harness());
    for (const f of fixtures) {
      f.ctx.snapshot.hourlyCreateCap = 3;
      await withTicketingControls('mapping', f.deps, controls, f.now());
    }
    expect(fixtures.reduce((n, f) => n + f.adapter.createAlertTicket.mock.calls.length, 0)).toBe(3);
    expect([...r.counts.keys()]).toEqual(['psa:alert-ticketing:cap:connection:2026103112']);
    const blocked = fixtures[3]!;
    expect(blocked.ctx.mapping.createState).toBe('never_attempted');
    expect(blocked.ctx.mapping.lastError).toBe('hourly_create_cap');
    const first = fixtures[0]!;
    first.ctx.alert!.status = 'resolved';
    await withTicketingControls('mapping', first.deps, controls, first.now());
    expect(first.adapter.closeTicket).toHaveBeenCalledTimes(1);
  });
  it('fails closed on Redis loss; the durable row can be re-driven without double POST', async () => {
    const r = redisFake();
    let available = false;
    const controls = redisTicketingControls(() => (available ? (r.redis as never) : null));
    const f = harness();
    await withTicketingControls('mapping', f.deps, controls, f.now());
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
    expect(f.ctx.mapping.createState).toBe('never_attempted');
    available = true;
    await withTicketingControls('mapping', f.deps, controls, f.now());
    available = false;
    await withTicketingControls('mapping', f.deps, controls, f.now());
    available = true;
    await withTicketingControls('mapping', f.deps, controls, f.now());
    expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(1);
  });
  it('cap Redis failure after claim stays safely retryable with no remote call', async () => {
    const r = redisFake();
    r.redis.eval.mockRejectedValueOnce(new Error('Redis lost'));
    const f = harness();
    await withTicketingControls(
      'mapping',
      f.deps,
      redisTicketingControls(() => r.redis as never),
      f.now()
    );
    expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
    expect(f.ctx.mapping.createState).toBe('never_attempted');
  });
});

it('known connection lease loss before the adapter call fails closed', async () => {
  const redis = {
    set: vi.fn(async () => 'OK'),
    eval: vi.fn(async (script: string) => (script.includes('INCR') ? 1 : 0)),
  };
  const f = harness();
  await withTicketingControls(
    'mapping',
    f.deps,
    redisTicketingControls(() => redis as never),
    f.now()
  );
  expect(f.adapter.createAlertTicket).not.toHaveBeenCalled();
  expect(f.ctx.mapping.createState).toBe('never_attempted');
});
