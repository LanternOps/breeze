import { describe, expect, it } from 'vitest';
import { ENDPOINT_MESSAGING_MIN_AGENT_VERSION } from '@breeze/shared';
import { COMMAND_MIN_AGENT_VERSION, agentSupportsMessaging } from './commandMinVersion';

describe('agentSupportsMessaging (#8293 W1 version gate)', () => {
  it('rejects null, garbage and older versions; accepts the gate and above', () => {
    expect(agentSupportsMessaging(null)).toBe(false);
    expect(agentSupportsMessaging('not-a-version')).toBe(false);
    expect(agentSupportsMessaging('0.0.1')).toBe(false);
    expect(agentSupportsMessaging(COMMAND_MIN_AGENT_VERSION.notify_user_messaging!)).toBe(true);
  });

  it('reads the single shared gate value (one source for API and web)', () => {
    expect(COMMAND_MIN_AGENT_VERSION.notify_user_messaging).toBe(ENDPOINT_MESSAGING_MIN_AGENT_VERSION);
  });

  it('is frozen so a caller cannot lower the gate at runtime', () => {
    expect(Object.isFrozen(COMMAND_MIN_AGENT_VERSION)).toBe(true);
  });
});
