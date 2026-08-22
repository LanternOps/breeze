import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifyTruncation,
  currentTruncationEpoch,
  resetTruncationTracking,
  shouldReportTruncation,
  trackTruncation,
} from './truncationReporting';

/** Most cases track a result from the CURRENT session. */
const now = () => currentTruncationEpoch();

describe('classifyTruncation', () => {
  it('is complete when everything the server counted came back', () => {
    expect(classifyTruncation(42, 42)).toBe('complete');
  });

  it('is partial when the server counted more than it returned', () => {
    expect(classifyTruncation(216, 100)).toBe('partial');
  });

  it('is unknown-total when the server reported no count', () => {
    // Not "complete": a caller cannot distinguish N items from the first N of
    // more, which is the whole point of #3753.
    expect(classifyTruncation(null, 100)).toBe('unknown-total');
    expect(classifyTruncation(null, 0)).toBe('unknown-total');
  });

  it('does not call an over-long page partial', () => {
    // Defensive: a server returning more than it counted is odd, but it is not
    // the "showing a sample as the whole set" failure this reports.
    expect(classifyTruncation(10, 12)).toBe('complete');
  });
});

describe('shouldReportTruncation', () => {
  it('reports the first time a list is partial', () => {
    expect(shouldReportTruncation(undefined, 'partial')).toBe(true);
  });

  it('stays quiet while it remains partial', () => {
    // The bug: a 216-device tenant is permanently partial, so every mount, tab
    // focus, pull-to-refresh, push and WS update re-reported the same fact.
    expect(shouldReportTruncation('partial', 'partial')).toBe(false);
  });

  it('never reports completeness', () => {
    expect(shouldReportTruncation('partial', 'complete')).toBe(false);
    expect(shouldReportTruncation(undefined, 'complete')).toBe(false);
  });

  it('reports again after recovering and re-truncating', () => {
    expect(shouldReportTruncation('complete', 'partial')).toBe(true);
  });

  it('treats unknown-total as its own state, so the transition is visible', () => {
    expect(shouldReportTruncation('partial', 'unknown-total')).toBe(true);
    expect(shouldReportTruncation('unknown-total', 'partial')).toBe(true);
  });

  it('reports EVERY unknown-total, unlike partial', () => {
    // Asymmetric on purpose. A repeated `partial` says nothing new; a repeated
    // "the server sent no count" does — whether it is ongoing, how many
    // tenants/servers it spans, whether it came back after an account change —
    // and it survives the first event being sampled or dropped.
    expect(shouldReportTruncation('unknown-total', 'unknown-total')).toBe(true);
  });
});

describe('trackTruncation', () => {
  beforeEach(() => resetTruncationTracking());

  it('reports once, then goes quiet for the steady state', () => {
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
    expect(trackTruncation('device-list', 216, 100, now())).toBeNull();
    expect(trackTruncation('device-list', 216, 100, now())).toBeNull();
  });

  it('keeps lists independent', () => {
    // A partial device list must not silence a newly partial alert inbox.
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
    expect(trackTruncation('alert-inbox', 500, 100, now())).toBe('partial');
    expect(trackTruncation('device-list', 216, 100, now())).toBeNull();
  });

  it('re-reports when the state changes back and forth', () => {
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
    expect(trackTruncation('device-list', 90, 90, now())).toBeNull(); // complete
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
  });

  it('keeps surfacing a server that reports no count', () => {
    expect(trackTruncation('alert-inbox', 500, 100, now())).toBe('partial');
    expect(trackTruncation('alert-inbox', null, 100, now())).toBe('unknown-total');
    // Still reported: an ongoing missing count is a live defect, not noise.
    expect(trackTruncation('alert-inbox', null, 100, now())).toBe('unknown-total');
  });

  it('does not let one org silence another, or a small org re-arm the fleet', () => {
    // orgId is sent to the server, so these are different result sets. Sharing
    // one key broke both ways: the fleet swallowed an org's first report, and a
    // complete org reset the key so the unchanged fleet reported again on every
    // return to Systems.
    expect(trackTruncation('device-list:all', 216, 100, now())).toBe('partial');
    expect(trackTruncation('device-list:org-a', 400, 100, now())).toBe('partial');
    expect(trackTruncation('device-list:org-small', 12, 12, now())).toBeNull();
    expect(trackTruncation('device-list:all', 216, 100, now())).toBeNull();
  });

  it('reset clears the state so a new session reports again', () => {
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
    resetTruncationTracking();
    expect(trackTruncation('device-list', 216, 100, now())).toBe('partial');
  });

  it('ignores a result from a session that has already been torn down', () => {
    // Clearing on sign-out is not enough on its own: a request issued by the
    // OLD session can resolve AFTER the reset and write its state back, which
    // then suppresses the first report of the next user — possibly on a
    // different server. The epoch captured at request time closes that window.
    const oldSession = now();
    expect(trackTruncation('device-list:all', 216, 100, oldSession)).toBe('partial');

    resetTruncationTracking(); // sign-out

    // Old in-flight request lands now. It must neither report nor record.
    expect(trackTruncation('device-list:all', 216, 100, oldSession)).toBeNull();

    // The next session's first fetch is therefore still the first report.
    expect(trackTruncation('device-list:all', 216, 100, now())).toBe('partial');
  });

  it('retains only currently-partial keys, so browsing many orgs cannot grow forever', () => {
    // complete needs no suppression, and unknown-total reports every time, so
    // storing either would just accumulate a UUID per org for the life of the
    // runtime. Proven by behaviour: a completed org forgets its key, so the
    // next partial on that key reports as a first sighting.
    expect(trackTruncation('device-list:org-a', 400, 100, now())).toBe('partial');
    expect(trackTruncation('device-list:org-a', 50, 50, now())).toBeNull(); // complete -> forgotten
    expect(trackTruncation('device-list:org-a', 400, 100, now())).toBe('partial');
  });
});
