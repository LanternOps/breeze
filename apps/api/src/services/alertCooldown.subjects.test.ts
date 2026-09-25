import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ available: true, store: new Map<string, string>(), lists: new Map<string, string[]>() }));
vi.mock('./redis', () => ({ isRedisAvailable: () => m.available, getRedis: () => ({
  exists: async (k: string) => Number(m.store.has(k)), get: async (k: string) => m.store.get(k) ?? null,
  setex: async (k: string, _ttl: number, v: string) => { m.store.set(k, v); },
  rpush: async (k: string, v: string) => { m.lists.set(k, [...(m.lists.get(k) ?? []), v]); },
  ltrim: async () => {}, expire: async () => {}, lrange: async (k: string) => m.lists.get(k) ?? [],
}) }));
import { isCooldownActive, setCooldown, isFlapping, recordStateTransition } from './alertCooldown';
beforeEach(() => { m.available = true; m.store.clear(); m.lists.clear(); });
it.each([true, false])('cooldown identity, Redis=%s', async available => {
  m.available = available;
  const rule = `rule-${available}`;
  await setCooldown(rule, 'device', 5, 'disk:3');
  expect(await isCooldownActive(rule, 'device', 'disk:3')).toBe(true);
  expect(await isCooldownActive(rule, 'device', 'disk:5')).toBe(false);
  expect(await isCooldownActive(rule, 'device')).toBe(false);
});
it('keeps legacy Redis keys and separates adaptive and flap keys', async () => {
  await setCooldown('rule', 'device', 5);
  await setCooldown('rule', 'device', 5, 'disk:3');
  expect(m.store.has('breeze:alerts:cooldown:rule:device')).toBe(true);
  expect(m.store.has('breeze:alerts:cooldown:adaptive:rule:device')).toBe(true);
  await recordStateTransition('rule', 'device', 'resolved');
  expect(m.lists.has('breeze:alerts:flap:rule:device')).toBe(true);
  expect(m.store.has('breeze:alerts:cooldown:adaptive:rule:device:disk:3')).toBe(true);
  for (let i = 0; i < 4; i++) await recordStateTransition('rule', 'device', 'triggered', 'disk:3');
  expect(await isFlapping('rule', 'device', undefined, undefined, 'disk:3')).toBe(true);
  expect(await isFlapping('rule', 'device', undefined, undefined, 'disk:5')).toBe(false);
  expect(await isFlapping('rule', 'device')).toBe(false);
});
