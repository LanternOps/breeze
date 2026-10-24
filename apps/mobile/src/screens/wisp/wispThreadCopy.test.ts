import { describe, expect, it } from 'vitest';

import { grantBannerCopy, replyEnabled, threadSummaryCopy } from './wispThreadCopy';

describe('grantBannerCopy', () => {
  it('is null for an active grant', () => {
    expect(grantBannerCopy({ status: 'active', pausedReason: null })).toBeNull();
  });

  it('names a user pause distinctly from a system pause', () => {
    const mine = grantBannerCopy({ status: 'paused', pausedReason: 'user_paused' });
    const system = grantBannerCopy({ status: 'paused', pausedReason: 'grantor_access_lost' });
    expect(mine).toMatch(/You paused Wisp/);
    expect(system).toMatch(/paused/i);
    expect(system).not.toBe(mine);
  });

  it('has copy for revoked and expired', () => {
    expect(grantBannerCopy({ status: 'revoked', pausedReason: null })).toMatch(/turned off/i);
    expect(grantBannerCopy({ status: 'expired', pausedReason: null })).toMatch(/expired/i);
  });
});

describe('replyEnabled', () => {
  it('only an active grant with an idle session accepts a reply', () => {
    expect(replyEnabled('active', 'idle')).toBe(true);
    expect(replyEnabled('active', 'error')).toBe(true);
    expect(replyEnabled('active', 'streaming')).toBe(false);
    expect(replyEnabled('active', 'creating')).toBe(false);
    expect(replyEnabled('paused', 'idle')).toBe(false);
    expect(replyEnabled('expired', 'idle')).toBe(false);
  });
});

describe('threadSummaryCopy', () => {
  it('falls back when Wisp has not written a summary yet', () => {
    expect(threadSummaryCopy('  ')).toMatch(/Nothing to report yet/);
    expect(threadSummaryCopy('3 open concerns')).toBe('3 open concerns');
  });
});
