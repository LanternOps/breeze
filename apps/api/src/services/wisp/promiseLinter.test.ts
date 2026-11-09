/**
 * #10427 (W08 Task 2) — the post-turn promise linter. A first-person
 * commitment in the reply ("I'll check back", "I've queued the scan", "I'll
 * update that concern") needs matching evidence from this turn's tool results;
 * an offer ("I can check back if you'd like") is not a promise.
 */
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_UP_CORRECTION,
  DISPATCH_CORRECTION,
  CONCERN_CORRECTION,
  lintTurnPromises,
  type TurnEvidence,
} from './promiseLinter';

const none: TurnEvidence = {
  checkInScheduled: false,
  watchCreated: false,
  specialistLaunched: false,
  dispatched: [],
  pendingApprovals: 0,
  assessmentQueued: false,
  concernChanged: false,
  toolCalls: 0,
  dispatchAttempted: false,
};
const ev = (over: Partial<TurnEvidence>): TurnEvidence => ({ ...none, ...over });

describe('lintTurnPromises', () => {
  it('pins the exact correction strings', () => {
    expect(FOLLOW_UP_CORRECTION).toBe('Correction: no follow-up is scheduled. Ask me to schedule a check-in, or set a watch.');
    expect(DISPATCH_CORRECTION).toBe('Correction: nothing was confirmed as dispatched this turn.');
    expect(CONCERN_CORRECTION).toBe('Correction: that concern was not changed this turn.');
  });

  describe('Review Focus 5: an offer is not a promise', () => {
    it('"I can check back in 10 minutes if you\'d like" draws no correction', () => {
      expect(lintTurnPromises("I can check back in 10 minutes if you'd like.", none).corrections).toEqual([]);
    });

    it('"You could schedule a scan" draws no correction', () => {
      expect(lintTurnPromises('You could schedule a scan.', none).corrections).toEqual([]);
    });

    it('"I\'ll check back in 10 minutes" with no evidence draws the follow-up correction', () => {
      expect(lintTurnPromises("I'll check back in 10 minutes.", none).corrections).toEqual([FOLLOW_UP_CORRECTION]);
    });

    it('"I\'ll check back" with a scheduled check-in draws none', () => {
      expect(lintTurnPromises("I'll check back in 10 minutes.", ev({ checkInScheduled: true })).corrections).toEqual([]);
    });

    it('a conditional "I\'ll check back if you want" is an offer', () => {
      expect(lintTurnPromises("I'll check back in 10 minutes if you want.", none).corrections).toEqual([]);
    });
  });

  describe('follow-up class', () => {
    it.each([
      "I will follow up once the scan finishes.",
      "I'll let you know when it's done.",
      "I'll remind you tomorrow morning.",
      "I'll go ahead and check back after lunch.",
      "Ask me to check back in about 5–10 minutes. I'll follow up then.",
    ])('flags %j without evidence', (text) => {
      expect(lintTurnPromises(text, none).corrections).toEqual([FOLLOW_UP_CORRECTION]);
    });

    it('a watch created this turn backs it', () => {
      expect(lintTurnPromises("I'll let you know if it goes offline again.", ev({ watchCreated: true })).corrections).toEqual([]);
    });

    it('a specialist launched this turn backs it (its report posts back to the thread)', () => {
      expect(lintTurnPromises("I'll let you know what it finds.", ev({ specialistLaunched: true })).corrections).toEqual([]);
    });

    it('a negated commitment is not a promise', () => {
      expect(lintTurnPromises("I won't check back on this; I will not follow up automatically.", none).corrections).toEqual([]);
    });

    it('a curly apostrophe still counts', () => {
      expect(lintTurnPromises('I’ll check back in an hour.', none).corrections).toEqual([FOLLOW_UP_CORRECTION]);
    });
  });

  describe('dispatched class', () => {
    it('"The scan has been queued" with a pending approval draws none', () => {
      expect(lintTurnPromises('The scan has been queued.', ev({ dispatched: [], pendingApprovals: 1 })).corrections).toEqual([]);
    });

    it('"The scan has been queued" with nothing draws the dispatch correction', () => {
      expect(lintTurnPromises('The scan has been queued.', none).corrections).toEqual([DISPATCH_CORRECTION]);
    });

    it.each([
      "I've queued a patch scan on PC-01.",
      'I have sent the restart command.',
      "I've rebooted the server.",
      'The service has been restarted.',
      'The updates have been installed.',
      "I've dispatched the script to all three devices.",
    ])('flags %j without evidence', (text) => {
      expect(lintTurnPromises(text, none).corrections).toEqual([DISPATCH_CORRECTION]);
    });

    it('a dispatched tool backs it', () => {
      expect(lintTurnPromises("I've queued a patch scan on PC-01.", ev({ dispatched: ['manage_patches'] })).corrections).toEqual([]);
    });

    it('a queued assessment backs it', () => {
      expect(lintTurnPromises('An assessment has been queued.', ev({ assessmentQueued: true })).corrections).toEqual([]);
    });

    it('a passive status read back from a list call is not a claim of dispatch', () => {
      const listed = ev({ toolCalls: 1 });
      expect(lintTurnPromises('KB5034441 has been installed on 12 devices; 3 have been rebooted.', listed).corrections).toEqual([]);
      expect(lintTurnPromises('The service has been restarted.', listed).corrections).toEqual([]);
    });

    it('a passive claim after a dispatch that came back unverified is corrected', () => {
      expect(lintTurnPromises('The scan has been queued.', ev({ toolCalls: 1, dispatchAttempted: true })).corrections).toEqual([DISPATCH_CORRECTION]);
    });

    it('a first-person claim is corrected even when other tools ran', () => {
      expect(lintTurnPromises("I've queued a patch scan on PC-01.", ev({ toolCalls: 2 })).corrections).toEqual([DISPATCH_CORRECTION]);
    });

    it('a step that still needs approval is a proposal, not a claim', () => {
      expect(lintTurnPromises("I'll need to restart the service, which requires your approval.", none).corrections).toEqual([]);
      expect(lintTurnPromises("I'll restart it, but that needs approval first.", none).corrections).toEqual([]);
    });

    it('a historical fact about the device is not a claim of dispatch', () => {
      expect(lintTurnPromises('PC-01 has been restarted 3 times since Monday.', none).corrections).toEqual([]);
      expect(lintTurnPromises('The KB5034441 update has been installed since last week.', none).corrections).toEqual([]);
    });

    it('"I\'ve scheduled a check-in" is backed by the scheduled check-in', () => {
      expect(lintTurnPromises("I've scheduled a check-in for 3pm.", ev({ checkInScheduled: true, dispatched: ['schedule_check_in'] })).corrections).toEqual([]);
    });
  });

  describe('concern class', () => {
    it('"I\'ll update that concern" without a change draws the concern correction', () => {
      expect(lintTurnPromises("I'll update that concern.", none).corrections).toEqual([CONCERN_CORRECTION]);
    });

    it.each([
      "I've resolved the concern.",
      "I'll close that concern now.",
      'I will update or close that concern.',
    ])('flags %j without a change', (text) => {
      expect(lintTurnPromises(text, none).corrections).toEqual([CONCERN_CORRECTION]);
    });

    it('a changed concern backs it', () => {
      expect(lintTurnPromises("I've resolved the concern.", ev({ concernChanged: true })).corrections).toEqual([]);
    });
  });

  it('ignores quoted (>) lines', () => {
    const text = "> I'll check back in 10 minutes and I've queued the scan.\nThat was the earlier reply; nothing is scheduled.";
    expect(lintTurnPromises(text, none).corrections).toEqual([]);
  });

  it('ignores fenced code', () => {
    const text = "Here is the script:\n```\necho \"I'll check back\"\n```\nRun it when ready.";
    expect(lintTurnPromises(text, none).corrections).toEqual([]);
  });

  it('reports each class once, in a fixed order', () => {
    const text = "I've queued the scan. I'll check back in 10 minutes. I'll also check back tomorrow. I'll resolve that concern.";
    expect(lintTurnPromises(text, none).corrections).toEqual([FOLLOW_UP_CORRECTION, DISPATCH_CORRECTION, CONCERN_CORRECTION]);
  });

  it('returns the classes alongside the corrections, for the metric', () => {
    expect(lintTurnPromises("I'll check back soon.", none).classes).toEqual(['follow_up']);
  });

  it('plain prose with no commitments draws nothing', () => {
    expect(lintTurnPromises('PC-01 is online. Disk C: is at 91% and 4 updates are pending.', none).corrections).toEqual([]);
    expect(lintTurnPromises('', none).corrections).toEqual([]);
  });
});
