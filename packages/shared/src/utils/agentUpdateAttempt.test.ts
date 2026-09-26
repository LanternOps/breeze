import { describe, it, expect } from 'vitest';
import {
  AGENT_UPDATE_EPISODE_GAP_MS,
  AGENT_UPDATE_STUCK_AFTER_MS,
  isAgentUpdateStuck,
  nextAgentUpdateAttempt,
} from './agentUpdateAttempt';

const NOW = new Date('2026-10-01T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const EMPTY = { targetVersion: null, startedAt: null, lastAttemptAt: null, attemptCount: null };

describe('nextAgentUpdateAttempt', () => {
  it('starts a new episode on the first attempt', () => {
    expect(nextAgentUpdateAttempt(EMPTY, '0.110.0', NOW)).toEqual({
      targetVersion: '0.110.0',
      startedAt: NOW,
      lastAttemptAt: NOW,
      attemptCount: 1,
    });
  });

  it('continues the episode on a retry of the same target, keeping the start time', () => {
    const prev = { targetVersion: '0.110.0', startedAt: minutesAgo(90), lastAttemptAt: minutesAgo(1), attemptCount: 89 };
    expect(nextAgentUpdateAttempt(prev, '0.110.0', NOW)).toEqual({
      targetVersion: '0.110.0',
      startedAt: minutesAgo(90),
      lastAttemptAt: NOW,
      attemptCount: 90,
    });
  });

  it('accepts ISO-string timestamps from a serialized row', () => {
    const prev = {
      targetVersion: '0.110.0',
      startedAt: minutesAgo(90).toISOString(),
      lastAttemptAt: minutesAgo(1).toISOString(),
      attemptCount: 3,
    };
    const next = nextAgentUpdateAttempt(prev, '0.110.0', NOW);
    expect(next.startedAt).toEqual(minutesAgo(90));
    expect(next.attemptCount).toBe(4);
  });

  it('restarts the episode when the target version changes', () => {
    const prev = { targetVersion: '0.109.0', startedAt: minutesAgo(90), lastAttemptAt: minutesAgo(1), attemptCount: 89 };
    expect(nextAgentUpdateAttempt(prev, '0.110.0', NOW)).toEqual({
      targetVersion: '0.110.0',
      startedAt: NOW,
      lastAttemptAt: NOW,
      attemptCount: 1,
    });
  });

  it('restarts the episode when the previous attempt is older than the episode gap', () => {
    const lastAttemptAt = new Date(NOW.getTime() - AGENT_UPDATE_EPISODE_GAP_MS - 1);
    const prev = { targetVersion: '0.110.0', startedAt: minutesAgo(600), lastAttemptAt, attemptCount: 5 };
    const next = nextAgentUpdateAttempt(prev, '0.110.0', NOW);
    expect(next.startedAt).toEqual(NOW);
    expect(next.attemptCount).toBe(1);
  });

  it('treats a null/zero attempt count on a continuing episode as one prior attempt', () => {
    const prev = { targetVersion: '0.110.0', startedAt: minutesAgo(5), lastAttemptAt: minutesAgo(1), attemptCount: null };
    expect(nextAgentUpdateAttempt(prev, '0.110.0', NOW).attemptCount).toBe(2);
  });
});

describe('isAgentUpdateStuck', () => {
  const stuckAfterMinutes = AGENT_UPDATE_STUCK_AFTER_MS / 60_000;

  it('is false when no update is being attempted', () => {
    expect(isAgentUpdateStuck(EMPTY, NOW)).toBe(false);
  });

  it('is false for an update that started recently', () => {
    expect(
      isAgentUpdateStuck(
        { targetVersion: '0.110.0', startedAt: minutesAgo(stuckAfterMinutes - 1), lastAttemptAt: minutesAgo(0) },
        NOW,
      ),
    ).toBe(false);
  });

  it('is true once an episode has been retrying past the threshold without converging', () => {
    expect(
      isAgentUpdateStuck(
        { targetVersion: '0.110.0', startedAt: minutesAgo(stuckAfterMinutes + 1), lastAttemptAt: minutesAgo(1) },
        NOW,
      ),
    ).toBe(true);
  });

  it('accepts ISO strings (the shape the web client receives)', () => {
    expect(
      isAgentUpdateStuck(
        {
          targetVersion: '0.110.0',
          startedAt: minutesAgo(stuckAfterMinutes + 1).toISOString(),
          lastAttemptAt: minutesAgo(1).toISOString(),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('is false once attempts have stopped for longer than the episode gap (offer withdrawn / abandoned)', () => {
    expect(
      isAgentUpdateStuck(
        {
          targetVersion: '0.110.0',
          startedAt: minutesAgo(600),
          lastAttemptAt: new Date(NOW.getTime() - AGENT_UPDATE_EPISODE_GAP_MS - 1),
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('is inclusive at both exact thresholds', () => {
    expect(
      isAgentUpdateStuck(
        {
          targetVersion: '0.110.0',
          startedAt: new Date(NOW.getTime() - AGENT_UPDATE_STUCK_AFTER_MS),
          lastAttemptAt: new Date(NOW.getTime() - AGENT_UPDATE_EPISODE_GAP_MS),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('is false for unparseable timestamps (fails quiet, never a false alarm)', () => {
    expect(
      isAgentUpdateStuck({ targetVersion: '0.110.0', startedAt: 'garbage', lastAttemptAt: 'garbage' }, NOW),
    ).toBe(false);
  });
});
