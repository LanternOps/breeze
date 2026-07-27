import { describe, expect, it } from 'vitest';
import {
  REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
  REMOTE_WS_SHARED_LEASE_MAX_ROUND_TRIP_MS,
  REMOTE_WS_SHARED_LEASE_SCRIPTS,
  REMOTE_WS_SHARED_LEASE_TTL_MS,
  createRemoteWsSharedLeaseManager,
  getRemoteWsRedisKeys,
  type RemoteWsSharedLeaseClaim,
} from './remoteWsSharedLease';

type StoredValue = { value: string; expiresAt: number | null };

class FakeRedis {
  now = 0;
  evalDelayMs = 0;
  failEval = false;
  malformedEval = false;
  readonly values = new Map<string, StoredValue>();

  private current(key: string): string | null {
    const stored = this.values.get(key);
    if (!stored) return null;
    if (stored.expiresAt !== null && this.now >= stored.expiresAt) {
      this.values.delete(key);
      return null;
    }
    return stored.value;
  }

  private set(key: string, value: string, ttlMs: number | null): void {
    this.values.set(key, { value, expiresAt: ttlMs === null ? null : this.now + ttlMs });
  }

  async eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown> {
    this.now += this.evalDelayMs;
    if (this.failEval) throw new Error('partition');
    if (this.malformedEval) return { unexpected: true };
    const keys = args.slice(0, keyCount).map(String);
    const argv = args.slice(keyCount).map(String);

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.acquire) {
      const [ownerKey, generationKey, fenceKey, payloadKey] = keys;
      if (this.current(ownerKey!)) return ['already_owned'];
      if (fenceKey && payloadKey) {
        const fence = this.current(fenceKey);
        const payload = this.current(payloadKey);
        if ((fence === null) !== (payload === null)) return ['inconsistent_finalization'];
        if (fence && payload) {
          return payload.includes('"reason":"orphan_recovery"')
            ? ['desktop_orphan_recovery']
            : ['desktop_finalizing'];
        }
      }
      const generation = Number(this.current(generationKey!) ?? '0') + 1;
      this.set(generationKey!, String(generation), null);
      this.set(ownerKey!, argv[0]!.replace('__GENERATION__', String(generation)), Number(argv[1]));
      return ['acquired', String(generation)];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.renew) {
      const ownerKey = keys[0]!;
      if (this.current(ownerKey) !== argv[0]) return ['owner_mismatch'];
      this.set(ownerKey, argv[0]!, Number(argv[1]));
      return ['renewed'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.beginClose) {
      const ownerKey = keys[0]!;
      if (this.current(ownerKey) !== argv[0]) return ['owner_mismatch'];
      this.set(ownerKey, argv[0]!, Number(argv[1]));
      return ['still_owner'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.release) {
      const ownerKey = keys[0]!;
      if (this.current(ownerKey) !== argv[0]) return ['owner_mismatch'];
      this.values.delete(ownerKey);
      return ['released'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.writeDesktopIntent) {
      const [ownerKey, fenceKey, payloadKey] = keys;
      if (this.current(ownerKey!) !== argv[0]) return ['owner_mismatch'];
      const fence = this.current(fenceKey!);
      const payload = this.current(payloadKey!);
      if (fence === null && payload === null) {
        this.set(fenceKey!, argv[1]!, null);
        this.set(payloadKey!, argv[2]!, null);
        return ['written'];
      }
      if (fence === argv[1] && payload === argv[2]) return ['already_written'];
      return ['conflict'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.claimDesktopOrphan) {
      const [ownerKey, fenceKey, payloadKey] = keys;
      if (this.current(ownerKey!)) return ['already_owned'];
      if (this.current(fenceKey!) || this.current(payloadKey!)) return ['conflict'];
      this.set(fenceKey!, argv[0]!, null);
      this.set(payloadKey!, argv[1]!, null);
      return ['claimed'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.releaseDesktopIntent) {
      const [, fenceKey, payloadKey] = keys;
      if (this.current(fenceKey!) !== argv[0] || this.current(payloadKey!) !== argv[1]) {
        return ['owner_mismatch'];
      }
      this.values.delete(fenceKey!);
      this.values.delete(payloadKey!);
      return ['released'];
    }

    if (script === REMOTE_WS_SHARED_LEASE_SCRIPTS.observeDesktopFinalization) {
      const [ownerKey, fenceKey, payloadKey] = keys;
      const owner = this.current(ownerKey!);
      const fence = this.current(fenceKey!);
      const payload = this.current(payloadKey!);
      return [
        owner === null ? '0' : '1',
        fence ?? '',
        payload ?? '',
        (fence === null) === (payload === null) ? '1' : '0',
      ];
    }

    throw new Error('unknown script');
  }

  async info(section: string): Promise<string> {
    if (section === 'replication') return 'role:master\r\nmaster_replid:stable\r\nmaster_failover_state:no-failover\r\n';
    if (section === 'persistence') return 'aof_enabled:1\r\naof_rewrite_in_progress:0\r\n';
    if (section === 'cluster') return 'cluster_enabled:0\r\n';
    return '';
  }

  async config(command: string, key: string): Promise<string[]> {
    expect(command).toBe('GET');
    expect(key).toBe('maxmemory-policy');
    return ['maxmemory-policy', 'noeviction'];
  }
}

function manager(redis: FakeRedis, instanceId: string) {
  return createRemoteWsSharedLeaseManager({
    redis: redis as never,
    instanceId,
    requiredTopology: 'standalone-single-primary',
    monotonicNow: () => redis.now,
  });
}

describe('remote websocket shared lease', () => {
  it('acquires one owner, rejects a second instance, and preserves generation across restart', async () => {
    const redis = new FakeRedis();
    const firstManager = manager(redis, '11111111-1111-4111-8111-111111111111');
    const secondManager = manager(redis, '22222222-2222-4222-8222-222222222222');

    const first = await firstManager.acquire('terminal', 'session-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.claim.connectionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.claim.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.claim.instanceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(first.claim.generation).toBe(1);
    expect(await secondManager.acquire('terminal', 'session-1')).toEqual({
      ok: false,
      reason: 'already_owned',
    });

    expect(await firstManager.beginClose(first.claim)).toEqual({
      ok: true,
      ownership: 'still_owner',
    });
    expect(await secondManager.acquire('terminal', 'session-1')).toEqual({
      ok: false,
      reason: 'already_owned',
    });
    expect(await firstManager.release(first.claim)).toBe(true);

    const afterRestart = await secondManager.acquire('terminal', 'session-1');
    expect(afterRestart.ok && afterRestart.claim.generation).toBe(2);
  });

  it('only exact owner values renew or release and stale claims cannot delete replacements', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    const acquired = await leases.acquire('tunnel', 'session-2');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const stale = { ...acquired.claim, leaseToken: 'stale-token', ownerValue: 'stale-owner' };
    await expect(leases.renew(stale)).rejects.toThrow('owner_mismatch');
    expect(stale.safeForwardingUntilMonotonicMs).toBe(0);
    expect(await leases.release(stale)).toBe(false);
    expect(await leases.renew(acquired.claim)).toMatchObject({ generation: 1 });
    expect(await leases.release(acquired.claim)).toBe(true);
  });

  it('rejects claims whose identity fields do not match their copied owner value', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    const acquired = await leases.acquire('terminal', 'tampered-identity');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    const tampered = {
      ...acquired.claim,
      generation: acquired.claim.generation + 1,
    };
    expect(tampered.ownerValue).toBe(acquired.claim.ownerValue);

    await expect(leases.renew(tampered)).rejects.toThrow('claim identity');
    expect(await leases.beginClose(tampered)).toEqual({
      ok: false,
      reason: 'owner_mismatch',
    });
    expect(await leases.release(tampered)).toBe(false);

    expect(await leases.renew(acquired.claim)).toMatchObject({
      generation: acquired.claim.generation,
    });
  });

  it('uses request-start deadline math and fails closed on slow, failed, or malformed replies', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    redis.now = 5_000;
    const acquired = await leases.acquire('terminal', 'deadline');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.claim.safeForwardingUntilMonotonicMs).toBe(
      5_000 + REMOTE_WS_SHARED_LEASE_TTL_MS - REMOTE_WS_FORWARDING_SAFETY_MARGIN_MS,
    );

    redis.evalDelayMs = REMOTE_WS_SHARED_LEASE_MAX_ROUND_TRIP_MS + 1;
    await expect(leases.renew(acquired.claim)).rejects.toThrow('slow');
    expect(acquired.claim.safeForwardingUntilMonotonicMs).toBe(0);

    redis.evalDelayMs = 0;
    redis.failEval = true;
    await expect(leases.renew(acquired.claim)).rejects.toThrow('unavailable');
    expect(acquired.claim.safeForwardingUntilMonotonicMs).toBe(0);

    redis.failEval = false;
    redis.malformedEval = true;
    await expect(leases.renew(acquired.claim)).rejects.toThrow('malformed');
    expect(acquired.claim.safeForwardingUntilMonotonicMs).toBe(0);
  });

  it('leaves a ten-second non-forwarding gap before a partitioned owner can be replaced', async () => {
    const redis = new FakeRedis();
    const firstManager = manager(redis, '11111111-1111-4111-8111-111111111111');
    const secondManager = manager(redis, '22222222-2222-4222-8222-222222222222');
    const acquired = await firstManager.acquire('desktop', 'partitioned');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    redis.now = acquired.claim.safeForwardingUntilMonotonicMs;
    expect(await secondManager.acquire('desktop', 'partitioned')).toEqual({
      ok: false,
      reason: 'already_owned',
    });
    redis.now = REMOTE_WS_SHARED_LEASE_TTL_MS - 1;
    expect(await secondManager.acquire('desktop', 'partitioned')).toEqual({
      ok: false,
      reason: 'already_owned',
    });
    redis.now = REMOTE_WS_SHARED_LEASE_TTL_MS;
    expect((await secondManager.acquire('desktop', 'partitioned')).ok).toBe(true);
  });

  it('atomically checks and writes the exact desktop finalization pair without TTL', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    const acquired = await leases.acquire('desktop', 'finalizing');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const payload = '{"reason":"client_close"}';

    expect(
      await leases.writeDesktopFinalizationIntent(acquired.claim, 'finalization-1', payload),
    ).toBe('written');
    expect(
      await leases.writeDesktopFinalizationIntent(acquired.claim, 'finalization-1', payload),
    ).toBe('already_written');
    expect(
      await leases.writeDesktopFinalizationIntent(acquired.claim, 'finalization-2', payload),
    ).toBe('conflict');
    expect(redis.values.get(getRemoteWsRedisKeys('desktop', 'finalizing').finalizing!)?.expiresAt).toBeNull();
    expect(redis.values.get(getRemoteWsRedisKeys('desktop', 'finalizing').finalizationPayload!)?.expiresAt).toBeNull();

    expect(await leases.release(acquired.claim)).toBe(true);
    expect(await leases.acquire('desktop', 'finalizing')).toEqual({
      ok: false,
      reason: 'desktop_finalizing',
    });
    expect(
      await leases.releaseDesktopFinalizationIntent('finalizing', 'finalization-1', payload),
    ).toBe(true);
  });

  it('claims orphan recovery only with no owner or existing intent', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    const payload = '{"reason":"orphan_recovery"}';
    expect(
      await leases.claimDesktopOrphan('orphaned', 'finalization-orphan', payload),
    ).toBe('claimed');
    expect(await leases.acquire('desktop', 'orphaned')).toEqual({
      ok: false,
      reason: 'desktop_orphan_recovery',
    });
  });

