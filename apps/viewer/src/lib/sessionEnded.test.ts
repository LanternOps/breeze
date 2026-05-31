import { describe, expect, it } from 'vitest';

import { isSessionEndedResponse, SessionEndedError } from './webrtc';

describe('isSessionEndedResponse', () => {
  it('returns false for non-401 statuses', () => {
    expect(isSessionEndedResponse(200, 'Session ended')).toBe(false);
    expect(isSessionEndedResponse(200, null)).toBe(false);
  });

  it('treats bare 401 responses as terminal', () => {
    expect(isSessionEndedResponse(401)).toBe(true);
    expect(isSessionEndedResponse(401, null)).toBe(true);
    expect(isSessionEndedResponse(401, '')).toBe(true);
  });

  it('detects session-ended 401 response bodies', () => {
    expect(isSessionEndedResponse(401, 'Session ended')).toBe(true);
    expect(isSessionEndedResponse(401, 'Viewer token revoked')).toBe(true);
    expect(isSessionEndedResponse(401, 'no longer active')).toBe(true);
  });

  it('returns false for present but unrelated 401 response bodies', () => {
    expect(isSessionEndedResponse(401, 'Unauthorized')).toBe(false);
  });
});

describe('SessionEndedError', () => {
  it('sets the expected name and extends Error', () => {
    const error = new SessionEndedError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SessionEndedError');
  });

  it('respects a custom message', () => {
    const error = new SessionEndedError('Custom ended message');

    expect(error.message).toBe('Custom ended message');
  });
});
