import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ select: vi.fn(), predicates: [] as unknown[] }));
vi.mock('../../../db', () => ({ db: { select: mocks.select } }));

import { containerImageCurrencyHandler } from './containerImageCurrency';

const now = new Date('2026-12-30T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const deviceId = '11111111-1111-4111-8111-111111111111';
const condition = { type: 'container_image_currency', minDaysBehind: 7 };

type Row = {
  imageRepository: string;
  imageTag: string;
  upstreamStatus: string;
  behindSince: Date | null;
};

function rows(result: Row[]) {
  mocks.select.mockImplementationOnce(() => ({
    from: () => ({
      where: async (p: unknown) => {
        mocks.predicates.push(p);
        return result;
      },
    }),
  }));
}

const row = (imageRepository: string, imageTag: string, upstreamStatus: string, behindSince: Date | null = null): Row =>
  ({ imageRepository, imageTag, upstreamStatus, behindSince });

beforeEach(() => {
  mocks.select.mockReset();
  mocks.predicates = [];
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('containerImageCurrencyHandler', () => {
  it('breaches only once behind for the configured age, measured from behind_since', async () => {
    rows([
      row('nginx', '1.25', 'behind', daysAgo(8)),
      row('redis', '7', 'behind', daysAgo(2)),
      row('postgres', '16', 'current'),
    ]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.passed).toBe(true);
    expect(result.dataAvailable).toBe(true);
    expect(result.subjects).toEqual([
      expect.objectContaining({ subjectKey: 'nginx:1.25', status: 'breaching' }),
      expect.objectContaining({ subjectKey: 'postgres:16', status: 'recovered' }),
      // behind but younger than the threshold: neither breaching nor recovered.
      expect.objectContaining({ subjectKey: 'redis:7', status: 'unknown' }),
    ]);
    const nginx = result.subjects!.find((s) => s.subjectKey === 'nginx:1.25')!;
    expect(nginx.context).toMatchObject({
      source: 'container_image_currency',
      subjectKey: 'nginx:1.25',
      imageRef: 'nginx:1.25',
      imageRepository: 'nginx',
      imageTag: '1.25',
      upstreamStatus: 'behind',
      daysBehind: 8,
      behindSince: daysAgo(8).toISOString(),
    });
  });

  it('honours a zero-day threshold and the exact boundary', async () => {
    rows([row('a', '1', 'behind', now), row('b', '1', 'behind', daysAgo(7))]);
    const zero = await containerImageCurrencyHandler.evaluate({ ...condition, minDaysBehind: 0 }, deviceId);
    expect(zero.subjects!.map((s) => s.status)).toEqual(['breaching', 'breaching']);
    rows([row('b', '1', 'behind', daysAgo(7)), row('c', '1', 'behind', new Date(daysAgo(7).getTime() + 1000))]);
    const seven = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(seven.subjects!.map((s) => [s.subjectKey, s.status])).toEqual([['b:1', 'breaching'], ['c:1', 'unknown']]);
  });

  it('never breaches a behind row whose behind_since is not yet stamped', async () => {
    rows([row('nginx', '1.25', 'behind', null)]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.passed).toBe(false);
    expect(result.subjects).toEqual([expect.objectContaining({ subjectKey: 'nginx:1.25', status: 'unknown' })]);
  });

  it('reports every unknown-class image as unknown, never recovered', async () => {
    rows(['pending', 'private', 'unsupported_registry', 'error'].map((s, i) => row(`img${i}`, 'x', s)));
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.passed).toBe(false);
    expect(result.subjects!.every((s) => s.status === 'unknown')).toBe(true);
    expect(result.subjects).toHaveLength(4);
  });

  it('ignores a not_found replica, like the compliance helper', async () => {
    rows([row('nginx', '1', 'current'), row('nginx', '1', 'not_found')]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.subjects).toEqual([expect.objectContaining({ subjectKey: 'nginx:1', status: 'recovered' })]);
  });

  it('resolves (recovered) an image whose rows are all not_applicable, e.g. behind -> not_found / pinned', async () => {
    rows([row('app', 'dev', 'local'), row('base', 'v1', 'pinned'), row('gone', '0', 'not_found')]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.subjects).toEqual([
      expect.objectContaining({ subjectKey: 'app:dev', status: 'recovered', context: expect.objectContaining({ upstreamStatus: 'local', daysBehind: null, behindSince: null }) }),
      expect.objectContaining({ subjectKey: 'base:v1', status: 'recovered', context: expect.objectContaining({ upstreamStatus: 'pinned' }) }),
      expect.objectContaining({ subjectKey: 'gone:0', status: 'recovered', context: expect.objectContaining({ upstreamStatus: 'not_found' }) }),
    ]);
    expect(result.passed).toBe(false);
    expect(result.dataAvailable).toBe(true);
  });

  it('a previously-behind image that becomes not_found still yields its subject key as recovered', async () => {
    rows([row('nginx', '1.25', 'behind', daysAgo(9))]);
    const before = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(before.subjects).toEqual([expect.objectContaining({ subjectKey: 'nginx:1.25', status: 'breaching' })]);
    rows([row('nginx', '1.25', 'not_found')]);
    const after = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(after.subjects).toEqual([expect.objectContaining({ subjectKey: 'nginx:1.25', status: 'recovered' })]);
  });

  it('a previously-behind image that becomes pinned still yields its subject key as recovered', async () => {
    rows([row('nginx', '1.25', 'pinned')]);
    const after = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(after.subjects).toEqual([expect.objectContaining({ subjectKey: 'nginx:1.25', status: 'recovered' })]);
  });

  it('collapses replicas of one image into one subject, worst status first', async () => {
    rows([
      row('nginx', '1.25', 'current'),
      row('nginx', '1.25', 'behind', daysAgo(10)),
      row('nginx', '1.25', 'behind', daysAgo(3)),
      row('redis', '7', 'current'),
      row('redis', '7', 'pending'),
    ]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result.subjects!.map((s) => [s.subjectKey, s.status])).toEqual([
      // the oldest behind_since among the replicas decides the age
      ['nginx:1.25', 'breaching'],
      // a replica not yet checked keeps the image from reading as recovered
      ['redis:7', 'unknown'],
    ]);
  });

  it('reports no data for a device without container rows', async () => {
    rows([]);
    const result = await containerImageCurrencyHandler.evaluate(condition, deviceId);
    expect(result).toMatchObject({ passed: false, dataAvailable: false, subjects: [] });
  });

  it('reads only container rows with an image reference on this device', async () => {
    rows([]);
    await containerImageCurrencyHandler.evaluate(condition, deviceId);
    const { sql, params } = new PgDialect().sqlToQuery(mocks.predicates[0] as never);
    expect(sql).toContain('"device_workloads"."device_id" = $');
    expect(sql).toContain('"device_workloads"."kind" = $');
    expect(sql).toContain('"device_workloads"."image_repository" is not null');
    expect(sql).toContain('"device_workloads"."image_tag" is not null');
    expect(params).toEqual(expect.arrayContaining([deviceId, 'container']));
  });

  it('validates the condition shape', () => {
    expect(containerImageCurrencyHandler.validate!({ type: 'container_image_currency', minDaysBehind: 7 }, 'c')).toEqual([]);
    expect(containerImageCurrencyHandler.validate!({ type: 'container_image_currency', minDaysBehind: -1 }, 'c')).not.toEqual([]);
  });
});
