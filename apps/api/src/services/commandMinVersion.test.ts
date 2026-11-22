import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_CHAT_MIN_AGENT_VERSION,
  ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION,
  ENDPOINT_MESSAGING_MIN_AGENT_VERSION,
} from '@breeze/shared';
import {
  COMMAND_MIN_AGENT_VERSION, GUARDED_DISCOVERY_MIN_AGENT_VERSION, agentSupportsChat, agentSupportsGuardedCommand,
  agentSupportsMessaging, agentSupportsRetract,
} from './commandMinVersion';

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

  it('gates retract_message on its own shared value, failing closed (#8742)', () => {
    expect(COMMAND_MIN_AGENT_VERSION.retract_message).toBe(ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION);
    expect(agentSupportsRetract(null)).toBe(false);
    expect(agentSupportsRetract('0.0.1')).toBe(false);
    expect(agentSupportsRetract(ENDPOINT_MESSAGE_RETRACT_MIN_AGENT_VERSION)).toBe(true);
  });

  it('gates endpoint chat on its own shared value, failing closed (#8743)', () => {
    expect(COMMAND_MIN_AGENT_VERSION.chat).toBe(ENDPOINT_CHAT_MIN_AGENT_VERSION);
    expect(agentSupportsChat(null)).toBe(false);
    expect(agentSupportsChat('not-a-version')).toBe(false);
    expect(agentSupportsChat('0.123.0')).toBe(false);
    expect(agentSupportsChat(ENDPOINT_CHAT_MIN_AGENT_VERSION)).toBe(true);
  });

  it('gates the guarded discovery scan at the 999.0.0 placeholder (W03c sets the release)', () => {
    expect(GUARDED_DISCOVERY_MIN_AGENT_VERSION).toBe('999.0.0');
    expect(COMMAND_MIN_AGENT_VERSION.network_discovery_guarded).toBe(GUARDED_DISCOVERY_MIN_AGENT_VERSION);
    expect(COMMAND_MIN_AGENT_VERSION.network_discovery).toBeUndefined();
  });

  it('agentSupportsGuardedCommand treats unknown, unparseable and older versions as not supported', () => {
    for (const v of [null, undefined, '', '  ', 'dev', '1.2', '1.2.3.4', 'v999.0.0', '0.128.0', '998.99.99'])
      expect(agentSupportsGuardedCommand('network_discovery', v)).toBe(false);
    for (const v of ['999.0.0', ' 999.0.0 ', '999.0.0-rc.1', '1000.0.0'])
      expect(agentSupportsGuardedCommand('network_discovery', v)).toBe(true);
  });

  it('is frozen so a caller cannot lower the gate at runtime', () => {
    expect(Object.isFrozen(COMMAND_MIN_AGENT_VERSION)).toBe(true);
  });
});
