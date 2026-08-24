import { SUPPORTED_AGENT_MODES, type AiAgentMode } from '@breeze/shared';

// Re-exported, not re-declared. The web create form needs the same list (there
// is no row to read `supportedModes` off before the agent exists), and two
// copies meant the form would keep refusing 'act' on the day the API started
// accepting it.
export { SUPPORTED_AGENT_MODES };

export function isSupportedAgentMode(mode: string): mode is AiAgentMode {
  return (SUPPORTED_AGENT_MODES as readonly string[]).includes(mode);
}
