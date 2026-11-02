import { describe, expect, it } from 'vitest';
import { agentSupportsNetworkIsolation } from '@breeze/shared';
import { COMMAND_MIN_AGENT_VERSION } from './commandMinVersion';
import { CommandTypes } from './commandTypes';
import { defaultOfflinePolicy, EXPLICITLY_CLASSIFIED_COMMAND_TYPES } from './commandOfflinePolicy';
import { LIFECYCLE_COMMAND_TYPES, GATED_COMMAND_TYPES } from './partnerTrust';
describe('release command survives start version and trust gates', () => {
  it('registers queued release without a minimum version, including an older unsupported agent', () => {
    expect(agentSupportsNetworkIsolation('0.0.1', 0)).toBe(false);
    expect(CommandTypes).toHaveProperty('RELEASE_CONTAINMENT', 'release_containment');
    expect(COMMAND_MIN_AGENT_VERSION.release_containment).toBeUndefined();
    expect(defaultOfflinePolicy('release_containment').kind).toBe('queue');
    expect(EXPLICITLY_CLASSIFIED_COMMAND_TYPES.has('release_containment')).toBe(true);
    expect(LIFECYCLE_COMMAND_TYPES).toContain('release_containment');
    expect(GATED_COMMAND_TYPES).toContain('execute_containment');
  });
});
