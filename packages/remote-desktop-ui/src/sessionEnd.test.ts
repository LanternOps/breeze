import { describe, it, expect } from 'vitest';
import {
  errorCardFor,
  parseSessionEndingMessage,
  serverEndReasonText,
  sessionEndedCardMessage,
  sessionEndingText,
} from './sessionEnd';
import { SESSION_ENDED_DEFAULT_MESSAGE } from './webrtc';

// #10421: the agent ends a session on purpose (idle timeout, max duration,
// revoked lease) and says why on the control channel just before it closes the
// peer. The viewer must show that reason as a terminal state, not a generic
// connection error with a Retry that re-enters the dead session.

describe('parseSessionEndingMessage', () => {
  it('reads an idle-timeout notice', () => {
    expect(
      parseSessionEndingMessage({ type: 'session_ending', reason: 'idle_timeout_exceeded', idleTimeoutMinutes: 5 }),
    ).toEqual({ reason: 'idle_timeout_exceeded', idleTimeoutMinutes: 5 });
  });

  it('reads a revoked notice with its detail', () => {
    expect(
      parseSessionEndingMessage({ type: 'session_ending', reason: 'revoked', detail: 'permissions_changed' }),
    ).toEqual({ reason: 'revoked', detail: 'permissions_changed' });
  });

  it('drops numbers that are not positive and finite', () => {
    expect(
      parseSessionEndingMessage({ type: 'session_ending', reason: 'idle_timeout_exceeded', idleTimeoutMinutes: -1 }),
    ).toEqual({ reason: 'idle_timeout_exceeded' });
    expect(
      parseSessionEndingMessage({ type: 'session_ending', reason: 'max_session_duration_exceeded', maxDurationMinutes: 'x' }),
    ).toEqual({ reason: 'max_session_duration_exceeded' });
  });

  it('rejects anything that is not a session_ending message', () => {
    expect(parseSessionEndingMessage(null)).toBeNull();
    expect(parseSessionEndingMessage('session_ending')).toBeNull();
    expect(parseSessionEndingMessage({ type: 'monitors' })).toBeNull();
    expect(parseSessionEndingMessage({ type: 'session_ending' })).toBeNull();
    expect(parseSessionEndingMessage({ type: 'session_ending', reason: 42 })).toBeNull();
  });
});

describe('sessionEndingText', () => {
  it('names the idle timeout and its length', () => {
    expect(sessionEndingText({ reason: 'idle_timeout_exceeded', idleTimeoutMinutes: 5 })).toBe(
      'The session ended after 5 minutes of inactivity.',
    );
    expect(sessionEndingText({ reason: 'idle_timeout_exceeded', idleTimeoutMinutes: 1 })).toBe(
      'The session ended after 1 minute of inactivity.',
    );
    expect(sessionEndingText({ reason: 'idle_timeout_exceeded' })).toBe(
      'The session ended after a period of inactivity.',
    );
  });

  it('names the maximum session length', () => {
    expect(sessionEndingText({ reason: 'max_session_duration_exceeded', maxDurationMinutes: 120 })).toBe(
      'The session reached its maximum length of 2 hours.',
    );
    expect(sessionEndingText({ reason: 'max_session_duration_exceeded', maxDurationMinutes: 60 })).toBe(
      'The session reached its maximum length of 1 hour.',
    );
    expect(sessionEndingText({ reason: 'max_session_duration_exceeded', maxDurationMinutes: 90 })).toBe(
      'The session reached its maximum length of 90 minutes.',
    );
    expect(sessionEndingText({ reason: 'max_session_duration_exceeded' })).toBe(
      'The session reached its maximum length.',
    );
  });

  it('explains a revocation by its server reason', () => {
    expect(sessionEndingText({ reason: 'revoked', detail: 'session_ended' })).toBe(
      'The session was ended from the Breeze dashboard.',
    );
    expect(sessionEndingText({ reason: 'revoked', detail: 'permissions_changed' })).toBe(
      'Your remote access permissions changed, so the session was ended.',
    );
    expect(sessionEndingText({ reason: 'revoked', detail: 'something_new' })).toBe(
      'Your access to this session was revoked.',
    );
    expect(sessionEndingText({ reason: 'revoked' })).toBe('Your access to this session was revoked.');
  });

  it('explains a lost lease as lost contact with the server', () => {
    const lost = 'The device lost contact with the Breeze server, so the session ended.';
    expect(sessionEndingText({ reason: 'lease_expired' })).toBe(lost);
    expect(sessionEndingText({ reason: 'lease_unavailable_at_start' })).toBe(lost);
  });

  it('falls back to the generic ended text for an unknown reason', () => {
    expect(sessionEndingText({ reason: 'from_the_future' })).toBe(SESSION_ENDED_DEFAULT_MESSAGE);
  });
});

describe('serverEndReasonText', () => {
  it('humanizes the API revocation code stored on the session row', () => {
    expect(serverEndReasonText('revoked:session_ended')).toBe('The session was ended from the Breeze dashboard.');
    expect(serverEndReasonText('revoked:hard_deadline')).toBe('The session reached its maximum length.');
  });

  it('passes free-text reasons through unchanged', () => {
    expect(serverEndReasonText('Session timed out: exceeded maximum session duration')).toBe(
      'Session timed out: exceeded maximum session duration',
    );
  });
});

describe('sessionEndedCardMessage', () => {
  it('appends the relaunch hint', () => {
    expect(sessionEndedCardMessage('The session ended after 5 minutes of inactivity.')).toBe(
      'The session ended after 5 minutes of inactivity. Relaunch it from the Breeze dashboard.',
    );
  });
});

describe('errorCardFor', () => {
  it('offers no Retry for an ended session: the viewer token cannot reconnect it', () => {
    expect(errorCardFor('session_ended')).toEqual({ title: 'Session ended', showRetry: false });
  });

  it('keeps Retry for a transient connection error', () => {
    expect(errorCardFor('error')).toEqual({ title: 'Connection Error', showRetry: true });
  });
});
