import { describe, expect, it } from 'vitest';

import {
  grantBannerCopy,
  liveLineCopy,
  pauseControlState,
  pauseFailureCopy,
  pauseResultCopy,
  replyEnabled,
  spendMeterCopy,
  spendMeterState,
  threadSummaryCopy,
} from './wispThreadCopy';

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

describe('spendMeterState', () => {
  it('classifies ok / warn / exhausted', () => {
    expect(spendMeterState(42, 200)).toEqual({ level: 'ok', ratio: 0.21 });
    expect(spendMeterState(160, 200)?.level).toBe('warn');
    expect(spendMeterState(200, 200)?.level).toBe('exhausted');
    expect(spendMeterState(250, 200)).toEqual({ level: 'exhausted', ratio: 1.25 });
  });
  it('is null for missing or unusable inputs', () => {
    expect(spendMeterState(null, 200)).toBeNull();
    expect(spendMeterState(42, null)).toBeNull();
    expect(spendMeterState(42, 0)).toBeNull();
    expect(spendMeterState(Number.NaN, 200)).toBeNull();
  });
});

describe('spendMeterCopy', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  it('shows hours until reset', () => {
    expect(spendMeterCopy(42, 200, '2026-10-19T18:00:00Z', now)).toBe('42¢ of 200¢ today · resets in 6 h');
  });
  it('rounds a sub-hour reset up to 1 h', () => {
    expect(spendMeterCopy(42, 200, '2026-10-19T12:20:00Z', now)).toBe('42¢ of 200¢ today · resets in 1 h');
  });
  it('omits the suffix for past, null, or unparseable resets', () => {
    expect(spendMeterCopy(42, 200, '2026-10-19T11:00:00Z', now)).toBe('42¢ of 200¢ today');
    expect(spendMeterCopy(42, 200, null, now)).toBe('42¢ of 200¢ today');
    expect(spendMeterCopy(42, 200, 'nope', now)).toBe('42¢ of 200¢ today');
  });
  it('is null when the state is null', () => {
    expect(spendMeterCopy(null, 200, null, now)).toBeNull();
  });
});

describe('liveLineCopy', () => {
  it('handles null, named, and unnamed activity', () => {
    expect(liveLineCopy(null)).toBeNull();
    expect(liveLineCopy({ orgId: 'o', orgName: 'Acme', startedAt: 'x' })).toBe('Wisp is checking Acme\u2026');
    expect(liveLineCopy({ orgId: null, orgName: null, startedAt: 'x' })).toBe('Wisp is checking your customers…');
    expect(liveLineCopy({ orgId: 'o', orgName: '', startedAt: 'x' })).toBe('Wisp is checking your customers…');
  });
});

describe('pauseControlState', () => {
  it('offers pause / resume only where the user can act', () => {
    expect(pauseControlState({ status: 'active', pausedReason: null })).toEqual({ action: 'pause', label: 'Pause Wisp' });
    expect(pauseControlState({ status: 'paused', pausedReason: 'user_paused' })).toEqual({ action: 'resume', label: 'Resume Wisp' });
    expect(pauseControlState({ status: 'paused', pausedReason: 'budget_exhausted' })).toBeNull();
    expect(pauseControlState({ status: 'revoked', pausedReason: null })).toBeNull();
    expect(pauseControlState({ status: 'expired', pausedReason: null })).toBeNull();
  });
});

describe('pause copy', () => {
  it('result copy', () => {
    expect(pauseResultCopy('pause')).toBe('Wisp paused.');
    expect(pauseResultCopy('resume')).toBe('Wisp resumed.');
  });
  it('failure copy', () => {
    expect(pauseFailureCopy('pause', 403)).toBe('Changing Wisp needs a recent MFA sign-in.');
    expect(pauseFailureCopy('resume', 409)).toBe('Only a pause you made can be resumed here.');
    expect(pauseFailureCopy('pause', 409)).toBe('Wisp is not active.');
    expect(pauseFailureCopy('resume', 404)).toBe('This Wisp delegation is gone.');
    expect(pauseFailureCopy('pause', 500)).toBe('Could not pause Wisp.');
    expect(pauseFailureCopy('resume', undefined)).toBe('Could not resume Wisp.');
  });
});
