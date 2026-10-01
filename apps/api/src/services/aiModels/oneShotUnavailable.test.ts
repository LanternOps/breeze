import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const alertMock = vi.hoisted(() => vi.fn());
vi.mock('../llm/platformKeyAlert', () => ({
  reportPlatformKeyMissing: alertMock,
  PLATFORM_KEY_MISSING_MESSAGE: 'AI is not configured on this deployment.',
}));

import { oneShotUnavailableAnswer } from './oneShotUnavailable';
import type { ModelUnavailable } from './resolveModel';

const unavailable = (reason: ModelUnavailable['reason']): ModelUnavailable => ({
  ok: false, reason, recoverable: true, offeringId: null, message: `msg:${reason}`,
});

describe('oneShotUnavailableAnswer', () => {
  const saved = { ...process.env };
  beforeEach(() => { alertMock.mockReset(); });
  afterEach(() => { process.env = { ...saved }; });

  it('a keyless deployment answers ai_unavailable 503 and raises the platform-key alert', () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const out = oneShotUnavailableAnswer(unavailable('connection_unavailable'));
    expect(out).toEqual({ status: 503, body: { error: 'ai_unavailable' } });
    expect(alertMock).toHaveBeenCalledTimes(1);
  });

  it('with a platform key, connection_unavailable is the recoverable 409 and raises no alert', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const out = oneShotUnavailableAnswer(unavailable('connection_unavailable'));
    expect(out).toEqual({ status: 409, body: { error: 'msg:connection_unavailable', code: 'connection_unavailable', recoverable: true } });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('registry_unavailable is a transient 503 with its code', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect(oneShotUnavailableAnswer(unavailable('registry_unavailable')).status).toBe(503);
  });

  it('other reasons are 409 with the code', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const out = oneShotUnavailableAnswer(unavailable('model_unavailable'));
    expect(out.status).toBe(409);
    expect(alertMock).not.toHaveBeenCalled();
  });
});
