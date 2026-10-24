import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createNotificationMock, inSystemContextMock } = vi.hoisted(() => ({
  createNotificationMock: vi.fn(),
  inSystemContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../userNotifications', () => ({ createNotification: createNotificationMock }));
vi.mock('./grantAuthority', () => ({ inSystemContext: inSystemContextMock }));

import { deliverInApp } from './deliver';

const base = {
  userId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
  title: 'Wisp: ticket waiting',
  body: 'Greenwood has been waiting 3 days',
  link: '/ai/wisp/thread/t1#concern=c1',
  dedupeKey: 'wisp-nudge-c1-g1-1',
};

describe('deliverInApp', () => {
  beforeEach(() => {
    createNotificationMock.mockReset();
    inSystemContextMock.mockClear();
  });

  it('writes one ai notification in system context with the W06 metadata keys', async () => {
    createNotificationMock.mockResolvedValueOnce('n1');
    const result = await deliverInApp({
      ...base, priority: 'high', concernId: 'c1', approvalIntentId: 'i1', threadId: 't1', grantId: 'g1', deepLink: '/ai/wisp/thread/t1#concern=c1',
    });
    expect(result).toEqual({ created: true });
    expect(inSystemContextMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith({
      userId: base.userId,
      orgId: base.orgId,
      type: 'ai',
      title: base.title,
      message: base.body,
      link: base.link,
      priority: 'high',
      dedupeKey: base.dedupeKey,
      metadata: { wispThreadId: 't1', concernId: 'c1', grantId: 'g1', intentId: 'i1', deepLink: '/ai/wisp/thread/t1#concern=c1' },
    });
  });

  it('returns created:false on a dedupe collision (createNotification → null)', async () => {
    createNotificationMock.mockResolvedValueOnce(null);
    expect(await deliverInApp(base)).toEqual({ created: false });
    expect(createNotificationMock.mock.calls[0]![0].priority).toBe('normal');
    expect(createNotificationMock.mock.calls[0]![0].metadata).toEqual({
      wispThreadId: null, concernId: null, grantId: null, intentId: null, deepLink: null,
    });
  });
});

describe('the single in-app delivery site (w00 A18)', () => {
  it('createNotification( appears in exactly one file under services/wisp/: deliver.ts', () => {
    const root = __dirname;
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const offenders = walk(root)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .filter((p) => /\bcreateNotification\s*\(/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(root, p));
    expect(offenders).toEqual(['deliver.ts']);
  });
});
