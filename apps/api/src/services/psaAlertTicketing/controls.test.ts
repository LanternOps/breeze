import { describe, expect, it, vi } from 'vitest';
import { withTicketingControls, redisTicketingControls } from './controls';
import { PsaAdapterError } from '../psa/types';
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
      if (script.includes('DECR')) {
        const n = Math.max(0, (counts.get(key) ?? 0) - 1);
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
    expect(g.deps.wake).toHaveBeenCalledWith('mapping2', 'create', expect.any(Date));
    finish({ ticketId: '10', ticketNumber: '10', externalUrl: null, createdAt: null } as never);
    await first;
  });
  it('sequential workers obey cap 3; above-cap creates wait while closes continue', async () => {
    const r = redisFake(),
      controls = redisTicketingControls(() => r.redis as never);
    const fixtures = Array.from({ length: 5 }, () => harness());
    for (const f of fixtures) {
      f.ctx.snapshot.hourlyCreateCap = 3;
      await withTicketingControls('mapping', f.deps, controls, f.now());
    }
    expect(fixtures.reduce((n, f) => n + f.adapter.createAlertTicket.mock.calls.length, 0)).toBe(3);
    expect([...r.counts.keys()]).toEqual(['psa:alert-ticketing:cap:connection:2026103112']);
    expect([...r.counts.values()]).toEqual([3]);
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
    r.redis.eval.mockRejectedValueOnce(Object.assign(new Error('Redis lost'), { code: 'ECONNRESET' }));
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

it('an early job schedules another wake instead of dropping the durable row', async () => {
  const f = harness();
  f.ctx.mapping.nextAttemptAt = new Date(f.now().getTime() + 60000);
  await withTicketingControls('mapping', f.deps, redisTicketingControls(() => null), f.now());
  const at = vi.mocked(f.deps.wake).mock.calls[0]![2];
  expect(at.getTime() - f.ctx.mapping.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(1000);
  expect(at.getTime() - f.ctx.mapping.nextAttemptAt.getTime()).toBeLessThanOrEqual(5000);
});
it('many mappings sharing a connection all finish using their scheduled wakes without a sweep', async () => {
  const r = redisFake(), controls = redisTicketingControls(() => r.redis as never);
  const fixtures = Array.from({ length: 5 }, () => harness());
  let finish!: (value: never) => void;
  fixtures[0]!.adapter.createAlertTicket.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as never; }));
  const first = withTicketingControls('m0', fixtures[0]!.deps, controls, fixtures[0]!.now());
  await vi.waitFor(() => expect(fixtures[0]!.adapter.createAlertTicket).toHaveBeenCalledTimes(1));
  for (const [i, f] of fixtures.entries()) if(i) await withTicketingControls(`m${i}`, f.deps, controls, f.now());
  finish({ ticketId: '10', ticketNumber: '10', externalUrl: null, createdAt: null } as never);
  await first;
  for (const [i, f] of fixtures.entries()) if(i) {
    expect(f.deps.wake).toHaveBeenCalledTimes(1);
    const at = vi.mocked(f.deps.wake).mock.calls[0]![2];
    expect(at.getTime() - f.now().getTime()).toBeGreaterThanOrEqual(1000);
    expect(at.getTime() - f.now().getTime()).toBeLessThanOrEqual(5000);
    f.advance(at.getTime() - f.now().getTime());
    await withTicketingControls(`m${i}`, f.deps, controls, f.now());
  }
  expect(fixtures.reduce((n, f) => n + f.adapter.createAlertTicket.mock.calls.length, 0)).toBe(5);
});

it.each(['acquire', 'renew', 'release'] as const)('logs the underlying Redis %s failure', async (op) => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const redis = { set: vi.fn(async () => 'OK'), eval: vi.fn(async () => 1) };
  const controls = redisTicketingControls(() => redis as never);
  if (op === 'acquire') redis.set.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
  const lease = await controls.acquire('connection');
  if (op !== 'acquire') {
    redis.eval.mockRejectedValueOnce(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }));
    if (op === 'renew') await expect(lease!.assertOwned()).rejects.toThrow('socket closed');
    await lease!.release();
  }
  expect(error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ connectionId: 'connection', message: 'socket closed' }));
  error.mockRestore();
});

it('does not swallow a programming error from the Redis control path', async () => {
  const failure = new TypeError('invalid Redis call');
  const controls = redisTicketingControls(() => ({ set: vi.fn().mockRejectedValue(failure) }) as never);
  await expect(controls.acquire('connection')).rejects.toBe(failure);
});

it('three pre-send transient creates retain increasing delays and refund the real hourly counter', async () => {
  const r = redisFake(), controls = redisTicketingControls(() => r.redis as never), f = harness();
  f.adapter.createAlertTicket.mockRejectedValue(new PsaAdapterError({ provider: 'connectwise', errorClass: 'transient', httpStatus: null, message: 'connection refused' }));
  for (const delay of [30000, 60000, 120000]) {
    const before = f.now().getTime();
    await withTicketingControls('mapping', f.deps, controls, f.now());
    expect(f.ctx.mapping.nextAttemptAt!.getTime() - before).toBe(delay);
    expect([...r.counts.values()]).toEqual([0]);
    f.advance(delay);
  }
  expect(f.adapter.createAlertTicket).toHaveBeenCalledTimes(3);
});
it('an active row lease is rescheduled even when its previous nextAttemptAt is past', async () => {
  const f = harness();
  f.ctx.mapping.nextAttemptAt = new Date(f.now().getTime() - 1000);
  f.ctx.mapping.leaseUntil = new Date(f.now().getTime() + 10000);
  await withTicketingControls('mapping', f.deps, redisTicketingControls(() => null), f.now());
  const at = vi.mocked(f.deps.wake).mock.calls[0]![2];
  expect(at.getTime() - f.ctx.mapping.leaseUntil.getTime()).toBeGreaterThanOrEqual(1000);
  expect(at.getTime() - f.ctx.mapping.leaseUntil.getTime()).toBeLessThanOrEqual(5000);
});