  it('atomically observes owner presence and the exact desktop intent pair', async () => {
    const redis = new FakeRedis();
    const leases = manager(redis, '11111111-1111-4111-8111-111111111111');
    const acquired = await leases.acquire('desktop', 'observed');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(await leases.observeDesktopFinalization('observed')).toEqual({
      ownerPresent: true,
      finalizationId: null,
      canonicalPayload: null,
      consistent: true,
    });
    const payload = '{"reason":"client_close"}';
    await leases.writeDesktopFinalizationIntent(
      acquired.claim,
      'finalization-observed',
      payload,
    );
    expect(await leases.observeDesktopFinalization('observed')).toEqual({
      ownerPresent: true,
      finalizationId: 'finalization-observed',
      canonicalPayload: payload,
      consistent: true,
    });

    const keys = getRemoteWsRedisKeys('desktop', 'incomplete');
    redis.values.set(keys.finalizing!, { value: 'only-fence', expiresAt: null });
    expect(await leases.observeDesktopFinalization('incomplete')).toMatchObject({
      ownerPresent: false,
      consistent: false,
    });
  });

  it('keeps every script key in the exact per-kind/session Redis hash slot', () => {
    for (const kind of ['terminal', 'desktop', 'tunnel'] as const) {
      const keys = getRemoteWsRedisKeys(kind, 'session-id');
      for (const key of Object.values(keys).filter((value): value is string => Boolean(value))) {
        expect(key).toContain(`{${kind}:session-id}`);
      }
    }
    for (const script of Object.values(REMOTE_WS_SHARED_LEASE_SCRIPTS)) {
      expect(script).not.toMatch(/remote:ws:[^{'"]/);
      expect(script).not.toContain('global');
    }
  });
});
