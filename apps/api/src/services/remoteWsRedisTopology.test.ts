import { describe, expect, it } from 'vitest';
import { createRemoteWsRedisTopologyMonitor } from './remoteWsRedisTopology';

class TopologyRedis {
  replication = 'role:master\r\nmaster_replid:stable\r\nmaster_failover_state:no-failover\r\n';
  persistence = 'aof_enabled:1\r\naof_rewrite_in_progress:0\r\n';
  cluster = 'cluster_enabled:0\r\n';
  policy = 'noeviction';
  fail = false;

  async info(section: string): Promise<string> {
    if (this.fail) throw new Error('redis unavailable');
    if (section === 'replication') return this.replication;
    if (section === 'persistence') return this.persistence;
    if (section === 'cluster') return this.cluster;
    return '';
  }

  async config(): Promise<string[]> {
    if (this.fail) throw new Error('redis unavailable');
    return ['maxmemory-policy', this.policy];
  }
}

function monitor(redis: TopologyRedis, clock: { now: number }) {
  return createRemoteWsRedisTopologyMonitor({
    redis: redis as never,
    requiredTopology: 'standalone-single-primary',
    monotonicNow: () => clock.now,
  });
}

describe('remote websocket Redis topology monitor', () => {
  it('accepts only fresh standalone primary, AOF, noeviction, cluster-disabled evidence', async () => {
    const redis = new TopologyRedis();
    const clock = { now: 0 };
    const topology = monitor(redis, clock);
    expect(await topology.requireAdmission()).toEqual({ ok: true });
    expect(topology.peek()).toMatchObject({
      ok: true,
      evidence: {
        role: 'master',
        aofEnabled: true,
        maxmemoryPolicy: 'noeviction',
        clusterEnabled: false,
      },
    });
  });

  it.each([
    ['replica', (redis: TopologyRedis) => { redis.replication = 'role:slave\r\nmaster_replid:stable\r\n'; }],
    ['failover', (redis: TopologyRedis) => { redis.replication = 'role:master\r\nmaster_failover_state:in-progress\r\n'; }],
    ['aof disabled', (redis: TopologyRedis) => { redis.persistence = 'aof_enabled:0\r\n'; }],
    ['cluster enabled', (redis: TopologyRedis) => { redis.cluster = 'cluster_enabled:1\r\n'; }],
    ['eviction policy', (redis: TopologyRedis) => { redis.policy = 'allkeys-lru'; }],
  ])('freezes admission for %s evidence', async (_name, mutate) => {
    const redis = new TopologyRedis();
    mutate(redis);
    const topology = monitor(redis, { now: 0 });
    expect(await topology.requireAdmission()).toEqual({
      ok: false,
      reason: 'unsupported_topology',
    });
  });

  it('fails closed when evidence is unavailable or stale beyond five seconds', async () => {
    const redis = new TopologyRedis();
    const clock = { now: 0 };
    const topology = monitor(redis, clock);
    expect(await topology.requireAdmission()).toEqual({ ok: true });

    clock.now = 5_001;
    redis.fail = true;
    expect(await topology.requireAdmission()).toEqual({ ok: false, reason: 'unavailable' });
    expect(topology.peek()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('freezes admission when primary identity changes after initial evidence', async () => {
    const redis = new TopologyRedis();
    const clock = { now: 0 };
    const topology = monitor(redis, clock);
    expect(await topology.requireAdmission()).toEqual({ ok: true });

    clock.now = 5_001;
    redis.replication = 'role:master\r\nmaster_replid:replacement\r\nmaster_failover_state:no-failover\r\n';
    expect(await topology.requireAdmission()).toEqual({
      ok: false,
      reason: 'unsupported_topology',
    });
  });
});
