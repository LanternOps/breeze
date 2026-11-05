import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createNotificationMock, inSystemContextMock, recordThreadPostMock, ctx } = vi.hoisted(() => {
  const ctx = { open: 0 };
  return {
    ctx,
    createNotificationMock: vi.fn(),
    recordThreadPostMock: vi.fn(),
    inSystemContextMock: vi.fn(async (fn: () => Promise<unknown>) => {
      ctx.open += 1;
      try { return await fn(); } finally { ctx.open -= 1; }
    }),
  };
});

vi.mock('../userNotifications', () => ({ createNotification: createNotificationMock }));
vi.mock('./grantAuthority', () => ({ inSystemContext: inSystemContextMock }));
vi.mock('./threadPosts', () => ({ recordThreadPost: recordThreadPostMock }));

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
    recordThreadPostMock.mockReset();
    recordThreadPostMock.mockResolvedValue({ created: true, id: 'post1' });
    inSystemContextMock.mockClear();
  });

  it('writes one ai notification in system context with the W06 metadata keys', async () => {
    createNotificationMock.mockResolvedValueOnce('n1');
    const result = await deliverInApp({
      ...base, priority: 'high', concernId: 'c1', approvalIntentId: 'i1', threadId: 't1', grantId: 'g1', deepLink: '/ai/wisp/thread/t1#concern=c1',
    });
    expect(result).toEqual({ created: true, id: 'n1' });
    // No post given (a budget / watch / assessment notice): no post is written.
    expect(recordThreadPostMock).not.toHaveBeenCalled();
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
    expect(await deliverInApp(base)).toEqual({ created: false, id: null });
    expect(createNotificationMock.mock.calls[0]![0].priority).toBe('normal');
    expect(createNotificationMock.mock.calls[0]![0].metadata).toEqual({
      wispThreadId: null, concernId: null, grantId: null, intentId: null, deepLink: null,
    });
  });

  const post = {
    threadId: 't1', partnerId: 'p1', grantId: 'g1', orgId: base.orgId, kind: 'nudge' as const,
    title: base.title, body: base.body, link: base.link, sections: null, concernId: 'c1',
  };

  it('with a post: notification then post in ONE system-context callback, the post linked to the new notification', async () => {
    const order: string[] = [];
    createNotificationMock.mockImplementationOnce(async () => { order.push(`notification:ctx=${ctx.open}`); return 'n1'; });
    recordThreadPostMock.mockImplementationOnce(async () => { order.push(`post:ctx=${ctx.open}`); return { created: true, id: 'post1' }; });
    expect(await deliverInApp({ ...base, threadId: 't1', grantId: 'g1', concernId: 'c1', post })).toEqual({ created: true, id: 'n1' });
    expect(inSystemContextMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['notification:ctx=1', 'post:ctx=1']);
    expect(recordThreadPostMock).toHaveBeenCalledWith({ ...post, dedupeKey: base.dedupeKey, notificationId: 'n1' });
  });

  it('with a post and an existing notification (dedupe hit): the post is still recorded, unlinked', async () => {
    createNotificationMock.mockResolvedValueOnce(null);
    expect(await deliverInApp({ ...base, post })).toEqual({ created: false, id: null });
    expect(recordThreadPostMock).toHaveBeenCalledWith({ ...post, dedupeKey: base.dedupeKey, notificationId: null });
  });

  it('a failing post write rejects the whole callback (the notification rolls back with it)', async () => {
    createNotificationMock.mockResolvedValueOnce('n1');
    recordThreadPostMock.mockRejectedValueOnce(new Error('fk violation'));
    await expect(deliverInApp({ ...base, post })).rejects.toThrow('fk violation');
  });
});

describe('the single post write site (W02a)', () => {
  it('recordThreadPost( is called under services/ only from deliver.ts and notifyUser.ts', () => {
    const services = join(__dirname, '..');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
    const callers = walk(services)
      .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
      .filter((p) => /(?<!function\s)\brecordThreadPost\s*\(/.test(readFileSync(p, 'utf8')))
      .map((p) => relative(services, p))
      .sort();
    expect(callers).toEqual(['wisp/deliver.ts', 'wisp/notifyUser.ts']);
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
